/**
 * Spike 6 T8: baseline of B-1 + B-2 on the synthetic TUNING split (docs/audio-spike6-plan.md T8 and section 5,
 * docs/audio-spike6-t8.md). Run from spikes/analysis (devcontainer), after `ts/bass/cli.ts --all --split tuning`:
 *
 *   npx tsx ts/bass/baseline.ts [--results out/bass-results/t8-tuning] [--json out/bass-eval/t8-baseline.json]
 *   npx tsx ts/bass/baseline.ts --split dev --results DIR   (T9: scores a logged dev look, see below)
 *
 * Two segmentations per variant, scored against the truth with truth `X/X` counted as no `/X` (score.ts
 * normalizeTruthSlash, T8 decision):
 *  - analysis ("v1a"): the CLI's result JSON (frozen ts/dsp segments + the bass stage, config checked by hash);
 *    "v1a root only" = the same chords with the bass stripped (what the bass stage adds is the difference).
 *  - truth (ceiling): the truth chord segments and beats through the same B-1 + B-2 code (low CQT recomputed here).
 * Per level x {truth, v1a, v1a root only}: segment bass, slash P / R / F, wrong /X rate, cliche runs, edits per 100
 * beats (score.ts). Confusion: per scored point, interval (result bass - truth bass) split by whether the truth has /X.
 * The tuning split by default. `--split dev` (T9) scores the dev split from a results DIR written by `cli.ts --all
 * --split dev --dev-look` (the CLI logs the look; DIR/run.json must say splits ['dev'], else refused) and adds rows per
 * timbre (A / B). Held-out variants are never opened (selectVariants + heldOutRefusal, the truth's own flags).
 * Output: aggregates only (no chord or bass names).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../browser/wav';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { bassConfigHash, enabledBassConfig } from './config';
import { heldOutRefusal, selectVariants, type GuardVariant } from './heldout_guard';
import { LOW_SR, lowCqt } from './lowCqt';
import { beatWindows, editDiff, mapVocab, normalizeTruthSlash, noteToPc, scoreBass, type ScoreBeat, type ScoreChord } from './score';
import { segmentBass } from './segmentBass';
import { argOf, at, slashIn, withSlashMarks } from './evalCommon';
import { slashMarks } from './slash';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'out', 'bass');

interface Variant extends GuardVariant {
  level: string;
  style: string;
  pianoRoot: boolean;
  wav: string;
  truth: string;
}
interface Truth {
  beats: ScoreBeat[];
  chords: ScoreChord[];
  bass: { segments: { played: number }[]; variant: { heldOut: boolean; split: string; timbre: string } };
}
interface Acc {
  files: number;
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
  editsWith: number;
  editsWithout: number;
  ops: Record<string, number>;
  /** interval (result bass - truth bass) per scored point: key `x|d` (truth has /X) or `n|d`; d = 'none' without a result chord */
  conf: Record<string, number>;
  octN: number;
  octHit: number;
}
const acc = (): Acc => ({ files: 0, scored: 0, segHit: 0, truthSlash: 0, resultSlash: 0, slashHit: 0, noSlash: 0, falseSlash: 0, runs: 0, runHit: 0, beats: 0, editsWith: 0, editsWithout: 0, ops: {}, conf: {}, octN: 0, octHit: 0 });

const sounding = (c: ScoreChord): number => (c.bass ? noteToPc(c.bass) : noteToPc(c.root));

/** Interval histogram on the score.ts points (two per truth beat, weight 0.5; dropped truth qualities skipped). */
function confusion(a: Acc, truth: readonly ScoreChord[], result: readonly ScoreChord[], beats: readonly ScoreBeat[]): void {
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const t = w[0] + f * (w[2] - w[0]);
      const tc = at(truth, t);
      if (!tc || mapVocab(tc.quality) === null) continue;
      const rc = at(result, t);
      const k = `${tc.bass ? 'x' : 'n'}|${rc ? (sounding(rc) - sounding(tc) + 12) % 12 : 'none'}`;
      a.conf[k] = (a.conf[k] ?? 0) + 0.5;
    }
}

