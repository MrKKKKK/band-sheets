/**
 * Spike 6 T5: B-1 evaluation on the synthetic bass variants (docs/audio-spike6-plan.md T5, docs/audio-spike6-t5.md).
 *
 * Run from spikes/analysis (devcontainer):
 *   npx tsx ts/bass/segment_eval.ts [--split tuning|dev] [--only GLOB] [--config '<json overrides>']
 *        [--segments truth,v1a] [--dev-look "<reason>"] [--json out/bass-eval/summary.json] [--slash]
 * --slash (T6, docs/audio-spike6-t6.md): B-2 marks (slash.ts) swept over minConfidence, also with a second-candidate-
 * is-root guard (compared, not adopted) and without the rules (raw); slash P / R / F, wrong-/X rate, diagnostics.
 * (--methods 1,2,3,4 was the T5 comparison; only 2 remains, docs/audio-spike6-t5.md.)
 * Per variant: the low CQT once, then B-1 on (a) the truth chord segments + truth beats (ceiling) and
 * (b) v1a's own segments + beats (ts/dsp analyze, cached in out/bass-eval/v1a/). The segment bass becomes the result
 * chord's bass (null when it equals the root) and is scored with score.ts scoreBass against the truth chords.
 * Reported per split x level: segBass.rate (point-weighted), confusion of the pitch-class interval (result - truth) on
 * the truth segments, octave hits vs the played MIDI, and speed (ms per audio minute, B-1 only / low CQT included).
 * HELD-OUT: selectVariants + heldOutRefusal per file (refused before any wav is opened). The dev split needs
 * --dev-look and appends one line to out/results/heldout-log.jsonl. Output: aggregates only.
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../browser/wav';
import { analyze } from '../dsp/analyze';
import { configHash as dspConfigHash } from '../dsp/config';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { bassConfigHash, DEFAULT_BASS_CONFIG, resolveBassConfig, type BassConfig } from './config';
import { devLookCount, devLookLine, heldOutRefusal, selectVariants, type GuardSources, type GuardVariant } from './heldout_guard';
import { LOW_SR, lowCqt } from './lowCqt';
import { normalizeTruthSlash, scoreBass, noteToPc, type ScoreBeat, type ScoreChord } from './score';
import { segmentBass, type SegmentBass } from './segmentBass';
import { beatsIn, bassKind, slashMarks, type SlashMark } from './slash';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'out', 'bass');
const CACHE = join(ROOT, 'out', 'bass-eval', 'v1a');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

interface Variant extends GuardVariant {
  level: string;
  style: string;
  wav: string;
  truth: string;
  audioSec: number;
}
interface Truth {
  beats: ScoreBeat[];
  chords: ScoreChord[];
  bass: { segments: { start: number; end: number; played: number }[]; variant: { heldOut: boolean; split: string; timbre: string; name: string } };
}
interface V1a {
  dspHash: string;
  beats: { t: number }[];
  chords: ScoreChord[];
}

const readJson = <T>(p: string, pick: (j: any) => T): T | null => {
  try {
    return pick(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
};
const argOf = (argv: string[], k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Chords with the B-1 bass written as `/X` when it differs from the root. */
export function withBass(chords: readonly ScoreChord[], bass: readonly SegmentBass[]): ScoreChord[] {
  return chords.map((c, i) => ({ ...c, bass: bass[i].pc === noteToPc(c.root) ? null : SHARP[bass[i].pc] }));
}

/** T6: chords with the B-2 marks as `/X` (slash.ts). */
export function withSlashMarks(chords: readonly ScoreChord[], marks: readonly (SlashMark | null)[]): ScoreChord[] {
  return chords.map((c, i) => ({ ...c, bass: marks[i] ? SHARP[marks[i]!.bass] : null }));
}
export const slashIn = (chords: readonly ScoreChord[], beats: readonly number[]) =>
  chords.map((c) => ({ root: noteToPc(c.root), quality: c.quality, beats: beatsIn(c.start, c.end, beats) }));
/** T6 sweep: minConfidence values x second-root guard on/off. */
const SWEEP = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
interface SlashAcc {
  truthSlash: number;
  resultSlash: number;
  hit: number;
  noSlash: number;
  falseSlash: number;
}
const slashAcc = (): SlashAcc => ({ truthSlash: 0, resultSlash: 0, hit: 0, noSlash: 0, falseSlash: 0 });

interface Acc {
  scored: number;
  hit: number;
  conf: Record<number, number>;
  octHit: number;
  octN: number;
}
const acc = (): Acc => ({ scored: 0, hit: 0, conf: {}, octHit: 0, octN: 0 });

