/**
 * Spike 4 look point 2 (R3) + calibration trial driver (ts/hum/calibrate.ts). Writes only to out/hum/r3/ (gitignored).
 *
 *   npx tsx ts/hum/calibrate_eval.ts ref                 traits of the synthetic H4 TUNING takes (-> REF_TRAITS)
 *   npx tsx ts/hum/calibrate_eval.ts syn [--split tuning|dev] [--levels H3,H4]
 *        synthetic validation: per level and voice (H4 realism.hum 'n' / 'la'; H3 is all 'n'), calibrate on one take,
 *        evaluate the other takes of the same group with the calibrated config vs hum-v3 (starts: exact bar head and
 *        first-note -0.7 beat with its tick, averaged), mean gain over the folds.
 *   npx tsx ts/hum/calibrate_eval.ts rec [--commit SHA]
 *        R3: hum-v3 on the 4 DEV recordings (analyzeHum, firstNoteSec + firstNoteTick from the truth info only),
 *        transposeInvariant scoring, error-type counts per style, shift class; then the leave-one-out calibration.
 *
 * Held-out: synthetic heldOut variants and the held-out recordings are refused (manifest AND truth flags).
 * Privacy: stdout and out/hum/r3 get aggregate numbers, per-style counts, shift classes and voice traits only;
 * never pitches, note sequences, the transposition value, titles or lyrics. Recording result JSONs (they hold notes)
 * are written to out/hum/r3/rec/ only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { analyzeHum, resolveStart } from './analyze';
import { errorTypes, scoreTake as scoreSynTake, type TruthNote } from './baseline';
import { calibrationOverrides, measureVoiceTraits, median, type CalibrationOverrides, type KnownNote, type VoiceTraits } from './calibrate';
import { firstNoteTickFromTruthInfo, variantStart } from './cli';
import { humConfigHash, resolveHumConfig, type HumConfig } from './config';
import { estimateF0 } from './f0';
import { extractNotes, frameLevelDb } from './notes';
import { quantize } from './quantize';
import { scoreRow, shiftFor, type Scores } from './report';
import { unshiftNotes, unshiftQuantized } from './score';
import type { FrameF0Track, HumInput, HumNote, QuantizedMelody } from './types';

const SA = join(import.meta.dirname, '..', '..');
const HUM = join(SA, 'out', 'hum');
const R3 = join(HUM, 'r3');
const DEV = ['hum-01-a', 'hum-01-b', 'hum-03-d', 'hum-05-f'];
const SR = 22050;

export const METRICS = ['noteF.onset', 'noteF.onsetOffset', 'noteF.onsetPitchClass', 'noteF.onsetSemitone', 'noteF.onset100ms', 'quant.exactAcc', 'edit.perNote', 'edit.ratioToKeyboard', 'pitchCand.k2', 'gridCand.k2'];
const ERR = ['nTruth', 'nEst', 'seg.extraSplit', 'seg.missedSplit', 'seg.missedSplit.samePitch', 'seg.missed', 'seg.spurious', 'pitch.matched', 'pitch.ok', 'pitch.semitone', 'pitch.octave', 'pitch.other', 'quant.pairs', 'quant.onsetSlot', 'quant.duration', 'quant.restVsLegato.filledRest', 'quant.restVsLegato.cutLegato'];

interface Prepared {
  track: FrameF0Track;
  level: number[];
}
function prepare(path: string, cfg: HumConfig): Prepared {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  const x = resampleSinc(toMono(wav.channels), wav.sampleRate, SR);
  const f = estimateF0(x, SR, cfg);
  return { track: f.track, level: frameLevelDb(x, SR, f.track) };
}

/** Same steps as analyzeHum after the f0 / level stages (calibration never changes f0 / voicing). */
function runNotes(p: Prepared, info: HumInput, cfg: HumConfig): { notes: HumNote[]; q: QuantizedMelody } {
  const nr = extractNotes(p.track, p.level, info, cfg);
  const st = resolveStart(info);
  const q = quantize(nr.notes, { bpm: info.bpm, ts: info.ts, startSec: st.startSec, firstNoteSec: st.firstNoteSec, firstNoteTick: st.firstNoteTick }, cfg.grid);
  return { notes: nr.notes, q };
}

