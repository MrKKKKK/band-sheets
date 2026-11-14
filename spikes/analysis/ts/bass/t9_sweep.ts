/**
 * Spike 6 T9 / T10: sweep of bass config sets on the synthetic TUNING split plus the spike 0/2 LR variants (non
 * held-out; the wrong-/X watch of G1 decision 4), or on the DEV split from one logged dev look. docs/audio-spike6-t9.md,
 * docs/audio-spike6-t10.md. Run from spikes/analysis (devcontainer):
 *
 *   npx tsx ts/bass/t9_sweep.ts --sets '<json: {"name": {overrides}, ...}>' [--diag]
 *        tuning: v1a segments from out/bass-results/t8-tuning, LR from out/bass-results/regression/*.v1a.json
 *   npx tsx ts/bass/t9_sweep.ts --split dev --results DIR --sets '...'
 *        dev: v1a segments from a logged dev run (cli.ts --all --split dev --dev-look; DIR/run.json must say ['dev']
 *        and the run must be the default bass-on config with every T10 switch off, so its chords are v1a's)
 *
 * The v1a segments are read from results with the bass fields dropped (the frozen ts/dsp part does not depend on the
 * bass config). Per set: the real bass stage (analyze.ts bassChords, incl. the T10 switches) on the truth segments
 * (ceiling) and on the v1a segments. Printed per level (and per timbre on dev): segment bass, slash P / R / F, wrong-/X
 * rate, cliche runs, edits saved per 100 beats against v1a without the bass stage, chord name / root accuracy of v1a and
 * of the set (T10 root re-decision); LR wrong-/X rate and name changes; marks by interval and kind (correct / wrong);
 * re-decided chords by where the bass sat in the v1a triad and whether the name got right / wrong.
 * --diag: on the truth segments, why a truth /X was missed, per level (as segment_eval.ts --slash; switches ignored).
 * Held-out: selectVariants + heldOutRefusal and the truths' own flags; LR held-out variants skipped by their manifest flag.
 * Output: aggregates only (no chord or bass names, no song names).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../browser/wav';
import { NOTE_NAMES } from '../dsp/chords';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { bassChords } from './analyze';
import { argOf, at, json, slashIn } from './evalCommon';
import { enabledBassConfig, bassConfigHash, type BassConfig } from './config';
import { heldOutRefusal, selectVariants, type GuardVariant } from './heldout_guard';
import { LOW_SR, lowCqt, type LowCqt } from './lowCqt';
import { beatWindows, editCounts, mapVocab, normalizeTruthSlash, noteToPc, scoreBass, type ScoreBeat, type ScoreChord } from './score';
import { segmentBass } from './segmentBass';
import { slashMarks } from './slash';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'out', 'bass');

export interface Item {
  level: string;
  timbre: string;
  low: LowCqt;
  truth: ScoreChord[];
  truthBeats: ScoreBeat[];
  v1a: Chord[];
  v1aBeats: number[];
  /** score truth segments too (synthetic bass only) */
  ceiling: boolean;
}

const lowOf = (wavPath: string, cfg: BassConfig): LowCqt => {
  const wav = decodeWav(new Uint8Array(readFileSync(wavPath)));
  return lowCqt(resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR), cfg.lowCqt);
};
export type Chord = ScoreChord & { bass: string | null };
/**
 * The truth chords as segments for the bass stage (ceiling): no bass, root respelled to the analyzer's names
 * (ts/dsp NOTE_NAMES, sharps), because the bass stage reads roots as the analyzer writes them and a truth may spell a
 * root with a flat (T13: the first truth that did; harness only, scores are by pitch class).
 */
export const truthSegments = (truth: readonly ScoreChord[]): Chord[] => truth.map((c) => ({ ...c, root: NOTE_NAMES[noteToPc(c.root)], bass: null }));
export const strip = (cs: readonly ScoreChord[]): Chord[] => cs.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: null }));

