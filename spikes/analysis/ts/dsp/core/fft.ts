/**
 * FFT wrapper around fft.js 4.0.4 (MIT, Fedor Indutny; see ../../THIRD_PARTY.md). Plan
 * decision 4: the FFT is the only library; everything else is ours.
 *
 * All transforms run in float64 (like scipy.fft on float64 input). librosa's STFT computes in
 * float64 and stores complex64, so callers round with Math.fround where Python stores float32
 * (librosa notes section 1).
 */
import FFT from 'fft.js';
import type { MemTracker } from './mem';

export class RealFft {
  readonly size: number;
  /** Number of non-negative-frequency bins: size / 2 + 1. */
  readonly bins: number;
  private readonly fft: FFT;
  private readonly cin: Float64Array;
  private readonly cout: Float64Array;
  private readonly rin: Float64Array;
  private readonly zeros: Float64Array;

  constructor(size: number, mem?: MemTracker) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    this.bins = size / 2 + 1;
    this.fft = new FFT(size);
    const alloc = (n: number) => (mem ? mem.f64(n) : new Float64Array(n));
    this.cin = alloc(2 * size);
    this.cout = alloc(2 * size);
    this.rin = alloc(size);
    this.zeros = alloc(this.bins);
  }

  /**
   * Forward real FFT (numpy/scipy sign convention, X[k] = sum x[n] e^{-2 pi i k n / N}, no
   * scaling). Writes bins 0..N/2 into re / im (length >= bins). `input` length must be N.
   */
  rfft(input: ArrayLike<number>, re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (input.length !== n) throw new Error(`rfft input length ${input.length} != ${n}`);
    const rin = this.rin;
    for (let i = 0; i < n; i++) rin[i] = input[i];
    this.fft.realTransform(this.cout, rin);
    const out = this.cout;
    for (let k = 0; k < this.bins; k++) {
      re[k] = out[2 * k];
      im[k] = out[2 * k + 1];
    }
  }

  /**
   * Inverse real FFT of TWO half spectra at once (one complex IFFT of A + iB; both outputs are
   * real). Like scipy.fft.irfft(n=N): scaled by 1/N, and the imaginary parts of the DC and
   * Nyquist bins are ignored. Inputs have length >= bins; outputs length N.
   */
  irfftPair(
    aRe: ArrayLike<number>,
    aIm: ArrayLike<number>,
    bRe: ArrayLike<number>,
    bIm: ArrayLike<number>,
    outA: Float64Array,
    outB: Float64Array,
  ): void {
    const n = this.size;
    const h = n / 2;
    const c = this.cin;
    // Z[k] = A[k] + i B[k] with A, B Hermitian-completed.
    c[0] = aRe[0];
    c[1] = bRe[0];
    c[2 * h] = aRe[h];
    c[2 * h + 1] = bRe[h];
    for (let k = 1; k < h; k++) {
      const ar = aRe[k];
      const ai = aIm[k];
      const br = bRe[k];
      const bi = bIm[k];
      // A[k] + i B[k]
      c[2 * k] = ar - bi;
      c[2 * k + 1] = ai + br;
      // conj(A[k]) + i conj(B[k])
      c[2 * (n - k)] = ar + bi;
      c[2 * (n - k) + 1] = br - ai;
    }
    this.fft.inverseTransform(this.cout, c); // includes the 1/N scaling
    const o = this.cout;
    for (let i = 0; i < n; i++) {
      outA[i] = o[2 * i];
      outB[i] = o[2 * i + 1];
    }
  }

  /** Inverse real FFT of one half spectrum (see irfftPair). */
  irfft(re: ArrayLike<number>, im: ArrayLike<number>, out: Float64Array): void {
    this.irfftPair(re, im, this.zeros, this.zeros, out, this.rin); // rin: discarded output
  }
}