const mean = (rows: Scores[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
const sum = (rows: Scores[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const r3 = (x: number) => +x.toFixed(3);
const J = (s: Scores) => (s['noteF.onset'] ?? 0) + (s['quant.exactAcc'] ?? 0) - (s['edit.ratioToKeyboard'] ?? 0);
const agg = (rows: Scores[]) => Object.fromEntries([...METRICS.map((k) => [k, r3(mean(rows, k))]), ['J', r3(rows.reduce((a, r) => a + J(r), 0) / rows.length)]]);

/* ------------------------------------------------------------------ synthetic */

interface SynVariant { name: string; level: string; split: string; heldOut: boolean; wav: string; truth: string; bpm: number; ts: [number, number]; startSec: number; melody: string }
interface SynTake { v: SynVariant; p: Prepared; truth: { melody: { notes: TruthNote[] }; hum: { f0: unknown; synth: { articulation: string; realism?: { hum: string } } } }; infos: HumInput[]; voice: string }

function loadSyn(levels: string[], split: string, cfg: HumConfig): SynTake[] {
  if (split !== 'tuning' && split !== 'dev') throw new Error('synthetic split must be tuning or dev');
  const man = JSON.parse(readFileSync(join(HUM, 'manifest.json'), 'utf8')) as { variants: SynVariant[] };
  const out: SynTake[] = [];
  for (const v of man.variants) {
    if (v.heldOut || v.split === 'heldOut' || v.split !== split || !levels.includes(v.level)) continue;
    const truth = JSON.parse(readFileSync(join(HUM, v.truth), 'utf8'));
    const infos = [variantStart(v, 'bar', 0), variantStart(v, 'first-note', -0.7, truth)];
    const voice = truth.hum.synth.realism?.hum ?? truth.hum.synth.articulation;
    out.push({ v, p: prepare(join(HUM, v.wav), cfg), truth, infos, voice });
  }
  return out;
}

/** The calibration input of a synthetic take: its known score and the approximate (first-note -0.7 beat) bar head. */
function synTraits(t: SynTake): VoiceTraits {
  const known: KnownNote[] = t.truth.melody.notes.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi }));
  const st = resolveStart(t.infos[1]);
  return measureVoiceTraits(t.p.track, known, { bpm: t.v.bpm, ts: t.v.ts, startSec: st.startSec });
}

function synScore(t: SynTake, cfg: HumConfig): Scores {
  const rows = t.infos.map((info) => {
    const r = runNotes(t.p, info, cfg);
    return scoreSynTake(t.truth as never, r.notes, r.q);
  });
  const s: Scores = {};
  for (const k of new Set(rows.flatMap((r) => Object.keys(r)))) s[k] = mean(rows, k);
  return s;
}

const TRAIT_KEYS: (keyof VoiceTraits)[] = ['nNotes', 'coverage', 'tuningCents', 'intraSpreadCents', 'wobbleCents', 'noteSigmaCents', 'scoopDepthSemitones', 'scoopMs', 'scoopRate', 'onsetBiasMs', 'onsetScatterMs'];
const traitMedians = (ts: VoiceTraits[]) => Object.fromEntries(TRAIT_KEYS.map((k) => [k, r3(median(ts.map((t) => t[k] as number).filter(Number.isFinite)))]));

function cmdRef() {
  const cfg = resolveHumConfig();
  const out: Record<string, unknown> = { configHash: humConfigHash(cfg) };
  for (const L of ['H2', 'H3', 'H4']) {
    const takes = loadSyn([L], 'tuning', cfg);
    const tr = takes.map(synTraits);
    out[L] = { n: tr.length, median: traitMedians(tr), perVariant: Object.fromEntries(takes.map((t, i) => [t.v.name, { voice: t.voice, ...tr[i] }])) };
    process.stdout.write(`${L} median ${JSON.stringify((out[L] as { median: unknown }).median)}\n`);
  }
  mkdirSync(R3, { recursive: true });
  writeFileSync(join(R3, 'syn-traits.json'), JSON.stringify(out, null, 1) + '\n');
}

/** --keys segment.moveSemitones,... : keep only these mapped keys (ablation on synthetic). */
function pickKeys(ov: CalibrationOverrides): CalibrationOverrides {
  const keys = arg('--keys')?.split(',');
  if (!keys) return ov;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [g, o] of Object.entries(ov as Record<string, Record<string, unknown>>))
    for (const [k, v] of Object.entries(o)) if (keys.includes(`${g}.${k}`)) (out[g] ??= {})[k] = v;
  return out as CalibrationOverrides;
}

