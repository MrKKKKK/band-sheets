// Spike 4 T1: self-checks that the truth matches the rendered audio (T1 done conditions).
//
// - H0: frequency of every note from rising zero crossings (linearly interpolated) over the middle 60 %
//   of the note must be within +-1 cent of the truth pitch.
// - H1..H3: inside each truth (sung-time) note, the median f0 of frames every 10 ms must be within +-tol of the
//   truth pitch (midi + cents / 100); tol = max(the level's per-note sigma, 10 cents). The f0 here is a
//   TRUTH-GUIDED difference-function search (only periods within +-3 semitones of the truth are tried),
//   because it checks the truth against the audio, not an analyzer. The start of the note (glide/scoop)
//   and its last 20 % are left out; notes leaving less than 40 ms are skipped and counted.

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
    const a = n.start + Math.max(0.25 * L, lead);
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
