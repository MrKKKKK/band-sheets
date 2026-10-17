/**
 * Resampling: the 2:1 decimation the CQT needs (T6) and, below, the general windowed-sinc resampler
 * for loading audio (T8, plan decision 2).
 *
 * librosa's CQT decimates with soxr_hq (LGPL, never shipped). Our replacement is a zero-phase
 * Kaiser-windowed low-pass FIR with soxr_hq's documented band edges: passband to 0.913 x output
 * Nyquist, stopband from the output Nyquist (cqtDecimator: 160 dB Kaiser, 489 taps). It meets the
 * spec in docs/audio-spike3-librosa-notes.md section 7 (centred, no delay; flat passband; folding
 * band at -120 dB or below; zero outside the signal; length ceil(n / 2); x sqrt(2)).
 *
 * Why soxr's edges and not the cheaper 47-tap half-band first used (still here as designHalfBand):
 * the CQT never reads bins above 0.5 x output Nyquist, so in the middle of a signal both filters
 * give the same chroma (+-0.2 %). But at an ABRUPT signal start (the trimmed level-M variants) the
 * first ~10 frames carry the start transient, whose spectrum reaches the transition band; there the
 * chroma depends on the transition-band shape (librosa itself moves by up to 1.3 % (full) / 16 %
 * (bass) between soxr_hq and polyphase, out/t6/edge_ref.py). With soxr_hq's edges the TS chroma
 * matches librosa's to <= 0.13 % on those frames (T6 follow-up).
 *
 * A 16:1 decimation (the bass CQT's early downsample) is four 2:1 stages (matches better than one
 * 16:1 stage); the length ceil(ceil(n/2)/2)... equals ceil(n/16) and the scale sqrt(2)^4 = sqrt(16).
 * The full and the bass CQT use the same chain of 2:1 stages, so DecimationChain shares it.
 */
import { RealFft } from './fft';
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
  /** Offsets from the centre that can be non-zero: 2 = odd only (half-band), 1 = all. Default 2. */
  step?: 1 | 2;
}

/**
 * General zero-phase Kaiser-windowed low-pass for 2:1 decimation, edges as fractions of the OUTPUT
 * Nyquist (soxr_hq-like: pass 0.9, stop 1.0). Unit DC gain.
 */
export function designDecimator(pass = 0.9, stop = 1.0, atten = 140, factor = 2): HalfBand {
  const ny = 0.5 / factor; // output Nyquist in cycles / input sample
  const df = (stop - pass) * ny; // transition width
  const fc = ((pass + stop) / 2) * ny; // cutoff
  const half = Math.ceil((atten - 7.95) / (14.36 * df) / 2);
  const beta = kaiserBeta(atten);
  const i0b = besselI0(beta);
  const taps = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let j = -half; j <= half; j++) {
    const h = j === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * j) / (Math.PI * j);
    const r = j / half;
    taps[j + half] = h * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b);
    sum += taps[j + half];
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  return { taps, half, step: 1 };
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

/** The 47-tap half-band (designed once); no longer the CQT default (see the header). */
export function cqtHalfBand(): HalfBand {
  defaultHalfBand ??= designHalfBand();
  return defaultHalfBand;
}

let defaultDecimator: HalfBand | null = null;

/** The CQT's 2:1 decimation filter: soxr_hq's band edges (pass 0.913, stop 1.0), 160 dB. */
export function cqtDecimator(): HalfBand {
  defaultDecimator ??= designDecimator(0.913, 1.0, 160);
  return defaultDecimator;
}

/**
 * librosa.resample(x, orig_sr=2, target_sr=1, scale=True) with our filter (default cqtDecimator):
 * out[k] = sqrt(2) * sum_j h[j] x[2k - j] (x = 0 outside), length ceil(n / 2), float32.
 */
export function decimate2(x: Float32Array, mem?: MemTracker, hb: HalfBand = cqtDecimator()): Float32Array {
  const n = x.length;
  const m = Math.ceil(n / 2);
  const out = mem ? mem.f32(m) : new Float32Array(m);
  const { taps, half } = hb;
  const step = hb.step ?? 2;
  const c = taps[half];
  for (let k = 0; k < m; k++) {
    const p = 2 * k;
    let s = c * x[p];
    // half-band: only odd offsets are non-zero
    if (p - half >= 0 && p + half < n) {
      for (let j = 1; j <= half; j += step) s += taps[half + j] * (x[p - j] + x[p + j]);
    } else {
      for (let j = 1; j <= half; j += step) {
        const a = p - j >= 0 ? x[p - j] : 0;
        const b = p + j < n ? x[p + j] : 0;
        s += taps[half + j] * (a + b);
      }
    }
    out[k] = s * Math.SQRT2;
  }
  return out;
}

