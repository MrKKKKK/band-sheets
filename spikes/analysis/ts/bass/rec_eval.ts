/**
 * Spike 6 R2 / R3: one logged look at the DEV piano recordings, step 2 = scoring (docs/audio-spike6-plan.md section 4
 * "見る時点（録音）", docs/audio-spike6-r2.md). Run from spikes/analysis (devcontainer) AFTER py/tools/bass_rec_fit.py
 * logged the look and wrote the fitted truths:
 *
 *   npx tsx ts/bass/rec_eval.ts --task R2 --sets '<json: {"name": {overrides}, ...}>' [--diag] [--normalize-rms]
 *
 * Refused unless out/results/heldout-log.jsonl has exactly one recordings look line (input 'bass') for --task, and
 * every set's bass-on hash is in that line's configHashes. The takes are that line's takes; each must pass
 * heldOutRefusal (recordings/bas-ids.local.json + out/rec/manifest.bass.json) and its truth must say heldOut false,
 * else nothing is opened. Held-out takes are never read.
 * Per take: the frozen v1a analyzer (bass off) gives the segments and beats; the low CQT is computed once; every set
 * runs the real bass stage (analyze.ts bassChords) on the v1a segments and on the truth segments (ceiling), scored by
 * t9_sweep.ts run() with the takes as row groups — first against the FITTED truth (out/bass-rec/fit, spike 2's
 * fit_grid), then against the NOMINAL truth (out/rec, `開始:` + bpm) as a timing check. Pipeline check: each set's full
 * analyzeWithBass output must equal the bassChords output scored here (counts printed).
 * --diag (same look, no tuning): per take the v1a beat period / truth beat period, v1a beats' offset from the truth
 * grid, chord counts, how many truth chord changes v1a hits within 1/4 beat, and at the scored points the interval
 * (result - truth) of the sounding bass and of the root, split by whether the truth has /X (counts only).
 * --normalize-rms (R3, user decision 2026-11-14; required exactly when the look line says inputGain
 * 'tuning-median-rms'): before the pipeline, each take is scaled by one gain so its whole-file RMS (mono, at LOW_SR)
 * equals the median whole-file RMS of the synthetic TUNING split (non-held-out, same measure), capped so the peak stays
 * at or below -1 dBFS (normalizeGainDb). Harness only: ts/dsp and the bass stage are unchanged.
 * Output: aggregates per take / pooled only (no chord or bass names). No tuning: config values are not changed here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../browser/wav';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { analyzeWithBass, bassChords } from './analyze';
import { bassConfigHash, enabledBassConfig, resolveBassConfig } from './config';
import { heldOutRefusal, selectVariants, type GuardVariant } from './heldout_guard';
import { LOW_SR, lowCqt, type LowCqt } from './lowCqt';
import { beatWindows, mapVocab, normalizeTruthSlash, noteToPc, type ScoreBeat, type ScoreChord } from './score';
import { run, strip, type Chord, type Item } from './t9_sweep';
import type { BassConfig } from './config';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');

const argOf = (argv: string[], k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

interface LookLine {
  kind?: string;
  input?: string;
  task?: string;
  heldOut?: boolean;
  takes?: string[];
  configHashes?: string[];
  inputGain?: string;
}
export interface RecTruth {
  name: string;
  heldOut: boolean;
  excludedBars: number[];
  beats: ScoreBeat[];
  chords: ScoreChord[];
}

/** The one logged look line for `task` (pure; throws when absent, doubled or not a dev look). */
export function lookLineFor(logText: string, task: string): LookLine {
  const lines = logText
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LookLine)
    .filter((d) => d.kind === 'look' && d.input === 'bass' && d.task === task);
  if (lines.length !== 1) throw new Error(`expected exactly one logged recordings look for task ${task}, found ${lines.length} (run py/tools/bass_rec_fit.py first)`);
  const l = lines[0];
  if (l.heldOut !== false || !l.takes?.length) throw new Error(`the ${task} look line is not a dev look with takes: refusing`);
  return l;
}

