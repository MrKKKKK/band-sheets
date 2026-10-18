// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: core.spectrum.stft / istft, filters.window_sumsquare.
/**
 * Centred STFT / inverse STFT with librosa's defaults on the analyzer's path (librosa notes
 * section 3): periodic Hann window of length n_fft, center=True with ZERO padding
 * (pad_mode='constant'), frame t centred on sample t*hop, 1 + floor(n / hop) frames.
 * The FFT runs in float64 and the spectrum is stored as float32 (complex64 in Python).
 *
 * Layout: spectra are FRAME-major, [frames, bins] (Python dumps are [bins, frames]).
 */
import { RealFft } from './fft';
import type { MemTracker } from './mem';

/** scipy.signal.get_window('hann', n, fftbins=True): 0.5 - 0.5 cos(2 pi i / n). */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++)
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Frame count of a centred STFT: 1 + floor(n / hop). */
export function frameCount(n: number, hop: number): number {
  return 1 + Math.floor(n / hop);
}

export interface StftParams {
  nFft: number;
  hop: number;
}

export const STFT_DEFAULT: StftParams = { nFft: 2048, hop: 512 };

/**
 * Computes single frames of the centred, zero-padded, Hann-windowed STFT of y. Frames can be
 * requested in any order (the HPSS second pass recomputes them instead of storing the STFT).
 */
export class StftFramer {
  readonly nFft: number;
  readonly hop: number;
  readonly bins: number;
  readonly frames: number;
  readonly window: Float64Array;
  /** float64 spectrum of the last computed frame (before rounding). */
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly fft: RealFft;
  private readonly buf: Float64Array;

  private readonly y: Float32Array;

  constructor(
    y: Float32Array,
    { nFft, hop }: StftParams = STFT_DEFAULT,
    mem?: MemTracker,
  ) {
    this.y = y;
    this.nFft = nFft;
    this.hop = hop;
    this.bins = nFft / 2 + 1;
    this.frames = frameCount(y.length, hop);
    this.fft = new RealFft(nFft, mem);
    mem?.adopt({ byteLength: nFft * 8 }); // window
    this.window = hannPeriodic(nFft);
    const alloc = (n: number) => (mem ? mem.f64(n) : new Float64Array(n));
    this.buf = alloc(nFft);
    this.re = alloc(this.bins);
    this.im = alloc(this.bins);
  }

  /**
   * Compute frame t into this.re / this.im (float64). If outRe / outIm are given, the values
   * rounded to float32 (what librosa stores) are written there.
   */
  frame(t: number, outRe?: Float32Array, outIm?: Float32Array): void {
    const { nFft, y, buf, window } = this;
    const start = t * this.hop - nFft / 2;
    const n = y.length;
    for (let i = 0; i < nFft; i++) {
      const j = start + i;
      buf[i] = j >= 0 && j < n ? window[i] * y[j] : 0;
    }
    this.fft.rfft(buf, this.re, this.im);
    if (outRe && outIm) {
      for (let k = 0; k < this.bins; k++) {
        outRe[k] = this.re[k];
        outIm[k] = this.im[k];
      }
    }
  }
}

export interface Spectrum {
  /** [frames, bins], float32. */
  re: Float32Array;
  im: Float32Array;
  frames: number;
  bins: number;
}

/** Full STFT (librosa.stft(y, n_fft, hop_length) with the defaults above). */
export function stft(
  y: Float32Array,
  params: StftParams = STFT_DEFAULT,
  mem?: MemTracker,
): Spectrum {
  const fr = new StftFramer(y, params, mem);
  const { frames, bins } = fr;
  const alloc = (n: number) => (mem ? mem.f32(n) : new Float32Array(n));
  const re = alloc(frames * bins);
  const im = alloc(frames * bins);
  for (let t = 0; t < frames; t++) {
    fr.frame(
      t,
      re.subarray(t * bins, (t + 1) * bins),
      im.subarray(t * bins, (t + 1) * bins),
    );
  }
  return { re, im, frames, bins };
}

/**
 * Overlap-add for librosa.istft(center=True, window='hann', length=n, dtype=float32): add the
 * frames (already inverse-FFT'd) in ascending t, as librosa does, so the float32 sums round the
 * same way, then `finish()` divides by the summed squared window where
 * that sum exceeds float32 tiny.
 */
export class OverlapAdd {
  readonly out: Float32Array;
  private readonly winSq: Float64Array;

  readonly length: number;
  readonly frames: number;
  private readonly params: StftParams;

  constructor(
    length: number,
    frames: number,
    params: StftParams = STFT_DEFAULT,
    mem?: MemTracker,
    out?: Float32Array,
  ) {
    this.length = length;
    this.frames = frames;
    this.params = params;
    this.out = out ?? (mem ? mem.f32(length) : new Float32Array(length));
    const w = hannPeriodic(params.nFft);
    for (let i = 0; i < w.length; i++) w[i] *= w[i];
    this.winSq = w;
    mem?.adopt(w);
  }

  /** Add window * frame (frame = irfft output, length nFft, float64) for frame index t. */
  add(t: number, frame: Float64Array, window: Float64Array): void {
    const { nFft, hop } = this.params;
    const start = t * hop - nFft / 2;
    const out = this.out;
    const i0 = Math.max(0, -start);
    const i1 = Math.min(nFft, this.length - start);
    for (let i = i0; i < i1; i++) out[start + i] += window[i] * frame[i];
  }

  /** Divide by window_sumsquare (librosa's float32 envelope, frames 0..frames-1). */
  finish(): Float32Array {
    const { nFft, hop } = this.params;
    const out = this.out;
    const tiny = 1.1754943508222875e-38; // float32 tiny
    const half = nFft / 2;
    for (let i = 0; i < this.length; i++) {
      const p = i + half; // position in the padded signal
      // frames k with k*hop <= p < k*hop + nFft, ascending (float32 accumulation like librosa)
      const kHi = Math.min(this.frames - 1, Math.floor(p / hop));
      const kLo = Math.max(0, Math.floor((p - nFft) / hop) + 1);
      let s = 0;
      for (let k = kLo; k <= kHi; k++)
        s = Math.fround(s + this.winSq[p - k * hop]);
      if (s > tiny) out[i] = out[i] / s;
    }
    return out;
  }
}

/**
 * librosa.istft(spec, hop_length, window='hann', center=True, length, dtype=float32) for a
 * frame-major float32 spectrum.
 */
export function istft(
  spec: Spectrum,
  length: number,
  params: StftParams = STFT_DEFAULT,
  mem?: MemTracker,
): Float32Array {
  const { nFft, hop } = params;
  if (spec.bins !== nFft / 2 + 1)
    throw new Error('istft: bins do not match nFft');
  // librosa trims the frames to the signal length.
  const frames = Math.min(
    spec.frames,
    Math.ceil((length + 2 * (nFft / 2)) / hop),
  );
  const fft = new RealFft(nFft, mem);
  const window = hannPeriodic(nFft);
  const frame = mem ? mem.f64(nFft) : new Float64Array(nFft);
  const ola = new OverlapAdd(length, frames, params, mem);
  const b = spec.bins;
  for (let t = 0; t < frames; t++) {
    fft.irfft(
      spec.re.subarray(t * b, (t + 1) * b),
      spec.im.subarray(t * b, (t + 1) * b),
      frame,
    );
    ola.add(t, frame, window);
  }
  return ola.finish();
}
