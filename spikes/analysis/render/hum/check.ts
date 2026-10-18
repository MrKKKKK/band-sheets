// Spike 4 T1: self-checks that the truth matches the rendered audio (T1 done conditions).
//
// - H0: frequency of every note from rising zero crossings (linearly interpolated) over the middle 60 %
//   of the note must be within +-1 cent of the truth pitch.
// - H1..H3: inside each truth (sung-time) note, the median f0 of frames every 10 ms must be within +-tol of the
//   truth pitch (midi + cents / 100); tol = max(the level's per-note sigma, 10 cents). The f0 here is a
//   TRUTH-GUIDED difference-function search (only periods within +-3 semitones of the truth are tried),
//   because it checks the truth against the audio, not an analyzer. The start of the note (glide/scoop)
//   and its last 20 % are left out; notes leaving less than 40 ms are skipped and counted.
//   H4 (T1b): tol = the level's per-note sigma (40-60 c); the frames left out at the start are the note's own
//   onset transition (truth `transitionSec`: scoop or portamento + overshoot) or the attack, whichever is longer.
// - excursionStats (T1b sanity stat): share of truth notes whose frame f0 truth leaves the note's main semitone
//   (the most common rounded MIDI value inside the note) for a 30-300 ms run, i.e. what makes an analyzer
//   split a sung note into pitch-differing fragments (look point 1: 32 % extra splits on the recordings).
//   To count fragments rather than flicker at a semitone boundary, the frame pitch is first smoothed with a
//   5-frame (58 ms) running median, and a run (frames more than 50 c from the main semitone) only counts when
//   it gets at least EXCURSION_MARGIN_CENTS beyond the boundary.

import type { HumTruth } from './truth';

const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);
export const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Frequency from rising zero crossings in [t0, t1] (s), or NaN with fewer than 3 crossings. */
export function zeroCrossingHz(x: ArrayLike<number>, sr: number, t0: number, t1: number): number {
  const i0 = Math.max(1, Math.ceil(t0 * sr));
  const i1 = Math.min(x.length - 1, Math.floor(t1 * sr));
  let first = NaN;
  let last = NaN;
  let count = 0;
  for (let i = i0; i <= i1; i++) {
    const a = x[i - 1];
    const b = x[i];
    if (a < 0 && b >= 0) {
      const tc = i - 1 + a / (a - b);
      if (count === 0) first = tc;
      last = tc;
      count++;
    }
  }
  return count < 3 ? NaN : ((count - 1) * sr) / (last - first);
}

/** Truth-guided f0 at time t: minimum of the difference function over periods within +-3 semitones. */
export function guidedF0(x: ArrayLike<number>, sr: number, t: number, expectHz: number, win = 2048): number {
  const tauMin = Math.floor(sr / (expectHz * 2 ** (3 / 12)));
  const tauMax = Math.ceil(sr / (expectHz * 2 ** (-3 / 12)));
  const c = Math.round(t * sr);
  const i0 = c - Math.floor((win + tauMax) / 2);
  if (i0 < 0 || i0 + win + tauMax + 1 >= x.length) return NaN;
  const d = new Float64Array(tauMax + 2);
  for (let tau = tauMin - 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let i = i0; i < i0 + win; i++) {
      const e = x[i] - x[i + tau];
      s += e * e;
    }
    d[tau] = s;
  }
  let best = tauMin;
  for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[best]) best = tau;
  const a = d[best - 1];
  const b = d[best];
  const cc = d[best + 1];
  const den = a - 2 * b + cc;
  const shift = den > 0 ? (0.5 * (a - cc)) / den : 0;
  return sr / (best + shift);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface NoteCheck {
  notes: number;
  checked: number;
  skipped: number;
  passed: number;
  tolCents: number;
  maxAbsCents: number;
  medianAbsCents: number;
}

/** H0 check: zero-crossing frequency of each note vs the truth (tolerance 1 cent). */
export function checkH0(x: ArrayLike<number>, sr: number, truth: HumTruth, tolCents = 1): NoteCheck {
  const errs: number[] = [];
  for (const n of truth.melody.notes) {
    const L = n.end - n.start;
    const hz = zeroCrossingHz(x, sr, n.start + 0.2 * L, n.end - 0.2 * L);
    errs.push(Math.abs(cents(hz, midiHz(n.midi + n.cents / 100))));
  }
  return summarize(truth.melody.notes.length, errs, 0, tolCents);
}