function add(a: Acc, truth: ScoreChord[], result: ScoreChord[], beats: ScoreBeat[]): void {
  const s = scoreBass(truth, result, beats);
  const e = editDiff(truth, result, beats);
  a.files++;
  a.scored += s.segBass.scored;
  a.segHit += s.segBass.hit;
  a.truthSlash += s.slash.truthSlash;
  a.resultSlash += s.slash.resultSlash;
  a.slashHit += s.slash.hit;
  a.noSlash += s.wrongSlash.noSlashTruth;
  a.falseSlash += s.wrongSlash.falseSlash;
  a.runs += s.cliche.runs;
  a.runHit += s.cliche.hit;
  a.beats += e.withBass.nBeats;
  a.editsWith += e.withBass.total;
  a.editsWithout += e.withoutBass.total;
  for (const k of ['name', 'slashAdd', 'slashRemove', 'slashChange', 'split', 'merge'] as const) a.ops[k] = (a.ops[k] ?? 0) + e.withBass[k];
  confusion(a, truth, result, beats);
}

const f3 = (x: number | null) => (x === null || Number.isNaN(x) ? '  -  ' : x.toFixed(3));
const r = (a: number, b: number) => (b ? a / b : null);
function row(a: Acc) {
  const p = r(a.slashHit, a.resultSlash);
  const rc = r(a.slashHit, a.truthSlash);
  return {
    files: a.files,
    segBass: r(a.segHit, a.scored),
    slashP: p,
    slashR: rc,
    slashF: p && rc ? (2 * p * rc) / (p + rc) : 0,
    wrongSlash: r(a.falseSlash, a.noSlash),
    cliche: r(a.runHit, a.runs),
    clicheRuns: a.runs,
    editsPer100: r(a.editsWith * 100, a.beats),
    editsPer100NoBass: r(a.editsWithout * 100, a.beats),
    savedPer100: r((a.editsWithout - a.editsWith) * 100, a.beats),
    ops: a.ops,
    octave: r(a.octHit, a.octN),
    conf: a.conf,
  };
}

