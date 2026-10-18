/**
 * Spike 4 T6: beat grid and quantization (docs/audio-spike4-plan.md section 2 "beat grid" / "quantization",
 * decision 5, design decision 6).
 *
 * Input: seconds-domain notes (HumNote, or anything with start/end/midi) + HumInfo (bpm, ts, startSec of bar 1
 * beat 1, all given by the user, never estimated). Output: a gapless QuantizedMelody from tick 0.
 *
 * Rules, in order (all in ticks of src/lib/melody.ts, whole = 64, 16th = 4):
 *  1. Grid: beat = 64 / ts[1] ticks, bpm counts that beat, tick = 60 / (bpm * beatTicks) s, tick 0 = startSec.
 *     Step = 64 / grid.subdivision ticks (16 -> a 16th).
 *  1b. Grid phase (grid.phaseSearch, spike 4 step 2): the given bar-1 head is approximate (the user writes the
 *     approximate second of the first sung note). Over whole grid steps k with |k * step| <= phaseRangeBeats beats,
 *     the analyzer picks the offset that best explains the detected onsets (never the truth):
 *       score(k) = sum_i w_i * phaseLevelWeights[metricLevel(slot_i - k step)]           (onsets on beats / strong slots)
 *                  - (k step / beat)^2 / (2 phasePriorBeats^2)                           (stay near the given head;
 *                    phaseBarPriorBeats instead when only a bar-1 head was given: `小節頭:` is meant to be exact)
 *                  - phaseAnchorWeight * min(d_k, 1 beat)^2 / (2 phaseAnchorBeats^2)      (first note, when known)
 *     slot_i = the onset's nearest grid point after the sub-step bias (rule 2's estimator, which is step-periodic and
 *     so the same for every k), w_i = exp(-r_i^2 / (2 (0.2 step)^2)) (r_i its residual) times (0.5 + 0.5 min(1,
 *     duration / beat)) (long notes weigh more). The anchor: with info.firstNoteSec, the first detected note starting
 *     after firstNoteSec - phaseRangeBeats beats is the first sung note; d_k = its distance (beats) to firstNoteTick
 *     (0 when unknown: the first note is then bar 1 beat 1 and ticks count from its beat). Ties go to the smaller |k|. The bar-1 head becomes
 *     startSec + k * step * tickSec (QuantizedMelody.startSec; givenStartSec / phaseOffsetSec record the search);
 *     k = 0 reproduces the result without the search exactly.
 *  2. Onset bias (grid.onsetBias): the singer's habitual early/late offset b, in ticks. Default ('local'): start at
 *     b = 0 and move b by the median of the residuals of (onset - b) to the nearest grid point until it settles,
 *     |b| <= min(maxBiasSec, 0.45 step). Converging from 0 keeps a bias near half a step from flipping to the other
 *     side (the global alternative 'trunc', argmin of sum min(r^2, (0.35 step)^2), flipped on noisy takes).
 *     Needs >= minBiasNotes notes, else b = 0. b is removed from every onset AND end before rounding
 *     (QuantizedMelody.onsetBiasSec = b in seconds, positive = sang late).
 *  3. Onsets snap to the nearest grid point (ties up), clamped to >= 0 (a note sung before bar 1 starts at 0).
 *  4. Collisions (two onsets on one slot): move the later note one step later, or the earlier one step earlier,
 *     whichever raw onset is closer to its new slot and leaves the neighbours strictly ordered; if neither fits,
 *     the two notes are merged into one (pitch/src of the longer sung note, start of the first, end of the last).
 *  5. Ends: if the sung gap to the next onset is < grid.legatoGapEighths eighths, the note is legato and ends at
 *     the next onset (no rest). Otherwise (and for the last note) the end is a "free end": it rounds to the nearest
 *     grid point, kept >= onset + minNoteSteps steps and <= next onset - 1 step (a rest is at least one step; when
 *     there is no room for a rest the note becomes legato). Singers cut notes before a rest short, so a free end
 *     moves on to the first later grid point that is a beat or stronger (beat < half bar < bar line) and stronger
 *     than the rounded point, if that is at most endExtendFraction * (sung duration) after the sung end and still
 *     leaves the rest (tuned on the synthetic tuning split: 0.3; checked on dev).
 *  6. Minimum length: every note is >= minNoteSteps grid steps (onsets are strictly increasing after rule 4).
 *  7. Events: a leading rest from tick 0 to the first onset, notes, a rest in each gap, and (padLastBar) a final
 *     rest to the end of the last bar. Notes crossing a bar line stay one event (ties are toMelody's job).
 *  8. Candidates (design decision 6, at most grid.candidatesMax, best first, the chosen position excluded):
 *     the other neighbouring onset slot (end kept) and, for a free end, the other neighbouring end slot. The
 *     probabilities come from a Gaussian on the residual with the recording's onset spread sigma (1.4826 * MAD of
 *     the onset residuals after the bias, floored at 0.25 step): p = g(d1) / (g(d1) + g(d2)).
 *     QuantizedNote.confidence = source confidence * p(chosen onset).
 *  9. Triplet switch (grid.triplet, default off): per beat (a quarter, 16 ticks), when the onsets in that beat fit
 *     the 8th-triplet grid {0, 16/3, 32/3} with less than tripletMargin of the 16th-grid error and use an off-beat
 *     triplet slot, the beat becomes one 8th triplet: each of the 3 slots is one note or rest of written 8 ticks
 *     (`tuplet: {n: 3, slot}`, startTick = the real, fractional position). Only when it fits the app model: the
 *     previous note ends at the beat start, no note sustains over two slots or out of the beat (else 16th kept).
 *     Synthetic truths never contain triplets, so this only measures false positives.
 */
