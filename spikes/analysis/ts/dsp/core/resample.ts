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

// ---------------------------------------------------------------------------------------------
// T8: loading (librosa.load(path, sr=22050, mono=True)) = to_mono + resample(soxr_hq, fix=True,
// scale=False). soxr is LGPL and never shipped; this is our own Kaiser-windowed sinc
// (plan decision 2), polyphase for any rational ratio (44.1 kHz -> 22050 is 2:1, 48 kHz is 320:147).
// Filter spec chosen to resemble soxr_hq: passband to ~0.914 x target Nyquist, stopband from the
// target Nyquist, ~120 dB attenuation, linear phase with the delay removed (output k is aligned with
// input k * from / to), zero outside the signal, output length ceil(n * to / from).

/** librosa.to_mono: mean over channels in float32 (2 channels: bit-identical to np.mean). */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) throw new Error('no channels');
  const n = channels[0].length;
  for (const c of channels) if (c.length !== n) throw new Error('channel lengths differ');
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(n);
  if (channels.length === 2) {
    const [l, r] = channels;
    for (let i = 0; i < n; i++) out[i] = (l[i] + r[i]) * 0.5; // exact in f64, then rounded once
    return out;
  }
  const k = channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < k; c++) s += channels[c][i];
    out[i] = s / k;
  }
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export interface SincOptions {
  /** passband edge as a fraction of the target Nyquist (soxr_hq: ~0.913). */
  passband?: number;
  /** stopband edge as a fraction of the target Nyquist (1 = no aliasing into the band). */
  stopband?: number;
  /** stopband attenuation in dB (Kaiser design). */
  atten?: number;
}

/**
 * passband 0.914 was fitted to librosa.load's soxr_hq output on two dev synthetic 44.1 kHz renders
 * (T8 sweep: 0.90 -> 50 dB, 0.913 -> 73 dB, 0.914 -> 78 dB, 0.916 -> 65 dB signal-to-error).
 */
export const SINC_DEFAULT: Required<SincOptions> = { passband: 0.914, stopband: 1.0, atten: 120 };

export interface SincPlan {
  from: number;
  to: number;
  /** up / down factors of the reduced ratio (to / from = up / down). */
  up: number;
  down: number;
  /** taps per phase (2 * half). */
  width: number;
  half: number;
  /** [up, width] row-major: phase p covers input offsets j - half + 1 .. j + half (see resampleSinc). */
  taps: Float64Array;
}

/** Polyphase Kaiser-windowed sinc for from -> to (Hz, integers). */
export function sincPlan(from: number, to: number, opts: SincOptions = {}): SincPlan {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
    throw new Error(`sample rates must be positive integers, got ${from} -> ${to}`);
  }
  const o = { ...SINC_DEFAULT, ...opts };
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  const ratio = Math.min(1, to / from); // cutoffs are relative to the lower Nyquist
  const fc = (ratio * (o.passband + o.stopband)) / 2; // cutoff, fraction of the input Nyquist
  const dw = Math.PI * ratio * (o.stopband - o.passband); // transition width, rad / input sample
  const beta = o.atten > 50 ? kaiserBeta(o.atten) : 0.5842 * Math.pow(o.atten - 21, 0.4) + 0.07886 * (o.atten - 21);
  const len = Math.ceil((o.atten - 7.95) / (2.285 * dw)) + 1;
  const half = Math.ceil(len / 2);
  const width = 2 * half;
  const i0b = besselI0(beta);
  const taps = new Float64Array(up * width);
  for (let p = 0; p < up; p++) {
    // output position relative to its floor input sample: frac = p / up (input samples)
    const frac = p / up;
    let sum = 0;
    for (let w = 0; w < width; w++) {
      const d = w - half + 1 - frac; // input index offset minus exact position
      const x = fc * d;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = d / half;
      const win = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const h = fc * s * win;
      taps[p * width + w] = h;
      sum += h;
    }
    for (let w = 0; w < width; w++) taps[p * width + w] /= sum; // unit DC gain per phase
  }
  return { from, to, up, down, width, half, taps };
}

const planCache = new Map<string, SincPlan>();

/**
 * librosa.resample(x, orig_sr=from, target_sr=to, fix=True, scale=False) with our filter:
 * out[k] = sum_i x[i] h(i - k * from / to), x = 0 outside, length ceil(n * to / from), float32.
 * Same rate: returns `x` itself.
 */
export function resampleSinc(
  x: Float32Array,
  from: number,
  to: number,
  opts: SincOptions = {},
  mem?: MemTracker,
): Float32Array {
  if (from === to) return x;
  const key = `${from}:${to}:${opts.passband}:${opts.stopband}:${opts.atten}`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = sincPlan(from, to, opts);
    planCache.set(key, plan);
  }
  const { up, down, width, half, taps } = plan;
  const n = x.length;
  const m = Math.ceil((n * up) / down);
  const out = mem ? mem.f32(m) : new Float32Array(m);
  if (up === 1) {
    // integer decimation: one symmetric phase centred on input k * down (tap index half - 1);
    // the outermost tap (offset +half) is 0 because the window is 0 there.
    const c = half - 1;
    for (let k = 0; k < m; k++) {
      const b = k * down;
      let s = taps[c] * x[b];
      if (b - c >= 0 && b + c < n) {
        for (let j = 1; j <= c; j++) s += taps[c + j] * (x[b - j] + x[b + j]);
      } else {
        for (let j = 1; j <= c; j++) {
          const lo = b - j >= 0 ? x[b - j] : 0;
          const hi = b + j < n ? x[b + j] : 0;
          s += taps[c + j] * (lo + hi);
        }
      }
      out[k] = s;
    }
    return out;
  }
  let base = 0; // floor(k * down / up)
  let p = 0; // (k * down) mod up
  for (let k = 0; k < m; k++) {
    const i0 = base - half + 1;
    const t = p * width;
    let s = 0;
    if (i0 >= 0 && i0 + width <= n) {
      for (let w = 0; w < width; w++) s += taps[t + w] * x[i0 + w];
    } else {
      const lo = Math.max(0, -i0);
      const hi = Math.min(width, n - i0);
      for (let w = lo; w < hi; w++) s += taps[t + w] * x[i0 + w];
    }
    out[k] = s;
    p += down;
    while (p >= up) {
      p -= up;
      base++;
    }
  }
  return out;
}

/** librosa.load(..., sr=22050, mono=True) from decoded channels at `sr`. */
export function loadMono22050(channels: readonly Float32Array[], sr: number, mem?: MemTracker): Float32Array {
  const mono = toMono(channels);
  return resampleSinc(mono, sr, 22050, {}, mem);
}
