/**
 * Spike 4 T2: scoring of the humming analyzer (docs/audio-spike4-plan.md section 4 "metrics").
 *
 * Own implementation of the metrics; the note-level and frame-level ones follow mir_eval 0.8.2 exactly
 * (py/tools/hum_mireval_check.py compares them to mir_eval to 1e-9):
 *
 *   noteScores()          mir_eval.transcription.precision_recall_f1_overlap: maximum 1:1 bipartite matching (Kuhn),
 *                         onset |d| <= tol (50 ms), pitch |d| <= tol (50 cents) where the pitch distance is
 *                         1200*|log2(refHz) - log2(estHz)|, offset |d| <= max(20 % of the reference duration, 50 ms);
 *                         time distances are rounded to 4 decimals first (mir_eval N_DECIMALS, np.around = half to even).
 *                         Empty reference or estimate: all 0 (as mir_eval). Variants: onset only (offsetRatio null),
 *                         onset+offset, and the relaxed ones (pitch class only, +-1 semitone, +-100 ms).
 *   f0Scores()            mir_eval.melody to_cent_voicing (kind 'linear', est resampled to the reference time base,
 *                         zero-time sample inserted when a series starts after 0), raw_pitch_accuracy,
 *                         raw_chroma_accuracy, voicing_recall, voicing_false_alarm. Hz < 0 = "unvoiced, pitch guess".
 *                         Extra: octaveErrorRate = RCA - RPA (voiced ref frames whose pitch is right only up to octaves).
 *   quantScores()         accuracy of the notes on the tick grid.
 *   editScript()          "edit count" (see below), editsPerNote, and the keyboard baseline.
 *   gridCandidateHit(), pitchCandidateHit()   candidate hit rates.
 *
 * Privacy: every exported result is numbers only. Nothing here prints or returns a note sequence; the callers
 * (report.ts) must keep it that way for real recordings.
 */
import { TICKS_PER_16TH, type FrameF0Track, type HumNote, type QuantizedMelody } from './types';

/* ------------------------------------------------------------------ shared small helpers */