function load(cfg: BassConfig, split: 'tuning' | 'dev', results: string): Item[] {
  const items: Item[] = [];
  const all = json<{ variants: (GuardVariant & { level: string; wav: string; truth: string })[] }>(join(OUT, 'manifest.json')).variants;
  const src = { syn: all, rec: null, ids: null };
  for (const v of selectVariants(all, [split])) {
    const refusal = heldOutRefusal(v.wav, src);
    if (refusal) throw new Error(`${v.name}: ${refusal}`);
    const t = json<{ beats: ScoreBeat[]; chords: ScoreChord[]; bass: { variant: { heldOut: boolean; split: string; timbre: string } } }>(join(OUT, v.truth));
    const tv = t.bass.variant;
    if (tv.heldOut || tv.split !== split || tv.timbre === 'C') throw new Error(`${v.name}: truth is not ${split}`);
    const r = json<{ beats: { t: number }[]; chords: ScoreChord[] }>(join(results, `${v.name}.json`));
    items.push({ level: v.level, timbre: tv.timbre, low: lowOf(join(OUT, v.wav), cfg), truth: t.chords, truthBeats: t.beats, v1a: strip(r.chords), v1aBeats: r.beats.map((b) => b.t), ceiling: true });
  }
  if (split === 'dev') return items;
  const base = join(ROOT, 'out', 'spike0');
  const lr = json<{ variants: { name: string; level: unknown; heldOut?: boolean; wav: string; truth: string }[] }>(join(base, 'manifest.json')).variants;
  for (const v of lr.filter((x) => String(x.level) === 'LR' && !x.heldOut)) {
    const t = json<{ beats: ScoreBeat[]; chords: ScoreChord[] }>(join(base, v.truth));
    const r = json<{ beats: { t: number }[]; chords: ScoreChord[] }>(join(ROOT, 'out', 'bass-results', 'regression', `${v.name}.v1a.json`));
    items.push({ level: 'LR', timbre: '-', low: lowOf(join(base, v.wav), cfg), truth: t.chords, truthBeats: t.beats, v1a: strip(r.chords), v1aBeats: r.beats.map((b) => b.t), ceiling: false });
  }
  return items;
}

interface Acc {
  scored: number;
  segHit: number;
  truthSlash: number;
  resultSlash: number;
  slashHit: number;
  noSlash: number;
  falseSlash: number;
  runs: number;
  runHit: number;
  beats: number;
  editsV1a: number;
  editsSet: number;
  /** chord name (root + vocab quality) / root hits at the scored points: v1a without bass, and the set */
  nameV1a: number;
  nameSet: number;
  rootV1a: number;
  rootSet: number;
}
const acc = (): Acc => ({ scored: 0, segHit: 0, truthSlash: 0, resultSlash: 0, slashHit: 0, noSlash: 0, falseSlash: 0, runs: 0, runHit: 0, beats: 0, editsV1a: 0, editsSet: 0, nameV1a: 0, nameSet: 0, rootV1a: 0, rootSet: 0 });
const f3 = (x: number | null) => (x === null || Number.isNaN(x) ? '  -  ' : x.toFixed(3));

/** Name / root hits of `result` at the score.ts points (dropped truth qualities skipped, weight 0.5). */
function nameHits(truth: readonly ScoreChord[], result: readonly ScoreChord[], beats: readonly ScoreBeat[]): { name: number; root: number } {
  let name = 0;
  let root = 0;
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const t = w[0] + f * (w[2] - w[0]);
      const tc = at(truth, t);
      if (!tc || mapVocab(tc.quality) === null) continue;
      const rc = at(result, t);
      if (!rc) continue;
      const r = noteToPc(rc.root) === noteToPc(tc.root);
      if (r) root += 0.5;
      if (r && mapVocab(rc.quality) === mapVocab(tc.quality)) name += 0.5;
    }
  return { name, root };
}

