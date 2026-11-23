/**
 * LT1 of the live chord-check tool (docs/live-chord-tool-plan.md sections 1-2): ONE window -> the answer, the top 5
 * with "relative strength %" and the score s, the bass reading, D2's ρ and F1's notes, for one logic variant
 * (variants.ts). Pure and browser-safe (no `node:` import anywhere in its import graph; core.test.ts walks it). The
 * existing functions are CALLED, not rewritten: the same calls as ts/live/timing.ts (LT0) and the plan's section 1.1.
 *
 * What is NOT the same as the spikes' measurements (also on the page):
 *  - no beats, bars, sections or key: the window [colStart, colEnd) is ONE beat = ONE column (perBeat 1, n 1). With
 *    n = 1 the Viterbi path is the best emission and no transition (stay / move, the 2nd-pass theory prior, D2's
 *    switchPenalty) has any effect; v1a's 2nd pass, the merging of segments, the pair rule 'context' and the bass
 *    stage's pedal / passing / cliché readings (they need neighbouring segments) do not exist here. chords2 gets a
 *    dummy key and barOfBeat [0] (never read at n = 1; core.test.ts checks it).
 *  - a window (0.5-3 s) instead of a beat or an eighth (the spikes' columns, ~0.25-0.5 s): two chords mix more easily.
 *  - tuning and gain are measured ONCE per session (`calibrate`, plan 1.3) and passed in, not per file.
 *  - F1's floor (floorRatio x the file's median first pick) becomes a ratio to the window itself.
 *  - "%" = the column posterior x 100 (softmax(20 s) at n = 1), not the app's confidence (smoothed over a song).
 * The user's key only SPELLS the names (src/lib/transpose.ts respellChord); it never reaches a score.
 */
import { normalizeLevel, levelDb } from '../../../../src/lib/analysis/inputLevel';
import { respellChord } from '../../../../src/lib/transpose';
import { segmentBass } from '../bass/segmentBass';
import type { SlashFields } from '../bass/slash';
import { lowCqt, LOW_SR, type LowCqt } from '../bass/lowCqt';
import { analyze, type Chords2Input } from '../chords2/analyze';
import { appBassConfig, type Chords2Config } from '../chords2/config';
import { evalAdded } from '../chords2/d2';
import { toEvalChords } from '../chords2/eval/frontEnd';
import { bassCqtFrom, f1Beats, octaveCqt, type F1Beat } from '../chords2/front/f1';
import { foldF1 } from '../chords2/octaveChroma';
import { marksOnV2, type TimedChord } from '../chords2/pipeline';
import { suffix, triadOf } from '../chords2/vocab';
import { hpss } from '../dsp/audio';
import { DEFAULT_CHORDS_CONFIG, estimateChords, mergeChords, NOTE_NAMES, type ColumnChord } from '../dsp/chords';
import { chordColumns } from '../dsp/chroma';
import { estimateTuning } from '../dsp/core/cqt';
import type { BarKey } from '../dsp/keytrack';
import { segmentCandidates } from '../dsp/posterior';
import { intervals, states as v1aStates, type ChordState } from '../dsp/vocab';
import type { Logic, Variant } from './variants';

/** The sample rate every function here takes (mono). */
export const ANALYZER_SR = LOW_SR;
/** Low-note wait on each side of the window (plan 1.2): the analysed signal is window + 2 x this. */
export const WAIT_SEC = 0.8;
/** Gate on the window's RAW RMS (plan 1.3; provisional, a value of this tool only, not of any analyzer). */
export const GATE_DBFS = -55;
/** Top states shown (plan 2.1). */
export const TOP_K = 5;
/** chords' emission sharpness (a hand-set constant of the frozen ts/dsp/chords.ts, copied there into chords2/analyze.ts too). */
const BETA = 20;

/* ------------------------------------------------------------ once per session (plan 1.3) */

/** Tuning (fractions of a bin) of 22,050 Hz mono `y`, as v1a / the bass stage / F1 estimate it. */
export const measureTuning = (y: Float32Array): number => estimateTuning(y, { sr: ANALYZER_SR, bpo: 36 });