export const INPUT_GAIN = 'tuning-median-rms';
const dbOf = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));
export function levelDb(y: Float32Array): { rmsDb: number; peakDb: number } {
  let ss = 0;
  let pk = 0;
  for (let i = 0; i < y.length; i++) {
    ss += y[i] * y[i];
    pk = Math.max(pk, Math.abs(y[i]));
  }
  return { rmsDb: dbOf(Math.sqrt(ss / Math.max(1, y.length))), peakDb: dbOf(pk) };
}
/** Gain (dB) that brings the RMS to `targetDb`, capped so the peak stays at or below `ceilingDb` (pure). */
export const normalizeGainDb = (rmsDb: number, peakDb: number, targetDb: number, ceilingDb = -1): number => Math.min(targetDb - rmsDb, ceilingDb - peakDb);

export const loadMono = (path: string): Float32Array => {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  return resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR);
};

/** Median whole-file RMS (dBFS) of the synthetic tuning split (held-out never selected). */
export function tuningMedianRmsDb(): { db: number; files: number } {
  const dir = join(ROOT, 'out', 'bass');
  const all = json<{ variants: (GuardVariant & { wav: string })[] }>(join(dir, 'manifest.json')).variants;
  const vs = selectVariants(all, ['tuning']);
  return { db: med(vs.map((v) => levelDb(loadMono(join(dir, v.wav))).rmsDb)), files: vs.length };
}

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const at = <C extends ScoreChord>(cs: readonly C[], t: number): C | undefined => cs.find((c) => c.start <= t && t < c.end);

/** Timing and confusion aggregates of one config on the v1a segments (counts / rates only). */
export function diagnose(name: string, cfg: BassConfig, items: Item[]): void {
  console.log(`\n== diag ${name} (${bassConfigHash(cfg)}) ==`);
  console.log('take\tbeatRatio\tbeatOffset(med|abs med, beats)\tchords v1a/truth\tchanges hit within 1/4 beat\tno v1a chord (points)');
  const iv = new Map<string, number>();
  const inc = (k: string, n: number) => iv.set(k, (iv.get(k) ?? 0) + n);
  for (const it of items) {
    const tb = it.truthBeats.map((b) => b.t);
    const per = med(tb.slice(1).map((t, i) => t - tb[i]));
    const vper = med(it.v1aBeats.slice(1).map((t, i) => t - it.v1aBeats[i]));
    const inside = it.v1aBeats.filter((t) => t >= tb[0] - per / 2 && t <= tb[tb.length - 1] + per / 2);
    const off = inside.map((t) => {
      const k = Math.round((t - tb[0]) / per);
      return (t - (tb[0] + k * per)) / per;
    });
    const changes = it.truth.slice(1).map((c) => c.start);
    const vb = it.v1a.slice(1).map((c) => c.start);
    const hit = changes.filter((t) => vb.some((b) => Math.abs(b - t) <= per / 4)).length;
    const out = bassChords(it.low, it.v1a, it.v1aBeats, cfg);
    const tn = normalizeTruthSlash(it.truth);
    let pts = 0;
    let noChord = 0;
    for (const w of beatWindows(it.truthBeats))
      for (const f of [0.25, 0.75]) {
        const t = w[0] + f * (w[2] - w[0]);
        const tc = at(tn, t);
        const rc = at(out, t);
        if (!tc || mapVocab(tc.quality) === null) continue;
        pts++;
        if (!rc) {
          noChord++;
          continue;
        }
        const slash = tc.bass ? 'X' : 'noX';
        const tBass = noteToPc(tc.bass ?? tc.root);
        const rBass = noteToPc(rc.bass ?? rc.root);
        inc(`bass|${slash}|iv${(rBass - tBass + 12) % 12}`, 0.5);
        inc(`root|${slash}|iv${(noteToPc(rc.root) - noteToPc(tc.root) + 12) % 12}${noteToPc(rc.root) === noteToPc(tc.root) ? (mapVocab(rc.quality) === mapVocab(tc.quality) ? '' : ' quality') : ''}`, 0.5);
      }
    inc('noChord|points', noChord);
    inc('noChord|of', pts);
    console.log(`${it.level}\t${(vper / per).toFixed(3)}\t${med(off).toFixed(3)}|${med(off.map(Math.abs)).toFixed(3)}\t${it.v1a.length}/${it.truth.length}\t${hit}/${changes.length}\t${noChord}/${pts}`);
  }
  for (const [k, n] of [...iv.entries()].sort()) console.log(`${k}\t${n}`);
}