import { DEFAULT_HUM_CONFIG, type HumConfig } from './config';
import { WHOLE_TICKS, type PitchCandidate, type QuantCandidate, type QuantizedEvent, type QuantizedMelody, type QuantizedNote } from './types';

export type GridConfig = HumConfig['grid'];

/** Note fields quantize() reads. HumNote satisfies it; truth notes too (their extra tick fields are ignored). */
export interface QuantizeInputNote {
  start: number;
  end: number;
  midi: number;
  confidence?: number;
  candidates?: PitchCandidate[];
}

/** Rule constants; cfg.grid carries the same keys since T9 (gridOptions), `options` overrides them. */
export interface QuantizeOptions {
  /** Free end: move to a later strong grid point (beat or stronger, stronger than the nearest point) when it is at
   *  most endExtendFraction * sung duration after the sung end (rule 5; 0 = off). */
  endExtendFraction: number;
  /** Bias estimator: 'local' = iterative median of the wrapped residuals from b = 0, 'trunc' = global truncated LS. */
  biasMethod: 'local' | 'trunc';
  /** Minimum note length in grid steps (rule 6). */
  minNoteSteps: number;
  /** Bias search bound in seconds (also <= 0.45 step) and the minimum note count to estimate it (rule 2). */
  maxBiasSec: number;
  minBiasNotes: number;
  /** Fill the last bar with a rest (rule 7). */
  padLastBar: boolean;
  /** Triplet beat when its error < tripletMargin * the 16th error (rule 9). */
  tripletMargin: number;
  /** Grid phase search (rule 1b): on/off, range and prior (beats), score per metric level 0..4, first-note anchor. */
  phaseSearch: boolean;
  phaseRangeBeats: number;
  phasePriorBeats: number;
  /** Prior sigma (beats) when only the bar-1 head was given (no firstNoteSec: `小節頭:` / synthetic exact start). */
  phaseBarPriorBeats: number;
  phaseLevelWeights: number[];
  phaseAnchorBeats: number;
  phaseAnchorWeight: number;
}

export const DEFAULT_QUANTIZE_OPTIONS: Readonly<QuantizeOptions> = Object.freeze({
  endExtendFraction: 0.3,
  biasMethod: 'local' as const,
  minNoteSteps: 1,
  maxBiasSec: 0.08,
  minBiasNotes: 4,
  padLastBar: true,
  tripletMargin: 0.5,
  phaseSearch: false,
  phaseRangeBeats: 1.5,
  phasePriorBeats: 0.75,
  phaseBarPriorBeats: 0.05,
  phaseLevelWeights: [0, 0.5, 1, 1.05, 1.1],
  phaseAnchorBeats: 0.25,
  phaseAnchorWeight: 10,
}) as Readonly<QuantizeOptions>;