function main(argv: string[]): void {
  const split = argOf(argv, '--split') ?? 'tuning';
  if (split !== 'tuning' && split !== 'dev') throw new Error(`--split tuning|dev only, got ${split}`);
  const results = resolve(ROOT, argOf(argv, '--results') ?? 'out/bass-results/t8-tuning');
  if (split === 'dev') {
    const run = JSON.parse(readFileSync(join(results, 'run.json'), 'utf8')) as { splits?: string[] };
    if (JSON.stringify(run.splits) !== '["dev"]') throw new Error(`${results}/run.json is not a logged dev run (cli.ts --all --split dev --dev-look): refusing`);
  }
  const cfg = enabledBassConfig();
  const hash = bassConfigHash(cfg);
  const all = (JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: Variant[] }).variants;
  const src = { syn: all, rec: null, ids: null };
  const vs = selectVariants(all, [split]);
  const res = new Map<string, Acc>();
  const get = (k: string) => res.get(k) ?? (res.set(k, acc()), res.get(k)!);
  for (const v of vs) {
    const refusal = heldOutRefusal(v.wav, src);
    if (refusal) throw new Error(`${v.name}: ${refusal}`);
    const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as Truth;
    const tv = truth.bass.variant;
    if (tv.heldOut || tv.split !== split || tv.timbre === 'C') throw new Error(`${v.name}: truth is not ${split}, refusing`);
    const out = JSON.parse(readFileSync(join(results, `${v.name}.json`), 'utf8')) as { chords: ScoreChord[]; bassAnalyzer?: { configHash: string } };
    if (out.bassAnalyzer?.configHash !== hash) throw new Error(`${v.name}: result config ${out.bassAnalyzer?.configHash} != ${hash}`);
    const tn = normalizeTruthSlash(truth.chords);
    const v1a = out.chords.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: c.bass ?? null }));
    // truth segments (ceiling): same B-1 + B-2 code on the truth chords and beats
    const wav = decodeWav(new Uint8Array(readFileSync(join(OUT, v.wav))));
    const low = lowCqt(resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR), cfg.lowCqt);
    const tBeats = truth.beats.map((b) => b.t);
    const sb = segmentBass(low, truth.chords, tBeats, cfg.segment);
    const ceil = withSlashMarks(truth.chords, slashMarks(slashIn(truth.chords, tBeats), sb, cfg.slash));
    const groups = [v.level, 'ALL', `${v.level}|${v.style}`, `ALL|${v.style}`, `ALL|pianoRoot=${v.pianoRoot}`, `t${tv.timbre}|${v.level}`, `t${tv.timbre}|ALL`];
    for (const g of groups) {
      add(get(`truth|${g}`), tn, ceil, truth.beats);
      add(get(`v1a|${g}`), tn, v1a, truth.beats);
      add(get(`root|${g}`), tn, v1a.map((c) => ({ ...c, bass: null })), truth.beats);
      // octave of the B-1 reading on the truth segments (pitch class hits only)
      const a = get(`truth|${g}`);
      truth.chords.forEach((c, i) => {
        if (sb[i].pc !== sounding(c)) return;
        a.octN++;
        if (sb[i].midi === truth.bass.segments[i]?.played) a.octHit++;
      });
    }
  }
  const levels = [...new Set(vs.map((v) => v.level))].sort();
  const styles = [...new Set(vs.map((v) => v.style))];
  console.log(`baseline, ${split} split: ${vs.length} files, bass config ${hash}, results ${results}`);
  const kinds: [string, string][] = [
    ['truth', 'truth segments (ceiling)'],
    ['v1a', 'v1a segments + bass'],
    ['root', 'v1a segments, root only (bass stripped)'],
  ];
  for (const [k, label] of kinds) {
    console.log(`\n${label}\nlevel\tsegBass\tslash P/R/F\twrong/X\tcliche(runs)\tedits/100 (no bass)\tsaved/100\toctave`);
    for (const l of [...levels, 'ALL']) {
      const x = row(get(`${k}|${l}`));
      console.log(
        `${l}\t${f3(x.segBass)}\t${f3(x.slashP)}/${f3(x.slashR)}/${f3(x.slashF)}\t${f3(x.wrongSlash)}\t${f3(x.cliche)}(${x.clicheRuns})\t${f3(x.editsPer100)} (${f3(x.editsPer100NoBass)})\t${f3(x.savedPer100)}\t${k === 'truth' ? f3(x.octave) : ''}`,
      );
    }
  }
  const timbres = [...new Set(vs.map((v) => String(v.timbre)))].sort();
  if (timbres.length > 1) {
    console.log('\nper timbre: kind timbre level segBass slash P/R/F wrong/X');
    for (const [k] of kinds)
      for (const t of timbres)
        for (const l of [...levels, 'ALL']) {
          const x = row(get(`${k}|t${t}|${l}`));
          console.log(`${k}\t${t}\t${l}\t${f3(x.segBass)}\t${f3(x.slashP)}/${f3(x.slashR)}/${f3(x.slashF)}\t${f3(x.wrongSlash)}`);
        }
  }
  console.log('\nper style (ALL levels): segBass truth / v1a / root only; slash F truth / v1a; wrong /X v1a');
  for (const s of [...styles, 'pianoRoot=true', 'pianoRoot=false']) {
    const [t, v, o] = ['truth', 'v1a', 'root'].map((k) => row(get(`${k}|ALL|${s}`)));
    console.log(`${s}\t${f3(t.segBass)} / ${f3(v.segBass)} / ${f3(o.segBass)}\t${f3(t.slashF)} / ${f3(v.slashF)}\t${f3(v.wrongSlash)}`);
  }
  console.log('\nedit operations with bass per level (v1a): name slashAdd slashRemove slashChange split merge | beats');
  for (const l of [...levels, 'ALL']) {
    const a = get(`v1a|${l}`);
    const b = get(`root|${l}`);
    console.log(`${l}\t${JSON.stringify(a.ops)}\tno bass ${JSON.stringify(b.ops)}\t${a.beats}`);
  }
  console.log('\nconfusion: interval result bass - truth bass (semitones), weighted points; x = truth has /X, n = no /X');
  for (const k of ['truth', 'v1a', 'root'])
    for (const l of [...levels, 'ALL']) {
      const c = get(`${k}|${l}`).conf;
      for (const side of ['x', 'n']) {
        const ent = Object.entries(c).filter(([kk]) => kk.startsWith(`${side}|`));
        const n = ent.reduce((s, [, v]) => s + v, 0);
        const errs = ent
          .filter(([kk]) => kk !== `${side}|0`)
          .sort((a, b) => b[1] - a[1])
          .map(([kk, v]) => `${kk.slice(2)}:${v}`)
          .join(' ');
        console.log(`${k} ${l} ${side}\tn=${n}\thit ${c[`${side}|0`] ?? 0}\t[${errs}]`);
      }
    }
  const jp = argOf(argv, '--json');
  if (jp) {
    mkdirSync(dirname(resolve(jp)), { recursive: true });
    writeFileSync(jp, JSON.stringify({ configHash: hash, files: vs.length, rows: Object.fromEntries([...res.entries()].map(([k, a]) => [k, row(a)])) }, null, 1));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