function main(argv: string[]): void {
  const task = argOf(argv, '--task');
  if (!task) throw new Error('--task is required');
  const sets = Object.entries(JSON.parse(argOf(argv, '--sets') ?? '{}') as Record<string, unknown>).map(([n, o]) => [n, enabledBassConfig(o)] as const);
  if (!sets.length) throw new Error('--sets is required');
  const look = lookLineFor(readFileSync(LOG, 'utf8'), task);
  for (const [n, c] of sets) if (!look.configHashes?.includes(bassConfigHash(c))) throw new Error(`set ${n} (${bassConfigHash(c)}) is not in the logged look's configHashes: refusing`);
  if (new Set(sets.map(([, c]) => JSON.stringify(c.lowCqt))).size !== 1) throw new Error('all sets must share lowCqt');
  const normalize = argv.includes('--normalize-rms');
  if (normalize !== (look.inputGain === INPUT_GAIN)) throw new Error(`--normalize-rms must be given exactly when the logged look says inputGain ${INPUT_GAIN}: refusing`);

  const src = {
    syn: null,
    rec: json<{ variants: GuardVariant[] }>(join(ROOT, 'out', 'rec', 'manifest.bass.json')).variants,
    ids: json<{ recordings: Record<string, { heldOut?: boolean }> }>(join(ROOT, 'recordings', 'bas-ids.local.json')).recordings,
  };
  const takes = look.takes!;
  for (const id of takes) {
    const r = heldOutRefusal(`${id}.wav`, src);
    if (r) throw new Error(`${id}: ${r}`);
  }
  const truthOf = (id: string) => ({ fitted: readRecTruth(join(ROOT, 'out', 'bass-rec', 'fit'), id, false), nominal: readRecTruth(join(ROOT, 'out', 'rec'), id, false) });
  const target = normalize ? tuningMedianRmsDb() : null;
  const r = recordingItems(takes, truthOf, sets, target);
  printRecordings(`${takes.length} dev recordings (task ${task})`, takes, sets, r);
  if (argv.includes('--diag')) for (const [n, c] of sets) diagnose(n, c, r.fitted);
}

/** One recording's truth from `dir`; refused unless its own flag is `heldOut` and it has no excluded bars. */
export function readRecTruth(dir: string, id: string, heldOut: boolean): RecTruth {
  const t = json<RecTruth>(join(dir, `${id}.truth.json`));
  if (t.heldOut !== heldOut || t.name !== id) throw new Error(`${id}: truth flag mismatch: refusing`);
  if (t.excludedBars.length) throw new Error(`${id}: excluded bars are not handled here`);
  return t;
}

export type ConfigSet = readonly [string, BassConfig];
export interface RecItems {
  fitted: Item[];
  nominal: Item[];
  /** per set: chords of the full analyzeWithBass run, and how many equal the bassChords output scored here */
  check: Map<string, { chords: number; same: number }>;
}

/**
 * Per take (audio opened here, after the caller's guards): optional input gain to `target`, the frozen v1a analyzer
 * (bass off) for segments and beats, the low CQT once, items against the fitted and the nominal truth, and the
 * pipeline check of every set. Prints the gain per take (levels only).
 */