/** `levels`: the row groups printed (item.level values plus 'ALL'); ts/bass/rec_eval.ts passes the take letters. */
export function run(name: string, cfg: BassConfig, items: Item[], diag: boolean, byTimbre: boolean, levels: readonly string[] = ['B0', 'B1', 'B2', 'B3', 'ALL']): void {
  const res = new Map<string, Acc>();
  const counts = new Map<string, number>();
  const inc = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
  const get = (k: string) => res.get(k) ?? (res.set(k, acc()), res.get(k)!);
  for (const it of items) {
    const tn = normalizeTruthSlash(it.truth);
    const kinds: [string, Chord[], number[]][] = [['v1a', it.v1a, it.v1aBeats]];
    if (it.ceiling) kinds.push(['truth', truthSegments(it.truth), it.truthBeats.map((b) => b.t)]);
    const v1aEdits = editCounts(tn, it.v1a, it.truthBeats);
    const v1aNames = nameHits(tn, it.v1a, it.truthBeats);
    for (const [kind, chords, bt] of kinds) {
      const out = bassChords(it.low, chords, bt, cfg);
      const s = scoreBass(tn, out, it.truthBeats);
      const e = editCounts(tn, out, it.truthBeats);
      const nh = nameHits(tn, out, it.truthBeats);
      const groups = it.level === 'LR' ? ['LR'] : [it.level, 'ALL', ...(byTimbre ? [`t${it.timbre}|${it.level}`, `t${it.timbre}|ALL`] : [])];
      for (const g of groups) {
        const a = get(`${kind}|${g}`);
        a.scored += s.segBass.scored;
        a.segHit += s.segBass.hit;
        a.truthSlash += s.slash.truthSlash;
        a.resultSlash += s.slash.resultSlash;
        a.slashHit += s.slash.hit;
        a.noSlash += s.wrongSlash.noSlashTruth;
        a.falseSlash += s.wrongSlash.falseSlash;
        a.runs += s.cliche.runs;
        a.runHit += s.cliche.hit;
        a.beats += e.nBeats;
        a.editsSet += e.total;
        a.editsV1a += v1aEdits.total;
        a.nameSet += nh.name;
        a.rootSet += nh.root;
        a.nameV1a += v1aNames.name;
        a.rootV1a += v1aNames.root;
      }
      const grp = it.level === 'LR' ? 'LR' : 'syn';
      // marks by interval to the root and kind, judged against the truth chord at the segment midpoint
      for (const c of out) {
        if (!c.bass) continue;
        const mid = (c.start + c.end) / 2;
        const t = at(tn, mid);
        const ok = t?.bass ? noteToPc(t.bass) === noteToPc(c.bass) : false;
        inc(`marks|${kind}|${grp}|iv${(noteToPc(c.bass) - noteToPc(c.root) + 12) % 12}|${c.bassKind}|${ok ? 'hit' : 'miss'}`);
      }
      // re-decided chords (v1a segments): where the bass sat in the v1a triad, name right before / after
      if (kind === 'v1a' && cfg.cliche.redecideRoot) {
        for (const c of out) {
          const v = at(chords, (c.start + c.end) / 2);
          if (!v || (v.root === c.root && v.quality === c.quality)) continue;
          const t = at(tn, (c.start + c.end) / 2);
          const ok = (x: ScoreChord) => !!t && noteToPc(x.root) === noteToPc(t.root) && mapVocab(x.quality) === mapVocab(t.quality);
          const sounding = c.bass ? noteToPc(c.bass) : noteToPc(c.root);
          const ivV = (sounding - noteToPc(v.root) + 12) % 12;
          inc(`redecide|${grp}|v1a ${v.quality} bass iv${ivV}|${ok(v) ? 'wasRight' : 'wasWrong'}->${ok(c) ? 'right' : 'wrong'}`);
        }
      }
      if (diag && kind === 'truth') {
        const sb = segmentBass(it.low, it.truth, bt, cfg.segment);
        const inp = slashIn(it.truth, bt);
        const marks = slashMarks(inp, sb, cfg.slash);
        tn.forEach((t, i) => {
          if (!t.bass) return;
          const want = noteToPc(t.bass);
          const b = sb[i];
          const m = marks[i];
          inc(`truthX|${it.level}`);
          if (m && m.bass === want) return;
          const why = b.pc !== want ? (b.pc === inp[i].root ? (b.second.pc === want ? 'b1=root,2nd=want' : 'b1=root') : 'b1=other') : b.confidence < cfg.slash.minConfidence ? 'lowConf' : 'noKind';
          inc(`miss|${why}|${it.level}`);
          inc(`missIv|${why}|iv${(want - inp[i].root + 12) % 12}|${it.level}`);
        });
      }
    }
  }
  console.log(`\n== ${name} (bass-on hash ${bassConfigHash(cfg)}) ==`);
  const rows = (prefix: string) => [...levels, ...(byTimbre ? ['A', 'B'].flatMap((t) => levels.map((l) => `t${t}|${l}`)) : [])].map((g) => `${prefix}${g}`);
  console.log('kind\tgroup\tsegBass\tslash P/R/F\twrong/X\tcliche(runs)\tsaved/100\tname v1a->set\troot v1a->set');
  for (const kind of ['truth', 'v1a'])
    for (const k of [...rows(`${kind}|`), ...(kind === 'v1a' ? ['v1a|LR'] : [])]) {
      const a = res.get(k);
      if (!a) continue;
      const p = a.resultSlash ? a.slashHit / a.resultSlash : null;
      const r = a.truthSlash ? a.slashHit / a.truthSlash : null;
      console.log(
        `${k.replace('|', '\t')}\t${f3(a.segHit / a.scored)}\t${f3(p)}/${f3(r)}/${f3(p && r ? (2 * p * r) / (p + r) : 0)}\t${f3(a.noSlash ? a.falseSlash / a.noSlash : null)}` +
          `\t${f3(a.runs ? a.runHit / a.runs : null)}(${a.runs})\t${f3(((a.editsV1a - a.editsSet) * 100) / a.beats)}\t${f3(a.nameV1a / a.scored)}->${f3(a.nameSet / a.scored)}\t${f3(a.rootV1a / a.scored)}->${f3(a.rootSet / a.scored)}`,
      );
    }
  const lr = res.get('v1a|LR');
  if (lr) console.log(`LR v1a\twrong/X ${f3(lr.falseSlash / lr.noSlash)} (${lr.falseSlash} of ${lr.noSlash} points)`);
  for (const [k, n] of [...counts.entries()].sort()) console.log(`${k}\t${n}`);
}