/** The gain (dB) `normalizeLevel` (the app's input level, RMS -22 dBFS, peak <= -1 dBFS) gives `y`; `y` is not changed. */
export const measureGainDb = (y: Float32Array): number => normalizeLevel(y.slice());

/** Both, on the first seconds above the gate: the gain, then the tuning on the gained copy (prepareInput's order). */
export function calibrate(y: Float32Array): { tuning: number; gainDb: number } {
  const g = y.slice();
  const gainDb = normalizeLevel(g);
  return { tuning: measureTuning(g), gainDb };
}

/* ------------------------------------------------------------ one window */

export interface WindowCtx {
  /** fixed for the session (`calibrate`) */
  tuning: number;
  gainDb: number;
  /** the window in seconds of `samples` (the samples reach WAIT_SEC beyond each end) */
  colStart: number;
  colEnd: number;
  /** the user's key (e.g. 'Db', 'F#m'): spelling only */
  key?: string;
}

export interface Candidate {
  name: string;
  /** relative strength: the column posterior x 100 */
  pct: number;
  /** the state's score (weighted cosine after v1a's gates) that the posterior is softmax(20 s) of */
  s: number;
}

export interface BassReading {
  /** spike 6 segmentBass: pitch class (spelled by the key) and (s1 - s2) / s1 */
  note: string;
  confidence: number;
  /** the mark the bass stage wrote (in a window: practically only 'inversion'), null = none */
  kind: 'inversion' | 'passing' | 'pedal' | null;
}

export interface AddedReading {
  /** D2's ρ(d) for the triad of the V0 answer (d = semitones above the root) and its θ */
  rho: Record<number, number>;
  theta: number;
  /** s8-cand: the added tone's reading shown as a candidate (null = none) */
  candidate?: string | null;
}

/** Milliseconds per stage ('chroma', 'cqt', 'f1', 'chords', 'bass') and 'total'. */
export type StageMs = Record<string, number>;

export type WindowResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'quiet'; rmsDb: number }
  | { kind: 'noChord'; ms: StageMs }
  | {
      kind: 'chord';
      /** after the rules (bass marks, D2); several names when the bass stage split the window */
      answer: string;
      /** the answer is not the top state's name (a rule replaced it) */
      ruleChanged: boolean;
      top: Candidate[];
      bass?: BassReading;
      added?: AddedReading;
      /** F1's notes C2-B5, strongest first (rows that read F1) */
      f1Notes?: string[];
      ms: StageMs;
    };

const DUMMY_KEY: BarKey = { bar: 0, tonic: 0, mode: 'major', confidence: 0 }; // n = 1: FamilyPrior's row is never read
const APP_BASS = appBassConfig();

const nameOf = (c: Pick<TimedChord, 'root' | 'quality' | 'bass'>): string => c.root + suffix(c.quality) + (c.bass !== null && c.bass !== c.root ? '/' + c.bass : '');
const stateName = (st: ChordState): string => NOTE_NAMES[st.root] + suffix(st.quality);

/**
 * s of every state from the column posterior: at n = 1 post = softmax(BETA s) exactly, so s_i = s_a + ln(p_i / p_a) / BETA
 * for any state a. The anchor a is the most probable maj / min state, whose s is its plain template cosine (no gate
 * touches a 3-note maj / min state: vocab.gateScores changes the extra qualities, the seventh gate the 4-note states).
 */
function scoresOf(post: Float64Array, sts: readonly ChordState[], chroma: ArrayLike<number>): Float64Array {
  let a = -1;
  sts.forEach((st, i) => {
    if ((st.quality === 'maj' || st.quality === 'min') && (a < 0 || post[i] > post[a])) a = i;
  });
  let sq = 0;
  for (let j = 0; j < 12; j++) sq += chroma[j] * chroma[j];
  const norm = Math.sqrt(sq) || 1;
  const tones = intervals(sts[a].quality).map((x) => (sts[a].root + x) % 12);
  const sA = tones.reduce((acc, j) => acc + chroma[j] / norm, 0) / Math.sqrt(tones.length);
  return post.map((p) => sA + Math.log(p / post[a]) / BETA);
}