function cmdSyn(split: string, levels: string[]) {
  const base = resolveHumConfig();
  const out: Record<string, unknown> = { split, configHash: humConfigHash(base) };
  const allGain: number[] = [];
  for (const L of levels) {
    const takes = loadSyn([L], split, base);
    const baseS = takes.map((t) => synScore(t, base));
    const traits = takes.map(synTraits);
    const ovs = traits.map((t) => pickKeys(calibrationOverrides(t)));
    const groups: Record<string, unknown> = {};
    for (const voice of [...new Set(takes.map((t) => t.voice))]) {
      const idx = takes.map((t, i) => (t.voice === voice ? i : -1)).filter((i) => i >= 0);
      const folds: { cal: string; overrides: CalibrationOverrides; base: Record<string, number>; cal_: Record<string, number>; gainJ: number }[] = [];
      for (const i of idx) {
        const cfg = resolveHumConfig(ovs[i]);
        const ev = idx.filter((j) => j !== i);
        if (!ev.length) continue;
        const b = ev.map((j) => baseS[j]);
        const c = ev.map((j) => synScore(takes[j], cfg));
        const ab = agg(b);
        const ac = agg(c);
        folds.push({ cal: takes[i].v.name, overrides: ovs[i], base: ab, cal_: ac, gainJ: r3(ac.J - ab.J) });
        allGain.push(ac.J - ab.J);
      }
      const g = (k: string) => r3(folds.reduce((a, f) => a + (f.cal_[k] - f.base[k]), 0) / Math.max(1, folds.length));
      groups[voice] = { nTakes: idx.length, folds, meanGain: Object.fromEntries([...METRICS, 'J'].map((k) => [k, g(k)])), traitsMedian: traitMedians(idx.map((i) => traits[i])) };
      process.stdout.write(`${split} ${L} voice ${voice}: ${idx.length} takes, mean gain J ${g('J')} (F onset ${g('noteF.onset')}, quant ${g('quant.exactAcc')}, edits/kbd ${g('edit.ratioToKeyboard')}); folds J ${folds.map((f) => f.gainJ).join(' ')}\n`);
    }
    out[L] = groups;
  }
  out.meanGainJAll = r3(allGain.reduce((a, b) => a + b, 0) / Math.max(1, allGain.length));
  process.stdout.write(`mean gain J over all folds: ${out.meanGainJAll}\n`);
  mkdirSync(R3, { recursive: true });
  writeFileSync(join(R3, `syn-${split}-${levels.join('')}.json`), JSON.stringify(out, null, 1) + '\n');
}

/* ------------------------------------------------------------------ recordings */

interface RecVariant { name: string; heldOut: boolean; style: string; song: string; truth: string; wav: string; bpm: number; ts: [number, number] }
interface RecTruth { heldOut: boolean; info: { bpm: number; ts: [number, number]; startSec: number; firstNoteSec: number }; notes: TruthNote[] }
interface RecTake { v: RecVariant; truth: RecTruth; info: HumInput; p: Prepared }

function loadRec(cfg: HumConfig): RecTake[] {
  const man = JSON.parse(readFileSync(join(SA, 'out', 'rec', 'manifest.hum.json'), 'utf8')) as { variants: RecVariant[] };
  return DEV.map((name) => {
    const v = man.variants.find((x) => x.name === name);
    if (!v || v.heldOut) throw new Error('held-out or unknown recording refused');
    const truth = JSON.parse(readFileSync(join(SA, v.truth), 'utf8')) as RecTruth;
    if (truth.heldOut !== false) throw new Error('held-out recording refused');
    // what the user states: tempo, time signature, approximate first-note second and the beat it starts on
    const info: HumInput = { bpm: v.bpm, ts: v.ts, firstNoteSec: truth.info.firstNoteSec, firstNoteTick: firstNoteTickFromTruthInfo(truth.info) };
    return { v, truth, info, p: prepare(join(SA, v.wav), cfg) };
  });
}

/**
 * Time base of the recordings' seconds-domain truth (the truth is in SCORE time: startSec + tick * tickSec, startSec
 * computed from the user's approximate first-note second, `startApprox`):
 *   given    on the bar-1 head the user's 開始 implies (literal; the start is approximate by design, so seconds metrics
 *            and the transposition estimate from seconds pairs are mostly off)
 *   grid     on the bar-1 head the ANALYZER settled on (melody.quantized.startSec = given + its phase search; nothing
 *            from the truth): the as-is number of look point 2. Tick-domain metrics do not depend on the time base
 *            except through the transposition estimate.
 *   aligned  diagnostic like look point 1: the truth moved by the best constant time shift (onset hits +-80 ms, pitch
 *            ignored, +-4 s), the tick truth by what of that shift the analyzer's grid has not taken up, in whole
 *            16ths (look point 1 had no phase search, so there it was the whole shift); transposition removed by the scorer.
 */