export function recordingItems(takes: readonly string[], truthOf: (id: string) => { fitted: RecTruth; nominal: RecTruth }, sets: readonly ConfigSet[], target: { db: number; files: number } | null): RecItems {
  if (target) console.log(`input gain: whole-file RMS to the tuning median ${target.db.toFixed(1)} dBFS (${target.files} synthetic tuning files), peak cap -1 dBFS`);
  const v1aCfg = resolveBassConfig(); // bass off = the frozen v1a result
  const fitted: Item[] = [];
  const nominal: Item[] = [];
  const check = new Map<string, { chords: number; same: number }>(sets.map(([n]) => [n, { chords: 0, same: 0 }]));
  for (const id of takes) {
    const { fitted: tf, nominal: tn } = truthOf(id);
    const y = loadMono(join(ROOT, 'recordings', `${id}.wav`));
    if (target) {
      const lv = levelDb(y);
      const g = normalizeGainDb(lv.rmsDb, lv.peakDb, target.db);
      const k = Math.pow(10, g / 20);
      for (let i = 0; i < y.length; i++) y[i] *= k;
      console.log(`${id}: RMS ${lv.rmsDb.toFixed(1)} dBFS, peak ${lv.peakDb.toFixed(1)} dBFS, gain +${g.toFixed(1)} dB${g < target.db - lv.rmsDb - 1e-9 ? ' (peak-capped)' : ''}`);
    }
    const v1a = analyzeWithBass({ y: y.slice() }, { bass: v1aCfg }).result;
    const low = lowCqt(y, sets[0][1].lowCqt);
    const v1aBeats = v1a.beats.map((b) => b.t);
    const chords = strip(v1a.chords);
    const level = id.slice(-1);
    fitted.push({ level, timbre: '-', low, truth: tf.chords, truthBeats: tf.beats, v1a: chords, v1aBeats, ceiling: true });
    nominal.push({ level, timbre: '-', low, truth: tn.chords, truthBeats: tn.beats, v1a: chords, v1aBeats, ceiling: true });
    pipelineCheck(y, low, chords, v1aBeats, sets, check);
  }
  return { fitted, nominal, check };
}

/** Adds, per set, the chords of the full analyzeWithBass run on `y` and how many equal bassChords on the v1a segments. */
export function pipelineCheck(y: Float32Array, low: LowCqt, chords: Chord[], v1aBeats: number[], sets: readonly ConfigSet[], check: Map<string, { chords: number; same: number }>): void {
  const key = (c: { start: number; end: number; root: string; quality: string; bass: string | null }) => `${c.start}|${c.end}|${c.root}|${c.quality}|${c.bass}`;
  for (const [n, cfg] of sets) {
    const full = analyzeWithBass({ y: y.slice() }, { bass: cfg }).result.chords;
    const mine = bassChords(low, chords, v1aBeats, cfg);
    const a = check.get(n)!;
    a.chords += full.length;
    a.same += full.length === mine.length ? full.filter((c, i) => key(c) === key(mine[i])).length : 0;
  }
}

/** The R2 / R3 printout: pipeline check, then every set against the fitted and the nominal truth (aggregates only). */
export function printRecordings(title: string, takes: readonly string[], sets: readonly ConfigSet[], r: RecItems): void {
  const levels = [...takes.map((id) => id.slice(-1)), 'ALL'];
  console.log(title);
  for (const [n, a] of r.check) console.log(`pipeline check ${n}: ${a.same} of ${a.chords} chords identical to the full analyzeWithBass run`);
  console.log('\n######## truth = FITTED grid (fit_grid) ########');
  for (const [n, c] of sets) run(n, c, r.fitted, false, false, levels);
  console.log('\n######## truth = NOMINAL grid (開始: + bpm) ########');
  for (const [n, c] of sets) run(n, c, r.nominal, false, false, levels);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