/** Top TOP_K by `segmentCandidates` over the one column (plan 2.1), with pct and s. */
function topOf(column: ColumnChord, sts: readonly ChordState[], chroma: ArrayLike<number>, key: string | undefined): { top: Candidate[]; best: ChordState } {
  const post = column.posterior as Float64Array;
  const s = scoresOf(post, sts, chroma);
  const index = new Map(sts.map((st, i) => [`${st.root}|${st.quality}`, i]));
  const cands = segmentCandidates(post, sts, 1, 0, 1, TOP_K);
  const top = cands.map((c) => {
    const i = index.get(`${c.root}|${c.quality}`) as number;
    return { name: respellChord(stateName(sts[i]), key), pct: c.prob * 100, s: s[i] };
  });
  return { top, best: { root: cands[0].root, quality: cands[0].quality } };
}

interface Decoded {
  column: ColumnChord;
  states: readonly ChordState[];
  /** the chroma the templates were scored on (12 values) */
  scored: ArrayLike<number>;
  /** the segments as timed chords (before the marks) */
  chords: TimedChord[];
  /** the bass stage's CQT (absent for v1a without marks) */
  low?: LowCqt;
  f1?: { beat: F1Beat; cfg: Chords2Config };
  /** s8-cand's reading of the added tone */
  candidate?: string | null;
}

function decode(logic: Logic, y: Float32Array, c: WindowCtx, ms: StageMs, now: () => number): Decoded {
  const timed = (k: string, f: () => void): void => {
    const t = now();
    f();
    ms[k] = (ms[k] ?? 0) + now() - t;
  };
  const beats = [c.colStart];
  let cols!: ReturnType<typeof chordColumns>;
  timed('chroma', () => {
    cols = chordColumns(hpss(y).yHarm, beats, c.colEnd, { perBeat: 1, tuningFull: c.tuning, tuningBass: c.tuning });
  });
  const timedChords = (segs: Parameters<typeof toEvalChords>[0]): TimedChord[] => toEvalChords(segs, beats, c.colEnd).map((x) => ({ ...x, bass: x.bass ?? null }));
  if (logic.kind === 'v1a') {
    let column!: ColumnChord;
    let chords!: TimedChord[];
    timed('chords', () => {
      [column] = estimateChords(cols.cChroma, 1, DEFAULT_CHORDS_CONFIG, { perBeat: 1 });
      chords = timedChords(mergeChords([column], DEFAULT_CHORDS_CONFIG, 1));
    });
    let low: LowCqt | undefined;
    if (logic.marks) timed('cqt', () => (low = lowCqt(y, APP_BASS.lowCqt, { tuning: c.tuning })));
    return { column, states: v1aStates(DEFAULT_CHORDS_CONFIG), scored: cols.cChroma, chords, low };
  }
  // chords2 (pipeline.ts chords2Inputs' own calls, with the session's tuning: chords2Inputs does not take one)
  const cfg = logic.cfg;
  const input: Chords2Input = { chroma: cols.cChroma, n: 1, perBeat: 1, barKeys: [DUMMY_KEY], barOfBeat: [0] };
  let low!: LowCqt;
  let f1: F1Beat[] | null = null;
  if (cfg.f1) {
    const f1cfg = cfg.f1;
    let wide!: LowCqt;
    timed('cqt', () => (wide = octaveCqt(y, f1cfg, { tuning: c.tuning })));
    timed('f1', () => {
      f1 = f1Beats(wide, beats, c.colEnd, f1cfg);
      input.f1Beats = f1;
      if (cfg.octaveChroma) input.f1Chroma = foldF1(f1, 1, f1cfg);
    });
    timed('cqt', () => (low = bassCqtFrom(y, wide, APP_BASS.lowCqt)));
  } else timed('cqt', () => (low = lowCqt(y, APP_BASS.lowCqt, { tuning: c.tuning })));
  let out!: ReturnType<typeof analyze>;
  timed('chords', () => (out = analyze(input, cfg)));
  const seg = out.segments[0];
  const cand = cfg.d2?.output === 'candidate' ? (seg?.chordCandidates?.[0] ?? null) : undefined;
  return {
    column: out.columns[0],
    states: out.states,
    scored: input.f1Chroma ?? cols.cChroma,
    chords: timedChords(out.segments),
    low,
    ...(f1 ? { f1: { beat: (f1 as F1Beat[])[0], cfg } } : {}),
    ...(cand !== undefined ? { candidate: cand === null ? null : NOTE_NAMES[cand.root] + suffix(cand.quality) } : {}),
  };
}