/**
 * What quantize() needs to know about the start: the (approximate) bar-1 head, and optionally the approximate
 * second of the first sung note with its bar position (ticks; undefined = "on some beat"), for the phase anchor.
 */
export interface QuantizeInfo {
  bpm: number;
  ts: [number, number];
  startSec: number;
  firstNoteSec?: number;
  firstNoteTick?: number;
}

/** The QuantizeOptions a grid config carries (cfg.grid, T9); keys a hand-made grid object leaves out keep the defaults. */
export function gridOptions(grid: Partial<GridConfig>): Partial<QuantizeOptions> {
  const out: Partial<QuantizeOptions> = {};
  for (const k of Object.keys(DEFAULT_QUANTIZE_OPTIONS) as (keyof QuantizeOptions)[]) {
    const v = (grid as Record<string, unknown>)[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  }
  if (out.biasMethod !== undefined && out.biasMethod !== 'local' && out.biasMethod !== 'trunc') throw new RangeError(`bad grid.biasMethod: ${String(out.biasMethod)}`);
  return out;
}

/** A quantized event that may be an 8th-triplet slot (triplet switch only). `ticks` is then the written 8. */
export type TupletTag = { tuplet?: { n: 3; slot: number } };
export type QuantizedEventT = QuantizedEvent & TupletTag;

export interface BeatGrid {
  bpm: number;
  ts: [number, number];
  startSec: number;
  /** Seconds per tick. */
  tickSec: number;
  beatTicks: number;
  barTicks: number;
  /** Grid step in ticks (4 = a 16th). */
  stepTicks: number;
}

export function beatGrid(info: Pick<QuantizeInfo, 'bpm' | 'ts' | 'startSec'>, grid: Pick<GridConfig, 'subdivision'> = DEFAULT_HUM_CONFIG.grid): BeatGrid {
  const [num, den] = info.ts;
  if (!(info.bpm > 0) || !Number.isFinite(info.bpm)) throw new RangeError(`bad bpm: ${info.bpm}`);
  if (!Number.isInteger(num) || num <= 0 || !Number.isInteger(den) || den <= 0 || WHOLE_TICKS % den !== 0) throw new RangeError(`bad time signature: ${num}/${den}`);
  if (!Number.isInteger(grid.subdivision) || grid.subdivision <= 0 || WHOLE_TICKS % grid.subdivision !== 0 || (WHOLE_TICKS / grid.subdivision) % 2 !== 0)
    throw new RangeError(`bad grid subdivision: ${grid.subdivision}`);
  const beatTicks = WHOLE_TICKS / den;
  return {
    bpm: info.bpm,
    ts: [num, den],
    startSec: info.startSec,
    tickSec: 60 / (info.bpm * beatTicks),
    beatTicks,
    barTicks: num * beatTicks,
    stepTicks: WHOLE_TICKS / grid.subdivision,
  };
}

/** x - step * round(x / step): residual to the nearest multiple of `step`, in [-step/2, step/2). */
export function wrapResidual(x: number, step: number): number {
  return x - step * Math.floor(x / step + 0.5);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Rule 2: the onset bias in TICKS for raw onset positions `u` (ticks from bar 1, bias not removed).
 * Truncated least squares on the grid phase over |b| <= maxTicks, then the inlier median refinement.
 */
export function estimateOnsetBiasTicks(u: number[], stepTicks: number, maxTicks: number): number {
  const c = 0.35 * stepTicks;
  const cost = (b: number) => u.reduce((s, x) => s + Math.min(wrapResidual(x - b, stepTicks) ** 2, c * c), 0) + 1e-9 * b * b;
  const n = 200;
  let best = 0;
  let bestCost = cost(0);
  for (let k = -n; k <= n; k++) {
    const b = (k / n) * maxTicks;
    const v = cost(b);
    if (v < bestCost - 1e-12) {
      bestCost = v;
      best = b;
    }
  }
  const inl = u.map((x) => wrapResidual(x - best, stepTicks)).filter((r) => Math.abs(r) < c);
  if (inl.length === 0) return best;
  return Math.max(-maxTicks, Math.min(maxTicks, best + median(inl)));
}

/**
 * Rule 2 ('local', default): start at b = 0 and repeatedly move b by the median of the residuals of (u - b) to the
 * nearest grid point, clamped to |b| <= maxTicks. Converges to the phase nearest to "no bias", so a bias near half a
 * step is not flipped to the other side (the global estimator does that on noisy takes).
 */
export function estimateOnsetBiasLocal(u: number[], stepTicks: number, maxTicks: number): number {
  let b = 0;
  for (let it = 0; it < 20; it++) {
    const nb = Math.max(-maxTicks, Math.min(maxTicks, b + median(u.map((x) => wrapResidual(x - b, stepTicks)))));
    if (Math.abs(nb - b) < 1e-9) break;
    b = nb;
  }
  return b;
}

interface Work {
  /** Raw onset/end in ticks after the bias removal. */
  u: number;
  v: number;
  midi: number;
  src: number;
  confidence: number;
  candidates: PitchCandidate[];
  /** Snapped onset. */
  s: number;
}

const roundTo = (x: number, step: number) => step * Math.floor(x / step + 0.5);

export interface QuantizeReport {
  melody: QuantizedMelody;
  /** Onset spread (s) used for confidences. */
  sigmaSec: number;
  /** Notes merged away by collisions (rule 4). */
  merged: number;
  /** Collisions solved by moving a note one step (rule 4). */
  moved: number;
  /** Beats written as triplets (rule 9). */
  tripletBeats: number;
  /** Grid offset chosen by rule 1b, in steps (0 when off). */
  phaseSteps: number;
  warnings: string[];
}

/** quantizeDetailed(...).melody. */
export function quantize(notes: readonly QuantizeInputNote[], info: QuantizeInfo, grid: GridConfig = DEFAULT_HUM_CONFIG.grid, options: Partial<QuantizeOptions> = {}): QuantizedMelody {
  return quantizeDetailed(notes, info, grid, options).melody;
}

export function quantizeDetailed(
  notes: readonly QuantizeInputNote[],
  info: QuantizeInfo,
  grid: GridConfig = DEFAULT_HUM_CONFIG.grid,
  options: Partial<QuantizeOptions> = {},
): QuantizeReport {
  const opt: QuantizeOptions = { ...DEFAULT_QUANTIZE_OPTIONS, ...gridOptions(grid), ...options };
  const g0 = beatGrid(info, grid);
  const step = g0.stepTicks;
  const warnings: string[] = [];

  const order = notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => Number.isFinite(n.start) && Number.isFinite(n.end) && n.end > n.start)
    .sort((a, b) => a.n.start - b.n.start || a.i - b.i);
  if (order.length < notes.length) warnings.push(`${notes.length - order.length} note(s) with end <= start were ignored`);

  const maxBiasTicks = Math.min(opt.maxBiasSec / g0.tickSec, 0.45 * step);
  const biasOf = (u: number[]) =>
    grid.onsetBias && u.length >= opt.minBiasNotes ? (opt.biasMethod === 'local' ? estimateOnsetBiasLocal(u, step, maxBiasTicks) : estimateOnsetBiasTicks(u, step, maxBiasTicks)) : 0;

  // ---- rule 1b: grid phase (whole steps)
  let phaseSteps = 0;
  if (opt.phaseSearch) {
    const toTick0 = (sec: number) => (sec - g0.startSec) / g0.tickSec;
    const u0 = order.map(({ n }) => toTick0(n.start));
    const b0 = biasOf(u0);
    let anchor: { u: number; target: number } | undefined;
    if (info.firstNoteSec !== undefined && Number.isFinite(info.firstNoteSec)) {
      const from = info.firstNoteSec - opt.phaseRangeBeats * g0.beatTicks * g0.tickSec;
      const first = order.find(({ n }) => n.start >= from);
      // without firstNoteTick the first note is taken as bar 1 beat 1 (tick 0): ticks then count from its beat
      if (first) anchor = { u: toTick0(first.n.start) - b0, target: info.firstNoteTick !== undefined && Number.isFinite(info.firstNoteTick) ? info.firstNoteTick : 0 };
    }
    phaseSteps = estimateGridPhaseSteps(
      u0.map((u) => u - b0),
      order.map(({ n }) => (n.end - n.start) / g0.tickSec),
      g0,
      info.firstNoteSec !== undefined ? opt : { ...opt, phasePriorBeats: opt.phaseBarPriorBeats },
      anchor,
    );
  }
  const g: BeatGrid = phaseSteps === 0 ? g0 : { ...g0, startSec: g0.startSec + phaseSteps * step * g0.tickSec };
  const toTick = (sec: number) => (sec - g.startSec) / g.tickSec;

  // ---- rule 2: bias
  const rawU = order.map(({ n }) => toTick(n.start));
  const biasTicks = biasOf(rawU);

  const work: Work[] = order.map(({ n, i }) => ({
    u: toTick(n.start) - biasTicks,
    v: toTick(n.end) - biasTicks,
    midi: n.midi,
    src: i,
    confidence: n.confidence ?? 1,
    candidates: n.candidates ? [...n.candidates] : [],
    s: Math.max(0, roundTo(toTick(n.start) - biasTicks, step)),
  }));

  // onset spread (after the bias), for confidences
  const res = work.map((w) => w.u - roundTo(w.u, step));
  const sigma = Math.max(0.25 * step, 1.4826 * median(res.map(Math.abs)));

  // ---- rule 4: collisions
  let merged = 0;
  let moved = 0;
  const out: Work[] = [];
  for (let k = 0; k < work.length; k++) {
    const w = work[k];
    const prev = out[out.length - 1];
    if (!prev || w.s > prev.s) {
      out.push(w);
      continue;
    }
    // w.s <= prev.s
    const nextS = k + 1 < work.length ? work[k + 1].s : Infinity;
    const later = prev.s + step;
    const optA = later < nextS ? Math.abs(w.u - later) : Infinity;
    const pp = out[out.length - 2];
    const earlier = prev.s - step;
    const optB = earlier >= 0 && (!pp || earlier > pp.s) && w.s === prev.s ? Math.abs(prev.u - earlier) : Infinity;
    if (optA === Infinity && optB === Infinity) {
      // merge
      const keepW = w.v - w.u > prev.v - prev.u;
      const m: Work = {
        ...(keepW ? w : prev),
        u: Math.min(prev.u, w.u),
        v: Math.max(prev.v, w.v),
        s: prev.s,
        confidence: Math.min(prev.confidence, w.confidence),
      };
      out[out.length - 1] = m;
      merged++;
      continue;
    }
    if (optA <= optB) w.s = later;
    else prev.s = earlier;
    moved++;
    out.push(w);
  }
  if (merged) warnings.push(`${merged} note(s) merged: two onsets on one grid slot`);

  // ---- rule 5/6: ends
  const minLen = opt.minNoteSteps * step;
  const legatoTicks = grid.legatoGapEighths * 8;
  const ends: number[] = [];
  const freeEnd: boolean[] = [];
  const endAlt: (number | null)[] = [];
  const endP: number[] = [];
  for (let k = 0; k < out.length; k++) {
    const w = out[k];
    const next = out[k + 1];
    const lo = w.s + minLen;
    if (next && next.u - w.v < legatoTicks) {
      ends.push(next.s);
      freeEnd.push(false);
      endAlt.push(null);
      endP.push(1);
      continue;
    }
    const target = w.v;
    const hi = next ? next.s - step : Infinity;
    if (next && hi < lo) {
      ends.push(next.s);
      freeEnd.push(false);
      endAlt.push(null);
      endP.push(1);
      continue;
    }
    let e0 = roundTo(target, step);
    if (opt.endExtendFraction > 0) {
      const reach = w.v + opt.endExtendFraction * (w.v - w.u);
      const lv0 = metricLevel(e0, g);
      for (let p = e0 + step; p <= Math.min(reach, hi) + 1e-9; p += step) {
        const lv = metricLevel(p, g);
        if (lv >= 2 && lv > lv0) {
          e0 = p;
          break;
        }
      }
    }
    const e = Math.min(hi, Math.max(lo, e0));
    const alt = target >= e ? e + step : e - step;
    const altOk = alt >= lo && alt <= hi;
    ends.push(e);
    freeEnd.push(true);
    endAlt.push(altOk ? alt : null);
    endP.push(altOk ? gaussShare(target - e, target - alt, sigma) : 1);
  }

  // ---- events
  const events: QuantizedEventT[] = [];
  let t = 0;
  for (let k = 0; k < out.length; k++) {
    const w = out[k];
    if (w.s > t) events.push({ kind: 'rest', startTick: t, ticks: w.s - t });
    const e = ends[k];
    const cands: QuantCandidate[] = [];
    // onset alternative (end kept)
    const r = w.u - w.s;
    const altS = r >= 0 ? w.s + step : w.s - step;
    const prevS = k > 0 ? out[k - 1].s : -Infinity;
    const pOn = gaussShare(r, w.u - altS, sigma);
    if (altS >= 0 && altS > prevS && altS <= e - minLen) cands.push({ startTick: altS, ticks: e - altS, confidence: round3(1 - pOn) });
    if (freeEnd[k] && endAlt[k] !== null) cands.push({ startTick: w.s, ticks: endAlt[k]! - w.s, confidence: round3(1 - endP[k]) });
    cands.sort((a, b) => b.confidence - a.confidence);
    const note: QuantizedNote = {
      kind: 'note',
      startTick: w.s,
      ticks: e - w.s,
      midi: w.midi,
      src: w.src,
      candidates: w.candidates,
      gridCandidates: cands.slice(0, grid.candidatesMax),
      confidence: round3(w.confidence * pOn),
    };
    events.push(note);
    t = e;
  }
  if (opt.padLastBar && t % g.barTicks !== 0 && events.length > 0) {
    const endBar = Math.ceil(t / g.barTicks) * g.barTicks;
    events.push({ kind: 'rest', startTick: t, ticks: endBar - t });
  }

  // ---- rule 9: triplets
  let tripletBeats = 0;
  let finalEvents: QuantizedEventT[] = events;
  if (grid.triplet) {
    const r9 = applyTriplets(events, out, ends, opt.tripletMargin);
    finalEvents = r9.events;
    tripletBeats = r9.beats;
  }

  return {
    melody: {
      bpm: g.bpm,
      ts: [g.ts[0], g.ts[1]],
      startSec: round6(g.startSec),
      onsetBiasSec: round6(biasTicks * g.tickSec),
      ...(opt.phaseSearch ? { givenStartSec: g0.startSec, phaseOffsetSec: round6(phaseSteps * step * g0.tickSec) } : {}),
      grid: grid.triplet && tripletBeats > 0 ? 'triplet' : 'sixteenth',
      events: finalEvents,
    },
    sigmaSec: round6(sigma * g.tickSec),
    merged,
    moved,
    tripletBeats,
    phaseSteps,
    warnings,
  };
}

/**
 * Rule 1b: the grid offset in whole steps (positive = bar 1 later than given). `u` = onsets in ticks from the given
 * head with the sub-step bias already removed, `dur` = note lengths in ticks, `anchor` = the first sung note's onset
 * (same ticks) and its expected tick. See the header for the score.
 */
export function estimateGridPhaseSteps(
  u: readonly number[],
  dur: readonly number[],
  g: Pick<BeatGrid, 'barTicks' | 'beatTicks' | 'ts' | 'stepTicks'>,
  opt: Pick<QuantizeOptions, 'phaseRangeBeats' | 'phasePriorBeats' | 'phaseLevelWeights' | 'phaseAnchorBeats' | 'phaseAnchorWeight'>,
  anchor?: { u: number; target: number },
): number {
  const step = g.stepTicks;
  const K = Math.floor((opt.phaseRangeBeats * g.beatTicks) / step + 1e-9);
  if (K <= 0) return 0;
  const sr = 0.2 * step;
  const slots = u.map((x) => roundTo(x, step));
  const w = u.map((x, i) => Math.exp(-((x - slots[i]) ** 2) / (2 * sr * sr)) * (0.5 + 0.5 * Math.min(1, Math.max(0, dur[i] ?? 0) / g.beatTicks)));
  const W = (lv: number) => opt.phaseLevelWeights[Math.min(lv, opt.phaseLevelWeights.length - 1)] ?? 0;
  const mod = (x: number, m: number) => ((x % m) + m) % m;
  let best = 0;
  let bestScore = -Infinity;
  for (let a = 0; a <= 2 * K; a++) {
    const k = a % 2 === 0 ? a / 2 : -(a + 1) / 2; // 0, -1, 1, -2, 2 ... (ties keep the smaller |k|)
    const shift = k * step;
    let sc = 0;
    slots.forEach((sl, i) => {
      sc += w[i] * W(metricLevel(mod(sl - shift, g.barTicks), g));
    });
    const kb = shift / g.beatTicks;
    if (opt.phasePriorBeats > 0) sc -= (kb * kb) / (2 * opt.phasePriorBeats ** 2);
    if (anchor && opt.phaseAnchorWeight > 0 && opt.phaseAnchorBeats > 0) {
      const pos = anchor.u - shift;
      const d = Math.min(1, Math.abs(pos - anchor.target) / g.beatTicks);
      sc -= (opt.phaseAnchorWeight * d * d) / (2 * opt.phaseAnchorBeats ** 2);
    }
    if (sc > bestScore + 1e-9) {
      bestScore = sc;
      best = k;
    }
  }
  return best;
}

/** Metric strength of a tick position: 4 bar line, 3 half bar (even numerators), 2 beat, 1 eighth, 0 else. */
export function metricLevel(tick: number, g: Pick<BeatGrid, 'barTicks' | 'beatTicks' | 'ts'>): number {
  if (tick % g.barTicks === 0) return 4;
  if (g.ts[0] % 2 === 0 && g.ts[0] > 2 && tick % (g.barTicks / 2) === 0) return 3;
  if (tick % g.beatTicks === 0) return 2;
  if (tick % 8 === 0) return 1;
  return 0;
}

/** Probability share of the residual d1 against d2 under a zero-mean Gaussian of sigma (rule 8). */
function gaussShare(d1: number, d2: number, sigma: number): number {
  const a = Math.exp(-(d1 * d1) / (2 * sigma * sigma));
  const b = Math.exp(-(d2 * d2) / (2 * sigma * sigma));
  return a + b === 0 ? (Math.abs(d1) <= Math.abs(d2) ? 1 : 0) : a / (a + b);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

const TRIPLET_BEAT = 16;
const TRIPLET_SLOT = TRIPLET_BEAT / 3;

/**
 * Rule 9. `notes`/`ends` are the 16th-grid result (notes with raw onsets `u`). A beat [B, B+16) is replaced
 * when (a) its onsets (raw, nearest-16th assignment) fit the triplet grid clearly better, (b) at least one uses
 * slot 1 or 2, (c) the result fits the model: an onset or a rest at every slot, the note before the beat ends at
 * B, every note in the beat lasts exactly one slot and the last one ends at B+16 or before a rest.
 */
function applyTriplets(events: QuantizedEventT[], notes: Work[], ends: number[], margin: number): { events: QuantizedEventT[]; beats: number } {
  // beats that contain onsets
  const byBeat = new Map<number, number[]>();
  notes.forEach((w, k) => {
    const B = Math.floor(w.s / TRIPLET_BEAT) * TRIPLET_BEAT;
    if (!byBeat.has(B)) byBeat.set(B, []);
    byBeat.get(B)!.push(k);
  });
  const replace = new Map<number, QuantizedEventT[]>(); // beat start -> events of the beat
  for (const [B, ks] of byBeat) {
    if (ks.length < 2) continue;
    let e16 = 0;
    let e3 = 0;
    const slots: number[] = [];
    for (const k of ks) {
      const x = notes[k].u - B;
      e16 += Math.abs(x - roundTo(x, 4));
      const sl = Math.round(x / TRIPLET_SLOT);
      e3 += Math.abs(x - sl * TRIPLET_SLOT);
      slots.push(sl);
    }
    if (!(e3 < margin * e16)) continue;
    if (!slots.some((s) => s === 1 || s === 2)) continue;
    if (slots.some((s) => s < 0 || s > 2) || new Set(slots).size !== slots.length) continue;
    // previous note must end at B (not sustain into the beat)
    const first = ks[0];
    if (first > 0 && ends[first - 1] > B) continue;
    let ok = true;
    const beatEvents: QuantizedEventT[] = [];
    for (let sl = 0; sl < 3 && ok; sl++) {
      const idx = slots.indexOf(sl);
      const pos = B + sl * TRIPLET_SLOT;
      if (idx >= 0) {
        const k = ks[idx];
        const nextSlotHasOnset = slots.includes(sl + 1);
        const endsHere = sl === 2 ? ends[k] <= B + TRIPLET_BEAT || false : nextSlotHasOnset || ends[k] <= B + (sl + 1) * TRIPLET_SLOT + 2;
        if (sl === 2 && ends[k] > B + TRIPLET_BEAT) ok = false;
        if (!endsHere) ok = false;
        const src = events.find((e) => e.kind === 'note' && e.src === notes[k].src) as QuantizedNote;
        beatEvents.push({ ...src, startTick: pos, ticks: 8, gridCandidates: [], tuplet: { n: 3, slot: sl } });
      } else {
        // empty slot: must be silent (no note sounding)
        const sounding = ks.some((k, j) => slots[j] < sl && ends[k] > pos + 0.5) || (first > 0 && sl === 0 && ends[first - 1] > B);
        if (sounding) ok = false;
        beatEvents.push({ kind: 'rest', startTick: pos, ticks: 8, tuplet: { n: 3, slot: sl } });
      }
    }
    if (ok) replace.set(B, beatEvents);
  }
  if (replace.size === 0) return { events, beats: 0 };
  // rebuild: events outside replaced beats are cut at the beat boundaries
  const outEv: QuantizedEventT[] = [];
  const beats = [...replace.keys()].sort((a, b) => a - b);
  const inBeat = (t: number) => beats.find((B) => t >= B && t < B + TRIPLET_BEAT);
  for (const e of events) {
    let s = e.startTick;
    const end = e.startTick + e.ticks;
    while (s < end) {
      const B = inBeat(s);
      if (B !== undefined) {
        s = B + TRIPLET_BEAT;
        continue;
      }
      const nextB = beats.find((b) => b > s && b < end);
      const segEnd = nextB ?? end;
      if (e.kind === 'note' && s !== e.startTick) {
        // a note's tail after a triplet beat cannot exist (rule c), but rests can be split
        outEv.push({ kind: 'rest', startTick: s, ticks: segEnd - s });
      } else outEv.push({ ...e, startTick: s, ticks: segEnd - s });
      s = segEnd;
    }
  }
  for (const B of beats) outEv.push(...replace.get(B)!);
  outEv.sort((a, b) => a.startTick - b.startTick);
  // merge adjacent plain rests
  const merged: QuantizedEventT[] = [];
  for (const e of outEv) {
    const p = merged[merged.length - 1];
    if (p && p.kind === 'rest' && e.kind === 'rest' && !p.tuplet && !e.tuplet && p.startTick + p.ticks === e.startTick) p.ticks += e.ticks;
    else merged.push(e);
  }
  return { events: merged, beats: replace.size };
}

/** Real length of an event in ticks (a triplet slot of written 8 is 16/3). */
export function realTicks(e: QuantizedEventT): number {
  return e.tuplet ? (e.ticks * 2) / 3 : e.ticks;
}

/** Checks the QuantizedMelody invariants: consecutive from 0, positive even ticks (triplet slots: written 8). */
export function checkQuantized(q: QuantizedMelody): string[] {
  const errs: string[] = [];
  let t = 0;
  q.events.forEach((e0, i) => {
    const e = e0 as QuantizedEventT;
    if (Math.abs(e.startTick - t) > 1e-9) errs.push(`event ${i}: starts at ${e.startTick}, expected ${t}`);
    if (!e.tuplet && !(Number.isInteger(e.ticks) && e.ticks > 0 && e.ticks % 2 === 0)) errs.push(`event ${i}: bad ticks ${e.ticks}`);
    if (i > 0 && e.kind === 'rest' && q.events[i - 1].kind === 'rest' && !e.tuplet && !(q.events[i - 1] as QuantizedEventT).tuplet) errs.push(`event ${i}: two rests in a row`);
    t = e.startTick + realTicks(e);
  });
  return errs;
}