function main(argv: string[]): void {
  const splits = (argOf(argv, '--split') ?? 'tuning').split(',');
  const methods = (argOf(argv, '--methods') ?? String(DEFAULT_BASS_CONFIG.segment.method)).split(',').map(Number) as BassConfig['segment']['method'][];
  const segKinds = (argOf(argv, '--segments') ?? 'truth,v1a').split(',');
  const base = JSON.parse(argOf(argv, '--config') ?? '{}') as Record<string, any>;
  const src: GuardSources = {
    syn: readJson(join(OUT, 'manifest.json'), (j) => j.variants as GuardVariant[]),
    rec: null,
    ids: null,
  };
  if (!src.syn) throw new Error('out/bass/manifest.json unreadable: refusing (run render/bass/cli.ts first)');
  const vs = selectVariants(src.syn as Variant[], splits, argOf(argv, '--only'));
  const cfgs = methods.map((m) => resolveBassConfig({ ...base, segment: { ...(base.segment ?? {}), method: m } }));
  if (splits.includes('dev')) {
    const reason = argOf(argv, '--dev-look');
    if (!reason) throw new Error('the dev split is a logged look: pass --dev-look "<reason>"');
    // in a worktree inside the devcontainer git cannot resolve .git: pass BAND_SHEETS_COMMIT (or GIT_DIR / GIT_WORK_TREE)
    const commit = process.env.BAND_SHEETS_COMMIT ?? execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const logText = existsSync(LOG) ? readFileSync(LOG, 'utf8') : null;
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, devLookLine({ task: 'T5', reason, configHash: cfgs.map((c) => bassConfigHash(c)).join(','), commit, files: vs.length, at: new Date().toISOString() }) + '\n');
    console.log(`dev look #${devLookCount(logText) + 1} logged`);
  }
  mkdirSync(CACHE, { recursive: true });
  const dspHash = dspConfigHash();
  const res = new Map<string, Acc>();
  const doSlash = argv.includes('--slash');
  const sres = new Map<string, SlashAcc>();
  const sget = (k: string) => sres.get(k) ?? (sres.set(k, slashAcc()), sres.get(k)!);
  const diag = new Map<string, number>();
  const dinc = (k: string) => diag.set(k, (diag.get(k) ?? 0) + 1);
  const get = (k: string) => res.get(k) ?? (res.set(k, acc()), res.get(k)!);
  let audioSec = 0;
  let cqtMs = 0;
  const b1Ms = methods.map(() => 0);
  for (const v of vs) {
    const refusal = heldOutRefusal(v.wav, src);
    if (refusal) throw new Error(`${v.name}: ${refusal}`);
    const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as Truth;
    const tv = truth.bass.variant;
    if (tv.heldOut || tv.split === 'heldOut' || tv.timbre === 'C') throw new Error(`${v.name}: truth says held-out, refusing`);
    const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
    const y = resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR);
    audioSec += y.length / LOW_SR;
    let v1a: V1a | null = null;
    if (segKinds.includes('v1a')) {
      const cp = join(CACHE, `${v.name}.json`);
      v1a = readJson(cp, (j) => j as V1a);
      if (!v1a || v1a.dspHash !== dspHash) {
        const r = analyze(y, { timings: false }).result;
        v1a = { dspHash, beats: r.beats.map((b) => ({ t: b.t })), chords: r.chords.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: null })) };
        writeFileSync(cp, JSON.stringify(v1a));
      }
    }
    // one low CQT per distinct lowCqt params (all methods share it unless --config changes it)
    let t0 = performance.now();
    const low = lowCqt(y, cfgs[0].lowCqt);
    cqtMs += performance.now() - t0;
    const tBeats = truth.beats.map((b) => b.t);
    const truthChords = truth.chords;
    for (const [mi, cfg] of cfgs.entries()) {
      const tag = `m${cfg.segment.method}`;
      if (segKinds.includes('truth')) {
        t0 = performance.now();
        const sb = segmentBass(low, truthChords, tBeats, cfg.segment);
        b1Ms[mi] += performance.now() - t0;
        const s = scoreBass(truthChords, withBass(truthChords, sb), truth.beats);
        for (const k of [`${tag}|truth|${v.level}`, `${tag}|truth|${v.level}|${v.style}`, `${tag}|truth|ALL`]) {
          const a = get(k);
          a.scored += s.segBass.scored;
          a.hit += s.segBass.hit;
          truthChords.forEach((c, i) => {
            const want = c.bass ? noteToPc(c.bass) : noteToPc(c.root);
            const d = (sb[i].pc - want + 12) % 12;
            a.conf[d] = (a.conf[d] ?? 0) + 1;
            const played = truth.bass.segments[i]?.played;
            if (played !== undefined && d === 0) {
              a.octN++;
              if (sb[i].midi === played) a.octHit++;
            }
          });
        }
      }
      if (v1a) {
        const sb = segmentBass(low, v1a.chords, v1a.beats.map((b) => b.t), cfg.segment);
        const s = scoreBass(truthChords, withBass(v1a.chords, sb), truth.beats);
        for (const k of [`${tag}|v1a|${v.level}`, `${tag}|v1a|ALL`]) {
          const a = get(k);
          a.scored += s.segBass.scored;
          a.hit += s.segBass.hit;
        }
        // v1a root alone (no bass stage): what the bass stage adds
        const r0 = scoreBass(truthChords, v1a.chords, truth.beats);
        for (const k of [`root|v1a|${v.level}`, `root|v1a|ALL`]) {
          if (mi > 0) break;
          const a = get(k);
          a.scored += r0.segBass.scored;
          a.hit += r0.segBass.hit;
        }
      }
      if (doSlash && mi === 0) {
        const tn = normalizeTruthSlash(truthChords); // truth X/X = no /X (T6; score.ts since T8)
        const kinds: [string, ScoreChord[], number[]][] = [];
        if (segKinds.includes('truth')) kinds.push(['truth', truthChords, tBeats]);
        if (v1a) kinds.push(['v1a', v1a.chords, v1a.beats.map((b) => b.t)]);
        for (const [kind, chords, bt] of kinds) {
          const sb = segmentBass(low, chords, bt, cfg.segment);
          const inp = slashIn(chords, bt);
          const add = (variant: string, mc: number, marks: (SlashMark | null)[]) => {
            const s = scoreBass(tn, withSlashMarks(chords, marks), truth.beats);
            for (const k of [`${kind}|${variant}|${mc}|${v.level}`, `${kind}|${variant}|${mc}|ALL`]) {
              const a = sget(k);
              a.truthSlash += s.slash.truthSlash;
              a.resultSlash += s.slash.resultSlash;
              a.hit += s.slash.hit;
              a.noSlash += s.wrongSlash.noSlashTruth;
              a.falseSlash += s.wrongSlash.falseSlash;
            }
          };
          for (const mc of SWEEP) {
            const sc = { ...cfg.slash, minConfidence: mc };
            const marks = slashMarks(inp, sb, sc);
            add('rules', mc, marks);
            // compared and not adopted: drop a mark whose second candidate is the root
            add('rules+2nd-root guard', mc, marks.map((m, i) => (m && sb[i].second.pc === inp[i].root ? null : m)));
            // no rules, no guard: every bass that differs from the root (T5's withBass) above the threshold
            add('raw', mc, sb.map((b, i) => (b.pc !== inp[i].root && b.confidence >= mc ? { bass: b.pc, kind: 'inversion' as const, confidence: b.confidence, second: b.second } : null)));
          }
          if (kind !== 'truth') {
            // v1a segments over a truth /X (truth chord at the segment midpoint): what v1a's root is
            chords.forEach((c, i) => {
              const mid = (c.start + c.end) / 2;
              const t = tn.find((x) => x.start <= mid && mid < x.end);
              if (!t?.bass) return;
              const r = inp[i].root;
              const cls = r === noteToPc(t.bass) ? 'root=truthBass' : r === noteToPc(t.root) ? 'root=truthRoot' : 'root=other';
              dinc(`v1aOverTruthX|${cls}|${v.level}`);
            });
            continue;
          }
          // diagnostics on the truth segments: second candidate = root, kinds, why a truth /X was missed (cfg.slash)
          const marks = slashMarks(inp, sb, cfg.slash);
          chords.forEach((_c, i) => {
            const t = tn[i];
            const want = t.bass ? noteToPc(t.bass) : null;
            const b = sb[i];
            const L = v.level;
            if (b.pc !== inp[i].root) {
              const cls = want === b.pc ? 'trueX' : 'falseX';
              dinc(`b1!=root|${cls}|${L}`);
              if (b.second.pc === inp[i].root) dinc(`b1!=root|${cls}|2nd=root|${L}`);
              const k = bassKind(i, inp, sb, cfg.slash);
              dinc(`kind|${cls}|${k ?? 'none'}|${L}`);
              if (!k) dinc(`kindNone|${cls}|interval ${(b.pc - inp[i].root + 12) % 12}|${L}`);
            }
            const m = marks[i];
            if (m) dinc(`mark|${want === m.bass ? 'hit' : want === null ? 'falseX' : 'wrongX'}|${m.kind}|${L}`);
            if (want !== null && !(m && m.bass === want)) {
              const why =
                b.pc !== want ? (b.pc === inp[i].root ? 'b1=root' : 'b1=other') : b.confidence < cfg.slash.minConfidence ? 'lowConf' : 'noKind';
              dinc(`miss|${why}|${L}`);
            }
            if (want !== null) dinc(`truthX|${L}`);
          });
        }
      }
    }
  }
  const audioMin = audioSec / 60;
  console.log(`splits ${splits.join(',')}; ${vs.length} files, ${audioMin.toFixed(1)} audio min; configs ${cfgs.map((c) => `m${c.segment.method}=${bassConfigHash(c)}`).join(' ')}`);
  console.log(`speed: low CQT ${(cqtMs / audioMin).toFixed(0)} ms/audio min; B-1 ${methods.map((m, i) => `m${m} ${(b1Ms[i] / audioMin).toFixed(0)}`).join(', ')} ms/audio min (Node, one thread)`);
  const levels = [...new Set(vs.map((v) => v.level))].sort();
  const rate = (k: string) => {
    const a = res.get(k);
    return a && a.scored ? (a.hit / a.scored).toFixed(3) : '  -  ';
  };
  console.log(`\nsegment bass (segBass.rate)\n${['row', ...levels, 'ALL'].join('\t')}`);
  for (const kind of segKinds) {
    for (const m of methods) console.log([`m${m} ${kind}`, ...levels.map((l) => rate(`m${m}|${kind}|${l}`)), rate(`m${m}|${kind}|ALL`)].join('\t'));
    if (kind === 'v1a') console.log(['root only v1a', ...levels.map((l) => rate(`root|v1a|${l}`)), rate(`root|v1a|ALL`)].join('\t'));
  }
  if (segKinds.includes('truth')) {
    const styles = [...new Set(vs.map((v) => v.style))];
    console.log(`\nper style, truth segments\n${['method|level', ...styles].join('\t')}`);
    for (const m of methods) for (const l of levels) console.log([`m${m} ${l}`, ...styles.map((s) => rate(`m${m}|truth|${l}|${s}`))].join('\t'));
    console.log('\nconfusion on truth segments (interval result - truth, semitones; counts of segments) and octave hit (of pc hits)');
    for (const m of methods) {
      for (const l of [...levels, 'ALL']) {
        const a = res.get(`m${m}|truth|${l}`);
        if (!a) continue;
        const n = Object.values(a.conf).reduce((x, y) => x + y, 0);
        const errs = Object.entries(a.conf)
          .filter(([d]) => d !== '0')
          .sort((x, y) => y[1] - x[1])
          .map(([d, c]) => `${d}:${c}`)
          .join(' ');
        console.log(`m${m} ${l}\tn=${n}\terr ${n - (a.conf[0] ?? 0)}\t[${errs}]\toctave ${a.octN ? (a.octHit / a.octN).toFixed(3) : '-'}`);
      }
    }
  }
  if (doSlash) {
    const lv = [...levels, 'ALL'];
    const f3 = (x: number | null) => (x === null ? '  -  ' : x.toFixed(3));
    for (const kind of segKinds) {
      console.log(`\nslash marks on ${kind} segments: P / R / F / wrong-/X rate per level (truth X/X counted as no /X)`);
      console.log(['variant minConf', ...lv].join('\t'));
      for (const variant of ['rules', 'rules+2nd-root guard', 'raw'])
        for (const mc of SWEEP)
          console.log(
            [
              `${variant} ${mc}`,
              ...lv.map((l) => {
                const a = sres.get(`${kind}|${variant}|${mc}|${l}`);
                if (!a) return '-';
                const p = a.resultSlash ? a.hit / a.resultSlash : null;
                const r = a.truthSlash ? a.hit / a.truthSlash : null;
                const f = p && r ? (2 * p * r) / (p + r) : 0;
                return `${f3(p)}/${f3(r)}/${f3(f)}/${f3(a.noSlash ? a.falseSlash / a.noSlash : null)}`;
              }),
            ].join('\t'),
          );
    }
    console.log('\ndiagnostics (truth segments, counts of segments)');
    for (const [k, n] of [...diag.entries()].sort()) console.log(`${k}\t${n}`);
  }
  const jp = argOf(argv, '--json');
  if (jp) {
    mkdirSync(dirname(resolve(jp)), { recursive: true });
    writeFileSync(jp, JSON.stringify(Object.fromEntries([...res.entries()].map(([k, a]) => [k, { ...a, rate: a.scored ? a.hit / a.scored : null }])), null, 1));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