/**
 * One window of `samples` (22,050 Hz mono, the window plus WAIT_SEC on each side, RAW level: the session gain is applied
 * here after the gate) through one variant. `samples` is not changed.
 */
export function analyzeWindow(variant: Variant, samples: Float32Array, ctx: WindowCtx, now: () => number = () => performance.now()): WindowResult {
  if (!variant.logic) return { kind: 'unavailable', reason: variant.unavailable ?? '' };
  if (!(ctx.colStart >= 0 && ctx.colEnd > ctx.colStart && Math.round(ctx.colEnd * ANALYZER_SR) <= samples.length))
    throw new Error(`live: window [${ctx.colStart}, ${ctx.colEnd}) s does not fit ${samples.length} samples`);
  const t0 = now();
  const { rmsDb } = levelDb(samples.subarray(Math.round(ctx.colStart * ANALYZER_SR), Math.round(ctx.colEnd * ANALYZER_SR)));
  if (rmsDb < GATE_DBFS) return { kind: 'quiet', rmsDb };
  const k = 10 ** (ctx.gainDb / 20);
  const y = ctx.gainDb === 0 ? samples : samples.map((v) => v * k);
  const ms: StageMs = {};
  const d = decode(variant.logic, y, ctx, ms, now);
  if (d.column.root === null) return { kind: 'noChord', ms: { ...ms, total: now() - t0 } };
  const key = ctx.key;
  const { top, best } = topOf(d.column, d.states, d.scored, key);
  let answer = top[0].name;
  let bass: BassReading | undefined;
  if (d.low) {
    const t = now();
    const beats = [ctx.colStart, ctx.colEnd]; // two beats: the whole window is the head beat (uniform weight, plan 1.1)
    const marked = marksOnV2(d.low, d.chords, beats, APP_BASS) as (TimedChord & SlashFields)[]; // bassChords' fields (marksOnV2 keeps them)
    const [b] = segmentBass(d.low, d.chords, beats, APP_BASS.segment);
    ms.bass = now() - t;
    answer = marked.map((m) => respellChord(nameOf(m), key)).join(' ');
    bass = { note: respellChord(NOTE_NAMES[b.pc], key), confidence: b.confidence, kind: marked.find((m) => m.bassKind)?.bassKind ?? null };
  }
  let added: AddedReading | undefined;
  let f1Notes: string[] | undefined;
  if (d.f1) {
    const { beat, cfg } = d.f1;
    const f1cfg = cfg.f1!;
    f1Notes = beat.notes
      .filter((x) => x.midi >= f1cfg.outLo)
      .sort((a, b) => b.s - a.s)
      .map((x) => respellChord(NOTE_NAMES[x.midi % 12], key) + String(Math.floor(x.midi / 12) - 1));
    // D2 reads the V0 answer's root and triad (d2.ts step 1; the best state is the V0 Viterbi state at n = 1); the
    // candidates-only output reads only maj / min / dim segments (d2.ts addedCandidates)
    const triad = d.candidate !== undefined ? (triadOf(best.quality) === best.quality ? triadOf(best.quality) : null) : triadOf(best.quality);
    if (cfg.d2 && triad) {
      const e = evalAdded(beat.notes, best.root, triad, cfg.d2, f1cfg);
      added = { rho: e.rho, theta: cfg.d2.theta, ...(d.candidate !== undefined ? { candidate: d.candidate === null ? null : respellChord(d.candidate, key) } : {}) };
    }
  }
  return {
    kind: 'chord',
    answer,
    ruleChanged: answer !== top[0].name,
    top,
    ...(bass ? { bass } : {}),
    ...(added ? { added } : {}),
    ...(f1Notes ? { f1Notes } : {}),
    ms: { ...ms, total: now() - t0 },
  };
}
