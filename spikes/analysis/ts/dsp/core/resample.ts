/**
 * Resampling. This file currently holds only the 2:1 decimation the CQT needs (T6); T8 adds the
 * general windowed-sinc resampler for loading audio (plan decision 2).
 *
 * librosa's CQT decimates with soxr_hq (LGPL, never shipped). Our replacement is a zero-phase
 * Kaiser-windowed half-band FIR, designed to the spec in docs/audio-spike3-librosa-notes.md
 * section 7 ("TS の自前の半帯域フィルタへの条件"):
 *   - symmetric, centred (no delay): output k is aligned with input 2k,
 *   - passband 0 .. 0.5 x output Nyquist flat within +-1e-4 dB,
 *   - everything that folds onto it (>= 1.5 x output Nyquist) at -120 dB or below,
 *   - zero outside the signal, output length ceil(n / 2), scaled by sqrt(2)
 *     (librosa.resample(..., scale=True) for ratio 1/2).
 * 0.5 .. 1.5 x output Nyquist is a free transition band: the CQT never reads bins up there.
 * A 16:1 decimation (the bass CQT's single soxr step) is four of these in a row; the length
 * ceil(ceil(n/2)/2)... equals ceil(n/16) and the scale sqrt(2)^4 equals sqrt(16).
 */
import type { MemTracker } from './mem';

/** Modified Bessel function of the first kind, order 0 (power series). */
export function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Kaiser beta for a stopband attenuation of `atten` dB (Kaiser's formula, atten > 50). */
export function kaiserBeta(atten: number): number {
  return 0.1102 * (atten - 8.7);
}

export interface HalfBand {
  /** Taps h[0..2K] (centre at K); every even offset from the centre except 0 is exactly 0. */
  taps: Float64Array;
  /** K: half length. */
  half: number;
}

/**
 * Half-band low-pass (cutoff at half the input Nyquist), Kaiser-windowed ideal sinc,
 * normalised to unit DC gain. `half` must be odd (so the outermost taps are non-zero).
 */
export function designHalfBand(half = 23, atten = 140): HalfBand {
  if (!Number.isInteger(half) || half < 1 || half % 2 === 0) throw new Error(`half must be odd, got ${half}`);
  const beta = kaiserBeta(atten);
  const i0b = besselI0(beta);
  const taps = new Float64Array(2 * half + 1);
  for (let j = -half; j <= half; j++) {
    let h: number;
    if (j === 0) h = 0.5;
    else if (j % 2 === 0) h = 0;
    else h = Math.sin((Math.PI * j) / 2) / (Math.PI * j);
    const r = j / half;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    taps[j + half] = h * w;
  }
  // Unit DC gain; keep the centre tap at exactly 0.5 by scaling the odd taps only, which also keeps
  // the half-band symmetry H(w) + H(pi - w) = 1.
  let odd = 0;
  for (let j = 1; j <= half; j += 2) odd += 2 * taps[j + half];
  const s = 0.5 / odd;
  for (let j = -half; j <= half; j++) if (j % 2 !== 0) taps[j + half] *= s;
  return { taps, half };
}

/** |H(e^{i w})| of a centred symmetric FIR, w in radians/sample of the INPUT rate. */
export function halfBandResponse(hb: HalfBand, w: number): number {
  const { taps, half } = hb;
  let s = taps[half];
  for (let j = 1; j <= half; j++) s += 2 * taps[half + j] * Math.cos(w * j);
  return Math.abs(s);
}

let defaultHalfBand: HalfBand | null = null;

/** The filter the CQT uses (designed once). */
export function cqtHalfBand(): HalfBand {
  defaultHalfBand ??= designHalfBand();
  return defaultHalfBand;
}

/**
 * librosa.resample(x, orig_sr=2, target_sr=1, scale=True) with our half-band filter:
 * out[k] = sqrt(2) * sum_j h[j] x[2k - j] (x = 0 outside), length ceil(n / 2), float32.
 */
export function decimate2(x: Float32Array, mem?: MemTracker, hb: HalfBand = cqtHalfBand()): Float32Array {
  const n = x.length;
  const m = Math.ceil(n / 2);
  const out = mem ? mem.f32(m) : new Float32Array(m);
  const { taps, half } = hb;
  const c = taps[half];
  for (let k = 0; k < m; k++) {
    const p = 2 * k;
    let s = c * x[p];
    // only odd offsets are non-zero
    for (let j = 1; j <= half; j += 2) {
      const a = p - j >= 0 ? x[p - j] : 0;
      const b = p + j < n ? x[p + j] : 0;
      s += taps[half + j] * (a + b);
    }
    out[k] = s * Math.SQRT2;
  }
  return out;
}

/**
 * 2^count : 1 decimation as `count` half-band stages (scale sqrt(2^count), length ceil(n / 2^count)).
 * Intermediate arrays are released from `mem`; the input is not.
 */
export function decimatePow2(x: Float32Array, count: number, mem?: MemTracker, hb?: HalfBand): Float32Array {
  let y = x;
  for (let i = 0; i < count; i++) {
    const next = decimate2(y, mem, hb);
    if (y !== x) mem?.release(y);
    y = next;
  }
  return y;
}