export type TimeBase = 'given' | 'grid' | 'aligned';
const TIME_BASES: TimeBase[] = ['given', 'grid', 'aligned'];

function placeTruth(t: RecTake, notes: HumNote[], q: QuantizedMelody, base: TimeBase): TruthNote[] {
  const tr = t.truth.notes;
  if (base === 'given') return tr;
  if (base === 'grid') {
    const d = q.startSec - t.truth.info.startSec;
    return tr.map((n) => ({ ...n, start: n.start + d, end: n.end + d }));
  }
  const hits = (sh: number) => notes.filter((x) => tr.some((y) => Math.abs(x.start - y.start - sh) <= 0.08)).length;
  let best = { h: -1, sh: 0 };
  for (let k = -400; k <= 400; k += 2) {
    const h = hits(k / 100);
    if (h > best.h || (h === best.h && Math.abs(k / 100) < Math.abs(best.sh))) best = { h, sh: k / 100 };
  }
  // the tick truth: the part of the shift the analyzer's own grid (phase search) has not already taken up, in whole 16ths
  const stepSec = 60 / t.info.bpm / 4;
  const shift16 = 4 * Math.round((best.sh - (q.startSec - t.truth.info.startSec)) / stepSec);
  return tr.map((n) => ({ ...n, start: n.start + best.sh, end: n.end + best.sh, startTick: n.startTick + shift16 })).filter((n) => n.startTick >= 0);
}

/** Recording scores (transposeInvariant) + error types with the same-pitch missed splits, in one time base. */
function recScore(t: RecTake, notes: HumNote[], q: QuantizedMelody, base: TimeBase): Scores {
  const truthAll = placeTruth(t, notes, q, base);
  const truthNotes = truthAll.filter((n) => n.ticks >= 4);
  const input = {
    truthNotes: truthNotes.map((n) => ({ start: n.start, end: n.end, midi: n.midi })),
    estNotes: notes,
    truthTicks: truthAll.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi })),
    estQuant: q,
    transposeInvariant: true,
  };
  const s = scoreRow(input);
  const shift = shiftFor(input);
  const un = unshiftNotes(notes, shift);
  Object.assign(s, errorTypes(truthNotes, un, unshiftQuantized(q, shift)));
  // missed splits whose covered truth notes repeat the same pitch (R2 helper definition)
  const ov = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const hit = (a: { start: number; end: number }, b: { start: number; end: number }) => ov(a, b) > 0.3 * Math.min(a.end - a.start, b.end - b.start);
  let same = 0;
  for (const e of un) {
    const cov = truthNotes.filter((x) => hit(x, e));
    for (let i = 1; i < cov.length; i++) if (cov[i].midi === cov[i - 1].midi) same++;
  }
  s['seg.missedSplit.samePitch'] = same;
  s.nTruth = truthNotes.length;
  s.nEst = notes.length;
  return s;
}

const SHIFT_NAME = ['0', 'octave', 'other'];
type Rows = Record<TimeBase, Scores>;