function main(argv: string[]): void {
  const split = argOf(argv, '--split') ?? 'tuning';
  if (split !== 'tuning' && split !== 'dev') throw new Error(`--split tuning|dev only, got ${split}`);
  const sets = JSON.parse(argOf(argv, '--sets') ?? '{"T9":{}}') as Record<string, unknown>;
  const cfgs = Object.entries(sets).map(([n, o]) => [n, enabledBassConfig(o)] as const);
  const lowKey = (c: BassConfig) => JSON.stringify(c.lowCqt);
  if (new Set(cfgs.map(([, c]) => lowKey(c))).size !== 1) throw new Error('all sets must share lowCqt');
  let results = join(ROOT, 'out', 'bass-results', 't8-tuning');
  if (split === 'dev') {
    results = resolve(ROOT, argOf(argv, '--results') ?? '');
    const r = json<{ splits?: string[]; configHash?: string }>(join(results, 'run.json'));
    if (JSON.stringify(r.splits) !== '["dev"]') throw new Error(`${results}/run.json is not a logged dev run (cli.ts --all --split dev --dev-look): refusing`);
    const def = enabledBassConfig();
    if (r.configHash !== bassConfigHash(def) || def.cliche.split || def.cliche.redecideRoot) throw new Error(`${results}: not a run of the default bass-on config with the T10 switches off: refusing`);
  }
  const items = load(cfgs[0][1], split, results);
  console.log(`${items.filter((i) => i.ceiling).length} ${split} variants + ${items.filter((i) => !i.ceiling).length} LR variants`);
  for (const [n, c] of cfgs) run(n, c, items, argv.includes('--diag'), split === 'dev');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