/** Round half to even (numpy rint). */
function rint(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
/** np.around(x, 4). */
function around4(x: number): number {
  return rint(x * 1e4) / 1e4;
}
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function fMeasure(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Maximum cardinality bipartite matching; `adj[i]` lists the right-hand nodes of left node i. Returns match size. */
export function maxBipartiteMatching(nLeft: number, nRight: number, adj: number[][]): { size: number; pairs: [number, number][] } {
  const matchR = new Array<number>(nRight).fill(-1);
  const tryAug = (u: number, seen: boolean[]): boolean => {
    for (const v of adj[u]) {
      if (seen[v]) continue;
      seen[v] = true;
      if (matchR[v] < 0 || tryAug(matchR[v], seen)) {
        matchR[v] = u;
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (let u = 0; u < nLeft; u++) if (tryAug(u, new Array<boolean>(nRight).fill(false))) size++;
  const pairs: [number, number][] = [];
  for (let v = 0; v < nRight; v++) if (matchR[v] >= 0) pairs.push([matchR[v], v]);
  pairs.sort((a, b) => a[0] - b[0]);
  return { size, pairs };
}

/* ------------------------------------------------------------------ note level (seconds domain) */

/** A note in seconds. `midi` is the intended/rounded pitch, `cents` the deviation (sung pitch = midi + cents/100). */
export interface ScoreNote {
  start: number;
  end: number;
  midi: number;
  cents?: number;
}

export interface NoteMatchOptions {
  /** seconds, default 0.05 */
  onsetTol?: number;
  /** cents, default 50 (also used as the pitch-class tolerance) */
  pitchTol?: number;
  /** null = ignore offsets (onset-only); default 0.2 */
  offsetRatio?: number | null;
  /** seconds, default 0.05 */
  offsetMinTol?: number;
  /** 'pitch' (default): absolute pitch; 'class': octave ignored (distance folded to [0, 600]); 'any': ignore pitch */
  pitchMode?: 'pitch' | 'class' | 'any';
}

export interface NoteScore {
  precision: number;
  recall: number;
  f: number;
  matched: number;
  nRef: number;
  nEst: number;
}

const sungMidi = (n: ScoreNote): number => n.midi + (n.cents ?? 0) / 100;

/**
 * T15 / review M1: the pitch definition of the headline note F is the WRITTEN note (score-time MIDI): both sides get
 * `cents` removed, so "pitch right" = same MIDI number (|d| <= 50 cents on integers). The synthetic truth `cents`
 * (voice deviation, take offset, drift) and the analyzer's residual `cents` are NOT part of it. The old definition
 * (sung pitch = midi + cents/100 on both sides, which counts a deviation of > 50 cents from the written note as
 * right) is kept only as `noteF_sungPitch.*` in scoreRow so old numbers stay interpretable.
 */
export function writtenPitch<T extends { cents?: number }>(notes: T[]): T[] {
  return notes.map((n) => {
    const { cents: _c, ...rest } = n;
    return rest as T;
  });
}

export function matchNotes(ref: ScoreNote[], est: ScoreNote[], o: NoteMatchOptions = {}): [number, number][] {
  const onsetTol = o.onsetTol ?? 0.05;
  const pitchTol = o.pitchTol ?? 50;
  const offsetRatio = o.offsetRatio === undefined ? 0.2 : o.offsetRatio;
  const offsetMin = o.offsetMinTol ?? 0.05;
  const mode = o.pitchMode ?? 'pitch';
  const refLog = ref.map((n) => Math.log2(midiToHz(sungMidi(n))));
  const estLog = est.map((n) => Math.log2(midiToHz(sungMidi(n))));
  // mir_eval iterates the graph keyed by est; the matching size is the same for any maximum matching.
  const adj: number[][] = ref.map((r, i) => {
    const row: number[] = [];
    const refDur = r.end - r.start;
    const offTol = offsetRatio === null ? 0 : Math.max(offsetRatio * refDur, offsetMin);
    for (let j = 0; j < est.length; j++) {
      const e = est[j];
      if (around4(Math.abs(r.start - e.start)) > onsetTol) continue;
      if (mode !== 'any') {
        let pd = Math.abs(1200 * (refLog[i] - estLog[j]));
        if (mode === 'class') pd = Math.abs(pd - 1200 * rint(pd / 1200));
        if (pd > pitchTol) continue;
      }
      if (offsetRatio !== null && around4(Math.abs(r.end - e.end)) > offTol) continue;
      row.push(j);
    }
    return row;
  });
  return maxBipartiteMatching(ref.length, est.length, adj).pairs;
}

export function noteScores(ref: ScoreNote[], est: ScoreNote[], o: NoteMatchOptions = {}): NoteScore {
  if (ref.length === 0 || est.length === 0) {
    return { precision: 0, recall: 0, f: 0, matched: 0, nRef: ref.length, nEst: est.length };
  }
  const matched = matchNotes(ref, est, o).length;
  const precision = matched / est.length;
  const recall = matched / ref.length;
  return { precision, recall, f: fMeasure(precision, recall), matched, nRef: ref.length, nEst: est.length };
}

/** The variants of the plan (section 4), keyed by a stable name. */
export const NOTE_VARIANTS: Record<string, NoteMatchOptions> = {
  onset: { offsetRatio: null },
  onsetOffset: {},
  onsetPitchClass: { offsetRatio: null, pitchMode: 'class' },
  onsetSemitone: { offsetRatio: null, pitchTol: 100 },
  onset100ms: { offsetRatio: null, onsetTol: 0.1 },
};

export function noteScoreSet(ref: ScoreNote[], est: ScoreNote[]): Record<string, NoteScore> {
  const out: Record<string, NoteScore> = {};
  for (const [k, o] of Object.entries(NOTE_VARIANTS)) out[k] = noteScores(ref, est, o);
  return out;
}

/* ------------------------------------------------------------------ frame f0 (mir_eval.melody) */

export interface F0Scores {
  rawPitchAccuracy: number;
  rawChromaAccuracy: number;
  voicingRecall: number;
  voicingFalseAlarm: number;
  /** RCA - RPA: voiced reference frames that are right only up to an octave. */
  octaveErrorRate: number;
}

/** hz2cents with base 10 Hz; 0 stays 0. */
function hz2cents(hz: number[]): number[] {
  return hz.map((f) => (f === 0 ? 0 : 1200 * Math.log2(Math.abs(f) / 10)));
}

/**
 * mir_eval.melody.resample_melody_series, kind 'linear', for the cases to_cent_voicing uses.
 * `times` ascending; `freq` in cents (0 = unvoiced); `voicing` 0..1.
 */
function resampleSeries(times: number[], cents: number[], voicing: number[], newTimes: number[]) {
  const same = times.length === newTimes.length && times.every((t, i) => Math.abs(t - newTimes[i]) <= 1e-8 + 1e-5 * Math.abs(newTimes[i]));
  if (same) return { cents, voicing };
  let t = times.map((x) => Math.round(x * 1e10) / 1e10);
  const tn = newTimes.map((x) => Math.round(x * 1e10) / 1e10);
  let c = cents.slice();
  let v = voicing.slice();
  const maxNew = Math.max(...tn);
  if (maxNew > t[t.length - 1]) {
    t = [...t, maxNew];
    c = [...c, 0];
    v = [...v, 0];
  }
  const held = c.slice();
  for (let n = 1; n < c.length; n++) if (c[n] === 0) held[n] = held[n - 1];
  const idxAt = (x: number): number => {
    // last index with t[i] <= x (scipy interp1d 'zero' semantics); x inside [t0, tlast]
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const linear = (arr: number[], x: number): number => {
    const i = idxAt(x);
    if (i >= t.length - 1) return arr[t.length - 1];
    return arr[i] + ((arr[i + 1] - arr[i]) * (x - t[i])) / (t[i + 1] - t[i]);
  };
  const binary = v.every((x) => x === 0 || x === 1);
  const outC = tn.map((x) => (c[idxAt(x)] !== 0 ? linear(held, x) : 0));
  const outV = tn.map((x) => (binary ? v[idxAt(x)] : linear(v, x)));
  return { cents: outC, voicing: outV };
}

/**
 * Frame f0 metrics. `refHz`/`estHz`: Hz per frame, 0 = no pitch, negative = unvoiced with a pitch guess
 * (mir_eval file convention). Times in seconds (ascending). The estimate is resampled to the reference time base.
 */
export function f0Scores(refTime: number[], refHz: number[], estTime: number[], estHz: number[]): F0Scores {
  if (refTime.length !== refHz.length || estTime.length !== estHz.length) throw new Error('f0Scores: length mismatch');
  let rt = refTime;
  let rf = refHz;
  let et = estTime;
  let ef = estHz;
  if (rt.length > 0 && rt[0] > 0) {
    rt = [0, ...rt];
    rf = [rf[0], ...rf];
  }
  if (et.length > 0 && et[0] > 0) {
    et = [0, ...et];
    ef = [ef[0], ...ef];
  }
  const refV: number[] = rf.map((f) => (f > 0 ? 1 : 0));
  const estV0: number[] = ef.map((f) => (f > 0 ? 1 : 0));
  const refC = hz2cents(rf.map(Math.abs));
  const estC0 = hz2cents(ef.map(Math.abs));
  const res = resampleSeries(et, estC0, estV0, rt);
  let estC = res.cents;
  let estV = res.voicing;
  const diff = refC.length - estC.length;
  if (diff >= 0) {
    estC = [...estC, ...new Array<number>(diff).fill(0)];
    estV = [...estV, ...new Array<number>(diff).fill(0)];
  } else {
    estC = estC.slice(0, refC.length);
    estV = estV.slice(0, refV.length);
  }
  const nRefVoiced = refV.reduce((s, x) => s + x, 0);
  let rpa = 0;
  let rca = 0;
  if (nRefVoiced > 0 && refC.length > 0) {
    let okP = 0;
    let okC = 0;
    let anyNonzero = false;
    for (let i = 0; i < refC.length; i++) {
      if (estC[i] === 0 || refC[i] === 0) continue;
      anyNonzero = true;
      const d = Math.abs(refC[i] - estC[i]);
      if (d < 50) okP += refV[i];
      const oct = 1200 * Math.floor(d / 1200 + 0.5);
      if (Math.abs(d - oct) < 50) okC += refV[i];
    }
    if (anyNonzero) {
      rpa = okP / nRefVoiced;
      rca = okC / nRefVoiced;
    }
  }
  let recall: number;
  let falseAlarm: number;
  if (refV.length === 0 || estV.length === 0) {
    recall = 0;
    falseAlarm = 0;
  } else {
    const nUnvoiced = refV.length - nRefVoiced;
    recall = nRefVoiced === 0 ? 1 : refV.reduce((s, x, i) => s + estV[i] * x, 0) / nRefVoiced;
    falseAlarm = nUnvoiced === 0 ? 0 : refV.reduce((s, x, i) => s + estV[i] * (x === 0 ? 1 : 0), 0) / nUnvoiced;
  }
  return { rawPitchAccuracy: rpa, rawChromaAccuracy: rca, voicingRecall: recall, voicingFalseAlarm: falseAlarm, octaveErrorRate: rca - rpa };
}

/** Time base of a FrameF0Track. */
export function trackTimes(tr: { t0: number; hopSec: number; hz: number[] }): number[] {
  return tr.hz.map((_, i) => tr.t0 + i * tr.hopSec);
}
/**
 * Hz series of an analyzer track in mir_eval convention: voiced frames (voiced >= threshold, hz > 0) keep their Hz,
 * frames with a pitch but below the threshold become negative (unvoiced guess), no pitch = 0.
 */
export function trackSignedHz(tr: FrameF0Track, threshold = 0.5): number[] {
  return tr.hz.map((f, i) => (f > 0 ? (tr.voiced[i] >= threshold ? f : -f) : 0));
}
/** f0Scores for a truth track (hz, 0 = unvoiced) and an analyzer track. */
export function f0TrackScores(truth: { t0: number; hopSec: number; hz: number[] }, est: FrameF0Track, threshold = 0.5): F0Scores {
  return f0Scores(trackTimes(truth), truth.hz, trackTimes(est), trackSignedHz(est, threshold));
}

/* ------------------------------------------------------------------ tick grid: events, edit count */

/** A note or rest on the tick grid. Same shape as QuantizedEvent, but only the fields scoring needs. */
export type TickEvent = { kind: 'note'; startTick: number; ticks: number; midi: number } | { kind: 'rest'; startTick: number; ticks: number };
export interface TickNote {
  startTick: number;
  ticks: number;
  midi: number;
}

/** Initial duration of the keyboard baseline (a quarter note, the app's default). */
export const KEYBOARD_DEFAULT_TICKS = 16;

/** Notes shorter than a 16th (decorations) are not counted in the truth (plan section 4, same as score.py _melody). */
export function dropShortTruth(notes: TickNote[], minTicks = TICKS_PER_16TH): TickNote[] {
  return notes.filter((n) => n.ticks >= minTicks);
}

/** Notes -> consecutive events from tick 0 (gaps become rests; trailing rests are not produced). Notes sorted by start. */
export function notesToEvents(notes: TickNote[]): TickEvent[] {
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  const out: TickEvent[] = [];
  let t = 0;
  for (const n of sorted) {
    if (n.startTick > t) out.push({ kind: 'rest', startTick: t, ticks: n.startTick - t });
    out.push({ kind: 'note', startTick: n.startTick, ticks: n.ticks, midi: n.midi });
    t = n.startTick + n.ticks;
  }
  return out;
}
/** Events of a QuantizedMelody with trailing rests stripped. */
export function quantizedToEvents(q: Pick<QuantizedMelody, 'events'>): TickEvent[] {
  const ev: TickEvent[] = q.events.map((e) => (e.kind === 'note' ? { kind: 'note', startTick: e.startTick, ticks: e.ticks, midi: e.midi } : { kind: 'rest', startTick: e.startTick, ticks: e.ticks }));
  while (ev.length > 0 && ev[ev.length - 1].kind === 'rest') ev.pop();
  return ev;
}

export type EditOp = 'pitch' | 'duration' | 'insert' | 'delete' | 'split' | 'merge';
export interface EditResult {
  /** Minimum number of operations turning the output into the truth. */
  edits: number;
  counts: Record<EditOp, number>;
  nTruthNotes: number;
  nTruthEvents: number;
  /** edits / nTruthNotes (0 when the truth has no notes). */
  editsPerNote: number;
  /** Steps to enter the truth from scratch on the keyboard: events + duration switches. */
  keyboardSteps: number;
  /** edits / keyboardSteps. */
  ratioToKeyboard: number;
  /** Alignment pairs (truth note index, output note index; notes in start order, rests not counted) of the substitution steps between two notes. */
  notePairs: [number, number][];
}

/** Keyboard baseline: one step per event (note or rest) plus one per change of duration (the first event is compared with KEYBOARD_DEFAULT_TICKS). */
export function keyboardSteps(truth: TickEvent[]): number {
  let cur = KEYBOARD_DEFAULT_TICKS;
  let steps = 0;
  for (const e of truth) {
    steps++;
    if (e.ticks !== cur) {
      steps++;
      cur = e.ticks;
    }
  }
  return steps;
}

/**
 * Edit count. The melody is the sequence of events (notes with pitch + duration, rests with duration) as in the
 * editor; positions follow from the durations. The output is turned into the truth with these unit-cost operations:
 *   - change pitch      of a note                                  (1)
 *   - change duration   of a note or rest                          (1)
 *   - insert / delete   an event (note or rest)                    (1 each; note <-> rest = delete + insert)
 *   - split             one output note into two truth notes whose durations add up, then each part whose pitch
 *                       differs from the original costs one more change pitch (1 + differing parts)
 *   - merge             two adjacent output notes into one truth note whose duration is their sum (1, plus 1 change
 *                       pitch if the truth pitch is neither of the two)
 * Trailing rests are ignored on both sides. Minimum by dynamic programming, ties broken in the order
 * substitute, split, merge, delete, insert (only matters for the per-operation counts, not for `edits`).
 */
export function editScript(truthEv: TickEvent[], outEv: TickEvent[]): EditResult {
  const T = truthEv.slice();
  const O = outEv.slice();
  while (T.length && T[T.length - 1].kind === 'rest') T.pop();
  while (O.length && O[O.length - 1].kind === 'rest') O.pop();
  const n = T.length;
  const m = O.length;
  const INF = 1e9;
  const subCost = (t: TickEvent, o: TickEvent): number => {
    if (t.kind !== o.kind) return INF;
    let c = t.ticks !== o.ticks ? 1 : 0;
    if (t.kind === 'note' && o.kind === 'note' && t.midi !== o.midi) c++;
    return c;
  };
  // dp[i][j]: cost of turning O[j:] into T[i:] (suffix form so the traceback runs forwards)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  dp[n][m] = 0;
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue;
      let best = INF;
      if (i < n && j < m) best = Math.min(best, subCost(T[i], O[j]) + dp[i + 1][j + 1]);
      if (i < n - 1 && j < m) {
        const o = O[j];
        const a = T[i];
        const b = T[i + 1];
        if (o.kind === 'note' && a.kind === 'note' && b.kind === 'note' && a.ticks + b.ticks === o.ticks) {
          best = Math.min(best, 1 + (a.midi !== o.midi ? 1 : 0) + (b.midi !== o.midi ? 1 : 0) + dp[i + 2][j + 1]);
        }
      }
      if (i < n && j < m - 1) {
        const a = O[j];
        const b = O[j + 1];
        const t = T[i];
        if (t.kind === 'note' && a.kind === 'note' && b.kind === 'note' && a.ticks + b.ticks === t.ticks) {
          best = Math.min(best, 1 + (t.midi !== a.midi && t.midi !== b.midi ? 1 : 0) + dp[i + 1][j + 2]);
        }
      }
      if (j < m) best = Math.min(best, 1 + dp[i][j + 1]);
      if (i < n) best = Math.min(best, 1 + dp[i + 1][j]);
      dp[i][j] = best;
    }
  }
  const counts: Record<EditOp, number> = { pitch: 0, duration: 0, insert: 0, delete: 0, split: 0, merge: 0 };
  const notePairs: [number, number][] = [];
  const noteIdx = (ev: TickEvent[]): number[] => {
    let c = 0;
    return ev.map((e) => (e.kind === 'note' ? c++ : -1));
  };
  const tIdx = noteIdx(T);
  const oIdx = noteIdx(O);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const cur = dp[i][j];
    if (i < n && j < m && subCost(T[i], O[j]) < INF && subCost(T[i], O[j]) + dp[i + 1][j + 1] === cur) {
      const t = T[i];
      const o = O[j];
      if (t.ticks !== o.ticks) counts.duration++;
      if (t.kind === 'note' && o.kind === 'note') {
        if (t.midi !== o.midi) counts.pitch++;
        notePairs.push([tIdx[i], oIdx[j]]);
      }
      i++;
      j++;
      continue;
    }
    if (i < n - 1 && j < m) {
      const o = O[j];
      const a = T[i];
      const b = T[i + 1];
      if (o.kind === 'note' && a.kind === 'note' && b.kind === 'note' && a.ticks + b.ticks === o.ticks) {
        const extra = (a.midi !== o.midi ? 1 : 0) + (b.midi !== o.midi ? 1 : 0);
        if (1 + extra + dp[i + 2][j + 1] === cur) {
          counts.split++;
          counts.pitch += extra;
          i += 2;
          j += 1;
          continue;
        }
      }
    }
    if (i < n && j < m - 1) {
      const a = O[j];
      const b = O[j + 1];
      const t = T[i];
      if (t.kind === 'note' && a.kind === 'note' && b.kind === 'note' && a.ticks + b.ticks === t.ticks) {
        const extra = t.midi !== a.midi && t.midi !== b.midi ? 1 : 0;
        if (1 + extra + dp[i + 1][j + 2] === cur) {
          counts.merge++;
          counts.pitch += extra;
          i += 1;
          j += 2;
          continue;
        }
      }
    }
    if (j < m && 1 + dp[i][j + 1] === cur) {
      counts.delete++;
      j++;
      continue;
    }
    counts.insert++;
    i++;
  }
  const edits = dp[0][0];
  const nTruthNotes = T.filter((e) => e.kind === 'note').length;
  const kb = keyboardSteps(T);
  return {
    edits,
    counts,
    nTruthNotes,
    nTruthEvents: n,
    editsPerNote: nTruthNotes ? edits / nTruthNotes : 0,
    keyboardSteps: kb,
    ratioToKeyboard: kb ? edits / kb : 0,
    notePairs,
  };
}

/* ------------------------------------------------------------------ rounded-note accuracy */

export interface QuantScores {
  nTruth: number;
  nOut: number;
  /** Fraction of truth notes for which an output note has the same start tick (position only). */
  startAcc: number;
  /** Same start tick and same pitch. */
  startPitchAcc: number;
  /** Same start tick and same duration. */
  startTicksAcc: number;
  /** Same start tick, duration and pitch ("all equal"). */
  exactAcc: number;
  /** Fraction of truth notes paired by the edit alignment (notePairs) whose pitch is equal (pitch only, timing ignored). */
  pitchOnlyAcc: number;
  /** exact matches / output notes. */
  exactPrecision: number;
  /** F of exactPrecision and exactAcc. */
  exactF: number;
}

export function quantScores(truth: TickNote[], out: TickNote[], pairs?: [number, number][]): QuantScores {
  const nT = truth.length;
  const nO = out.length;
  if (nT === 0) return { nTruth: 0, nOut: nO, startAcc: 0, startPitchAcc: 0, startTicksAcc: 0, exactAcc: 0, pitchOnlyAcc: 0, exactPrecision: 0, exactF: 0 };
  const byStart = new Map<number, TickNote>();
  for (const o of out) if (!byStart.has(o.startTick)) byStart.set(o.startTick, o);
  let s = 0;
  let sp = 0;
  let st = 0;
  let ex = 0;
  for (const t of truth) {
    const o = byStart.get(t.startTick);
    if (!o) continue;
    s++;
    if (o.midi === t.midi) sp++;
    if (o.ticks === t.ticks) st++;
    if (o.midi === t.midi && o.ticks === t.ticks) ex++;
  }
  const al = pairs ?? editScript(notesToEvents(truth), notesToEvents(out)).notePairs;
  const sortedT = [...truth].sort((x, y) => x.startTick - y.startTick);
  const sortedO = [...out].sort((x, y) => x.startTick - y.startTick);
  let po = 0;
  for (const [ti, oi] of al) if (sortedT[ti].midi === sortedO[oi].midi) po++;
  const exactPrecision = nO ? ex / nO : 0;
  const exactAcc = ex / nT;
  return { nTruth: nT, nOut: nO, startAcc: s / nT, startPitchAcc: sp / nT, startTicksAcc: st / nT, exactAcc, pitchOnlyAcc: po / nT, exactPrecision, exactF: fMeasure(exactPrecision, exactAcc) };
}

/* ------------------------------------------------------------------ candidates */

/**
 * Grid candidate hit rate: of the truth notes paired with an output note by the edit alignment, the fraction whose
 * truth (startTick, ticks) is among the first k of [chosen, ...gridCandidates]. Denominator: all truth notes
 * (unpaired = miss). k = 1 is the plain "chosen position is right" rate.
 */
export function gridCandidateHit(
  truth: TickNote[],
  out: { startTick: number; ticks: number; midi: number; gridCandidates?: { startTick: number; ticks: number }[] }[],
  k: number,
): number {
  if (truth.length === 0) return 0;
  const T = notesToEvents(truth);
  const O = notesToEvents(out);
  const r = editScript(T, O);
  const sortedT = [...truth].sort((a, b) => a.startTick - b.startTick);
  const sortedO = [...out].sort((a, b) => a.startTick - b.startTick);
  let hit = 0;
  for (const [ti, oi] of r.notePairs) {
    const t = sortedT[ti];
    const o = sortedO[oi];
    const list = [{ startTick: o.startTick, ticks: o.ticks }, ...(o.gridCandidates ?? [])].slice(0, k);
    if (list.some((c) => c.startTick === t.startTick && c.ticks === t.ticks)) hit++;
  }
  return hit / truth.length;
}

/**
 * Pitch candidate hit rate (seconds domain): truth notes are paired with estimated notes by a maximum matching on
 * onset only (|d| <= onsetTol, default 100 ms); a truth note is a hit when its `midi` is among the first k of
 * [midi, ...candidates.midi]. Denominator: all truth notes. k = 1 is the plain pitch-name accuracy at matched onsets.
 */
export function pitchCandidateHit(truth: ScoreNote[], est: Pick<HumNote, 'start' | 'end' | 'midi' | 'candidates'>[], k: number, onsetTol = 0.1): number {
  if (truth.length === 0) return 0;
  const pairs = matchNotes(truth, est.map((e) => ({ start: e.start, end: e.end, midi: e.midi })), { offsetRatio: null, pitchMode: 'any', onsetTol });
  let hit = 0;
  for (const [ti, ei] of pairs) {
    const e = est[ei];
    const list = [e.midi, ...e.candidates.map((c) => c.midi)].slice(0, k);
    if (list.includes(truth[ti].midi)) hit++;
  }
  return hit / truth.length;
}

/* ------------------------------------------------------------------ global transposition */

export const MAX_SHIFT = 24;

/**
 * The integer semitone shift s (-24..24, octaves included) that, subtracted from the estimate, makes most
 * onset-matched pairs agree in pitch: pairs are `pairs` = (truthMidi, estMidi) from an onset-only matching; the
 * shift maximizing #{estMidi - truthMidi === s} wins, ties -> smallest |s|, then the lower value (negative first).
 * No pairs -> 0. The ±1-semitone neighbours of a pair are not counted: this is a mode, not a tolerance.
 */
export function chooseShift(pairs: [number, number][], maxShift = MAX_SHIFT): number {
  const hist = new Map<number, number>();
  for (const [t, e] of pairs) {
    const d = e - t;
    if (Math.abs(d) <= maxShift) hist.set(d, (hist.get(d) ?? 0) + 1);
  }
  let best = 0;
  let bestN = hist.get(0) ?? 0;
  for (const [d, n] of hist) {
    if (n > bestN || (n === bestN && (Math.abs(d) < Math.abs(best) || (Math.abs(d) === Math.abs(best) && d < best)))) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Shift from seconds-domain notes (onset-only matching, onsets within `onsetTol`, pitch ignored). */
export function estimateShift(truth: ScoreNote[], est: Pick<ScoreNote, 'start' | 'end' | 'midi' | 'cents'>[], onsetTol = 0.1): number {
  if (truth.length === 0 || est.length === 0) return 0;
  const pairs = matchNotes(truth, est, { offsetRatio: null, pitchMode: 'any', onsetTol });
  return chooseShift(pairs.map(([i, j]) => [truth[i].midi, est[j].midi]));
}

/** Shift from tick-domain notes (same start tick = a pair). Used when only the rounded result exists. */
export function estimateShiftTicks(truth: TickNote[], out: TickNote[]): number {
  const byStart = new Map<number, TickNote>();
  for (const o of out) if (!byStart.has(o.startTick)) byStart.set(o.startTick, o);
  const pairs: [number, number][] = [];
  for (const t of truth) {
    const o = byStart.get(t.startTick);
    if (o) pairs.push([t.midi, o.midi]);
  }
  return chooseShift(pairs);
}

/** 'zero' | 'octave' (a non-zero multiple of 12) | 'other': the only thing reported about the shift for recordings. */
export function shiftClass(s: number): 'zero' | 'octave' | 'other' {
  return s === 0 ? 'zero' : s % 12 === 0 ? 'octave' : 'other';
}
/** Numeric code of shiftClass for score rows: 0 zero, 1 octave, 2 other. */
export const SHIFT_CLASS_CODE = { zero: 0, octave: 1, other: 2 } as const;

/** Copy of the analyzer notes with the estimated global shift removed (midi and candidate midis). */
export function unshiftNotes<T extends { midi: number; candidates?: { midi: number }[] }>(notes: T[], s: number): T[] {
  if (s === 0) return notes;
  return notes.map((n) => ({ ...n, midi: n.midi - s, ...(n.candidates ? { candidates: n.candidates.map((c) => ({ ...c, midi: c.midi - s })) } : {}) }));
}
/** Same for a quantized melody. */
export function unshiftQuantized<Q extends { events: unknown[] }>(q: Q, s: number): Q {
  if (s === 0) return q;
  const events = (q.events as { kind: string; midi?: number; candidates?: { midi: number }[] }[]).map((e) =>
    e.kind === 'note' ? { ...e, midi: e.midi! - s, candidates: (e.candidates ?? []).map((c) => ({ ...c, midi: c.midi - s })) } : e,
  );
  return { ...q, events } as Q;
}