function cmdRec(commit?: string) {
  const base = resolveHumConfig();
  const hash = humConfigHash(base);
  if (hash !== 'f7a35fb44ae5') throw new Error(`not hum-v3: ${hash}`);
  const takes = loadRec(base);
  mkdirSync(join(R3, 'rec'), { recursive: true });
  const scoreAll = (t: RecTake, notes: HumNote[], q: QuantizedMelody): Rows => Object.fromEntries(TIME_BASES.map((b) => [b, recScore(t, notes, q, b)])) as Rows;
  // Part 1: full analyzeHum per take (result JSON kept locally), checked against the fast path used for the folds
  const baseRows: Rows[] = [];
  const perStyle: Record<string, unknown> = {};
  for (const t of takes) {
    const wav = decodeWav(new Uint8Array(readFileSync(join(SA, t.v.wav))));
    const res = analyzeHum(toMono(wav.channels), wav.sampleRate, t.info, { commit, sourceKind: 'recording' });
    writeFileSync(join(R3, 'rec', `${t.v.name}.json`), JSON.stringify(res) + '\n');
    const fast = runNotes(t.p, t.info, base);
    if (JSON.stringify(fast.q.events) !== JSON.stringify(res.melody.quantized.events)) throw new Error('fast path differs from analyzeHum');
    const s = scoreAll(t, res.melody.notes, res.melody.quantized);
    baseRows.push(s);
    perStyle[t.v.style] = Object.fromEntries(TIME_BASES.map((b) => [b, { shiftClass: SHIFT_NAME[s[b]['shift.class']], counts: Object.fromEntries(ERR.map((k) => [k, s[b][k] ?? 0])) }]));
  }
  const summarize = (rows: Scores[]) => ({
    n: rows.length,
    mean: agg(rows),
    min: Object.fromEntries(METRICS.map((k) => [k, r3(Math.min(...rows.map((r) => r[k] ?? 0)))])),
    max: Object.fromEntries(METRICS.map((k) => [k, r3(Math.max(...rows.map((r) => r[k] ?? 0)))])),
    counts: Object.fromEntries(ERR.map((k) => [k, sum(rows, k)])),
  });
  const part1 = { ...Object.fromEntries(TIME_BASES.map((b) => [b, summarize(baseRows.map((r) => r[b]))])), perStyle };
  for (const b of TIME_BASES) process.stdout.write(`R3 hum-v3 ${hash} [${b}]: ${JSON.stringify((part1 as unknown as Record<string, { mean: unknown }>)[b].mean)}\n`);

  // Part 2: leave-one-out calibration (calibrate on take i with its known melody, evaluate the other 3)
  const traits = takes.map((t) => {
    const st = resolveStart(t.info);
    const known: KnownNote[] = t.truth.notes.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi }));
    return measureVoiceTraits(t.p.track, known, { bpm: t.info.bpm, ts: t.info.ts, startSec: st.startSec });
  });
  const folds = takes.map((t, i) => {
    const ov = calibrationOverrides(traits[i]);
    const cfg = resolveHumConfig(ov);
    const ev = takes.map((_, j) => j).filter((j) => j !== i);
    const c = ev.map((j) => {
      const r = runNotes(takes[j].p, takes[j].info, cfg);
      return scoreAll(takes[j], r.notes, r.q);
    });
    type FoldPart = { base: Record<string, number>; calibrated: Record<string, number>; gain: Record<string, number>; perEval: unknown[]; errBase: unknown; errCal: unknown };
    const per = Object.fromEntries(
      (['grid', 'aligned'] as TimeBase[]).map((tb): [string, FoldPart] => {
        const b = ev.map((j) => baseRows[j][tb]);
        const cc = c.map((x) => x[tb]);
        const ab = agg(b);
        const ac = agg(cc);
        return [tb, { base: ab, calibrated: ac, gain: Object.fromEntries(Object.keys(ab).map((k) => [k, r3(ac[k] - ab[k])])), perEval: ev.map((j, k) => ({ eval: takes[j].v.style, sameSong: takes[j].v.song === t.v.song, gainJ: r3(J(cc[k]) - J(b[k])) })), errBase: Object.fromEntries(ERR.map((k) => [k, sum(b, k)])), errCal: Object.fromEntries(ERR.map((k) => [k, sum(cc, k)])) }];
      }),
    ) as { grid: FoldPart; aligned: FoldPart };
    return { cal: t.v.style, traits: traits[i], overrides: ov, configHash: humConfigHash(cfg), ...per };
  });
  const meanGain = Object.fromEntries(
    (['grid', 'aligned'] as const).map((tb) => [tb, Object.fromEntries(Object.keys(folds[0][tb].gain).map((k) => [k, r3(folds.reduce((a, f) => a + f[tb].gain[k], 0) / folds.length)]))]),
  );
  for (const f of folds) process.stdout.write(`fold cal=${f.cal}: overrides ${JSON.stringify(f.overrides)} gain[grid] J ${f.grid.gain.J} gain[aligned] J ${f.aligned.gain.J}\n`);
  process.stdout.write(`LOO mean gain ${JSON.stringify(meanGain)}\n`);
  const out = { commit, configHash: hash, part1, calibration: { folds, meanGain } };
  writeFileSync(join(R3, 'r3-summary.json'), JSON.stringify(out, null, 1) + '\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];
if (cmd === 'ref') cmdRef();
else if (cmd === 'syn') cmdSyn(arg('--split') ?? 'tuning', (arg('--levels') ?? 'H3,H4').split(','));
else if (cmd === 'rec') cmdRec(arg('--commit'));
else if (cmd !== undefined) throw new Error('usage: calibrate_eval.ts ref | syn [--split tuning|dev] [--levels H3,H4] | rec [--commit SHA]');