/** H1..H3 check: median guided f0 inside each truth note vs midi + cents (see top). */
export function checkSung(x: ArrayLike<number>, sr: number, truth: HumTruth, tolCents: number, stepSec = 0.01): NoteCheck {
  const s = truth.hum.synth;
  const lead = Math.max(s.glideSec[1], s.scoopSec[1], s.attackSec) + 0.02;
  const errs: number[] = [];
  let skipped = 0;
  for (const n of truth.melody.notes) {
    const L = n.end - n.start;
    const skip = n.transitionSec === undefined ? lead : Math.max(n.transitionSec, s.attackSec) + 0.02;
    const a = n.start + Math.max(0.25 * L, skip);
    const b = n.end - 0.2 * L;
    if (b - a < 0.04) {
      skipped++;
      continue;
    }
    const ref = midiHz(n.midi + n.cents / 100);
    const hz: number[] = [];
    const frames = Math.max(5, Math.round((b - a) / stepSec));
    for (let k = 0; k < frames; k++) {
      const f = guidedF0(x, sr, a + ((b - a) * (k + 0.5)) / frames, ref);
      if (Number.isFinite(f)) hz.push(f);
    }
    if (hz.length === 0) {
      skipped++;
      continue;
    }
    errs.push(Math.abs(cents(median(hz), ref)));
  }
  return summarize(truth.melody.notes.length, errs, skipped, tolCents);
}

function summarize(notes: number, errs: number[], skipped: number, tolCents: number): NoteCheck {
  const finite = errs.map((e) => (Number.isFinite(e) ? e : Infinity));
  return {
    notes,
    checked: finite.length,
    skipped,
    passed: finite.filter((e) => e <= tolCents).length,
    tolCents,
    maxAbsCents: finite.length ? Math.max(...finite) : 0,
    medianAbsCents: finite.length ? median(finite) : 0,
  };
}

/** The tolerance of the sung check for a variant's truth. */
export function sungTolerance(truth: HumTruth): number {
  return Math.max(truth.hum.synth.pitchSigmaCents, 10);
}

export interface ExcursionStats {
  notes: number;
  /** Notes with at least one 30-300 ms run off their main semitone (anywhere in the note). */
  withExcursion: number;
  /** Same, counting only runs that start after the onset transition (H4 transitionSec, else the T1 lead). */
  withInnerExcursion: number;
  /** Notes with such a run of at least LONG_EXCURSION_SEC (closer to the recordings' fragments: median 174 ms). */
  withLongExcursion: number;
  /** All such runs and their median length (s). */
  runs: number;
  medianRunSec: number;
}

export const EXCURSION_MARGIN_CENTS = 15;
export const LONG_EXCURSION_SEC = 0.1;

/** The T1b sanity stat (see top) on the frame f0 truth. */
export function excursionStats(truth: HumTruth, minSec = 0.03, maxSec = 0.3, marginCents = EXCURSION_MARGIN_CENTS): ExcursionStats {
  const f0 = truth.hum.f0;
  const s = truth.hum.synth;
  const lead = Math.max(s.glideSec[1], s.scoopSec[1], s.attackSec);
  let withExcursion = 0;
  let withInner = 0;
  let withLong = 0;
  const lens: number[] = [];
  for (const n of truth.melody.notes) {
    const i0 = Math.max(0, Math.ceil((n.start - f0.t0) / f0.hopSec));
    const i1 = Math.min(f0.hz.length - 1, Math.floor((n.end - f0.t0) / f0.hopSec));
    const raw: number[] = [];
    const idx: number[] = [];
    for (let i = i0; i <= i1; i++) {
      if (!f0.voiced[i]) continue;
      raw.push(69 + 12 * Math.log2(f0.hz[i] / 440));
      idx.push(i);
    }
    if (raw.length === 0) continue;
    const pitch = raw.map((_x, k) => median(raw.slice(Math.max(0, k - 2), k + 3)));
    const semis = pitch.map(Math.round);
    const count = new Map<number, number>();
    for (const m of semis) count.set(m, (count.get(m) ?? 0) + 1);
    let main = semis[0];
    for (const [m, c] of count) if (c > count.get(main)! || (c === count.get(main)! && Math.abs(m - n.midi) < Math.abs(main - n.midi))) main = m;
    const innerFrom = n.start + (n.transitionSec ?? lead);
    let any = false;
    let inner = false;
    let long = false;
    let k = 0;
    while (k < semis.length) {
      if (semis[k] === main) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < semis.length && semis[e + 1] !== main && idx[e + 1] === idx[e] + 1) e++;
      const len = (e - k + 1) * f0.hopSec;
      let far = 0;
      for (let q = k; q <= e; q++) far = Math.max(far, Math.abs(pitch[q] - main));
      if (len >= minSec && len <= maxSec && far >= 0.5 + marginCents / 100) {
        lens.push(len);
        any = true;
        if (len >= LONG_EXCURSION_SEC) long = true;
        if (f0.t0 + idx[k] * f0.hopSec >= innerFrom) inner = true;
      }
      k = e + 1;
    }
    if (any) withExcursion++;
    if (inner) withInner++;
    if (long) withLong++;
  }
  return { notes: truth.melody.notes.length, withExcursion, withInnerExcursion: withInner, withLongExcursion: withLong, runs: lens.length, medianRunSec: lens.length ? median(lens) : 0 };
}