/**
 * decimate2 via FFT overlap-save (same result up to float64 rounding; ~10x faster for long filters
 * like cqtDecimator). Block size `nFft` (power of two, > 2 x filter length).
 */
export function decimate2Fft(x: Float32Array, mem?: MemTracker, hb: HalfBand = cqtDecimator(), nFft = 8192): Float32Array {
  const n = x.length;
  const m = Math.ceil(n / 2);
  const out = mem ? mem.f32(m) : new Float32Array(m);
  const { taps, half } = hb;
  const M = taps.length; // 2 half + 1
  if (nFft < 2 * M) throw new Error('decimate2Fft: nFft too small for the filter');
  const fft = new RealFft(nFft);
  const nb = nFft / 2 + 1;
  const hRe = new Float64Array(nb);
  const hIm = new Float64Array(nb);
  const buf = new Float64Array(nFft);
  buf.set(taps);
  fft.rfft(buf, hRe, hIm);
  const xRe = new Float64Array(nb);
  const xIm = new Float64Array(nb);
  const y = new Float64Array(nFft);
  const valid = nFft - M + 1;
  // c[q] = sum_i taps[i] x[q - i]; out[k] = sqrt(2) c[2k + half]
  const qEnd = 2 * (m - 1) + half; // last q needed
  for (let q0 = half; q0 <= qEnd; q0 += valid) {
    const s0 = q0 - (M - 1);
    for (let i = 0; i < nFft; i++) {
      const j = s0 + i;
      buf[i] = j >= 0 && j < n ? x[j] : 0;
    }
    fft.rfft(buf, xRe, xIm);
    for (let k = 0; k < nb; k++) {
      const a = xRe[k];
      const b = xIm[k];
      xRe[k] = a * hRe[k] - b * hIm[k];
      xIm[k] = a * hIm[k] + b * hRe[k];
    }
    fft.irfft(xRe, xIm, y);
    // q in [q0, q0 + valid): output index k with 2k + half = q
    const qHi = Math.min(q0 + valid, qEnd + 1);
    let q = q0 + ((q0 - half) % 2 === 0 ? 0 : 1);
    for (; q < qHi; q += 2) out[(q - half) / 2] = y[q - q0 + M - 1] * Math.SQRT2;
  }
  return out;
}

/**
 * The chain y, y/2, y/4, ... of 2:1 decimations (level k = k stages), computed lazily in order and
 * shared between the full and the bass CQT. Levels below `keepFrom` are released as soon as the
 * next level exists (the full CQT walks 1..6 once; the bass CQT then needs 4..6 again).
 */
export class DecimationChain {
  private readonly levels: (Float32Array | null)[];

  constructor(
    y: Float32Array,
    private readonly keepFrom = Infinity,
    private readonly mem?: MemTracker,
    private readonly hb: HalfBand = cqtDecimator(),
  ) {
    this.levels = [y];
  }

  get(k: number): Float32Array {
    const have = this.levels[k];
    if (have) return have;
    let j = k - 1;
    while (j > 0 && !this.levels[j]) j--;
    let cur = this.levels[j];
    if (!cur) throw new Error(`decimation level ${j} was released; keepFrom ${this.keepFrom} too high`);
    for (let i = j + 1; i <= k; i++) {
      const next = decimate2Fft(cur, this.mem, this.hb);
      this.levels[i] = next;
      if (i - 1 > 0 && i - 1 < this.keepFrom) {
        this.mem?.release(cur);
        this.levels[i - 1] = null;
      }
      cur = next;
    }
    return cur;
  }

  /** Release every level except the input. */
  release(): void {
    for (let i = 1; i < this.levels.length; i++) {
      const a = this.levels[i];
      if (a) this.mem?.release(a);
      this.levels[i] = null;
    }
  }
}

/**
 * 2^count : 1 decimation as `count` 2:1 stages (scale sqrt(2^count), length ceil(n / 2^count)).
 * Intermediate arrays are released from `mem`; the input is not.
 */
export function decimatePow2(x: Float32Array, count: number, mem?: MemTracker, hb?: HalfBand): Float32Array {
  let y = x;
  for (let i = 0; i < count; i++) {
    const next = decimate2Fft(y, mem, hb);
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
