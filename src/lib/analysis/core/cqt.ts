// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: core.constantq.cqt / vqt (__early_downsample, __vqt_filter_fft, __cqt_response, __trim_stack),
// filters.wavelet / wavelet_lengths / _relative_bandwidth, util.sparsify_rows, core.pitch.piptrack /
// estimate_tuning / pitch_tuning.
/**
 * Constant-Q magnitude and tuning estimation on the analyzer's path (librosa notes sections 7 and 8):
 * cqt(y, sr=22050, hop=512, fmin=32.7, n_bins=216 | 108, bins_per_octave=36, tuning=estimated),
 * filter_scale 1, L1 norm, sparsity 0.01, Hann, scale=True, zero padding.
 *
 * Differences from librosa that the plan allows (notes section 7 "合わせ方"): soxr_hq decimation is
 * replaced by our own FIR with soxr_hq's band edges (resample.ts; a 2^c:1 early downsample is c 2:1 stages),
 * FFTs run in float64 (values are rounded to float32 where librosa stores complex64), the kernels are
 * dense-indexed rather than a scipy CSR matrix, and the unused decimation after the last octave is
 * skipped.
 *
 * Memory: the CQT is streamed octave by octave; only one octave's [36, cols] block, one frame's FFT
 * and the current decimated signal are alive besides the caller's arrays.
 */
import FFT from 'fft.js';
import { RealFft } from './fft';
import { pairwiseSum } from './npmath';
import type { MemTracker } from './mem';
import {
  decimate2Fft,
  decimatePow2,
  type DecimationChain,
  type HalfBand,
} from './resample';
import { StftFramer } from './stft';

/** filters.window_bandwidth('hann'). */
export const HANN_BANDWIDTH = 1.50018310546875;

const f32 = Math.fround;

export interface CqtOptions {
  sr: number;
  hop: number;
  /** fmin before the tuning correction (librosa's `fmin` argument). */
  fmin: number;
  nBins: number;
  bpo: number;
  /** In fractions of a bin (librosa units); the analyzer estimates it with estimateTuning. */
  tuning: number;
  /** Sparsity quantile (librosa default 0.01). */
  sparsity?: number;
  /** Decimation filter (default: resample.ts's cqtDecimator). Ignored when `chain` is given. */
  halfBand?: HalfBand;
  /** Shared chain of 2:1 decimations of the same input (full + bass CQT); level k = 2^k : 1. */
  chain?: DecimationChain;
}

/** interval_frequencies(..., intervals='equal') with fmin * 2^(tuning / bpo). */
export function cqtFrequencies(
  nBins: number,
  fmin: number,
  bpo: number,
  tuning = 0,
): Float64Array {
  const f0 = fmin * 2.0 ** (tuning / bpo);
  const nOct = Math.ceil(nBins / bpo);
  const ratios: number[] = [];
  for (let o = 0; o < nOct; o++)
    for (let b = 0; b < bpo; b++) ratios.push(2.0 ** o * 2.0 ** (b / bpo));
  const r = ratios.slice(0, nBins).sort((a, b) => a - b);
  return Float64Array.from(r, (x) => x * f0);
}

/** filters._relative_bandwidth. */
export function relativeBandwidth(freqs: ArrayLike<number>): Float64Array {
  const n = freqs.length;
  if (n < 2) throw new Error('relativeBandwidth needs 2 or more frequencies');
  const logf = Float64Array.from(freqs, (f) => Math.log2(f));
  const bpo = new Float64Array(n);
  bpo[0] = 1 / (logf[1] - logf[0]);
  bpo[n - 1] = 1 / (logf[n - 1] - logf[n - 2]);
  for (let i = 1; i < n - 1; i++) bpo[i] = 2 / (logf[i + 1] - logf[i - 1]);
  return Float64Array.from(
    bpo,
    (b) => (2.0 ** (2 / b) - 1) / (2.0 ** (2 / b) + 1),
  );
}

/** filters.wavelet_lengths(freqs, sr, window='hann', filter_scale=1, gamma=0, alpha). */
export function waveletLengths(
  freqs: ArrayLike<number>,
  sr: number,
  alpha: ArrayLike<number>,
): { lengths: Float64Array; cutoff: number } {
  const lengths = new Float64Array(freqs.length);
  let cutoff = -Infinity;
  for (let i = 0; i < freqs.length; i++) {
    const q = 1.0 / alpha[i];
    cutoff = Math.max(
      cutoff,
      // oxlint-disable-next-line oxc/erasing-op
      freqs[i] * (1 + (0.5 * HANN_BANDWIDTH) / q) + 0.5 * 0,
    );
    // oxlint-disable-next-line oxc/erasing-op
    lengths[i] = (q * sr) / (freqs[i] + 0 / alpha[i]);
  }
  return { lengths, cutoff };
}

function numTwoFactors(x: number): number {
  if (x <= 0) return 0;
  let k = 0;
  while (x % 2 === 0) {
    k++;
    x /= 2;
  }
  return k;
}

/** __early_downsample_count. */
export function earlyDownsampleCount(
  nyquist: number,
  cutoff: number,
  hop: number,
  nOctaves: number,
): number {
  const c1 = Math.max(
    0,
    Math.trunc(Math.ceil(Math.log2(nyquist / cutoff)) - 1) - 1,
  );
  const c2 = Math.max(0, numTwoFactors(hop) - nOctaves + 1);
  return Math.min(c1, c2);
}

/** One CQT filter in the frequency domain, sparsified: bins `idx` of the n_fft/2+1 half spectrum. */
export interface SparseKernel {
  idx: Int32Array;
  re: Float32Array;
  im: Float32Array;
}

export interface KernelBank {
  nFft: number;
  rows: SparseKernel[];
}

/**
 * __vqt_filter_fft(sr, freqs, filter_scale=1, norm=1, sparsity, window='hann', alpha) for one octave,
 * including the `fft_basis *= sqrt(srScale / sr)` rescale done by vqt (srScale = sr after the early
 * downsample).
 */
export function kernelBank(
  freqs: ArrayLike<number>,
  alpha: ArrayLike<number>,
  sr: number,
  srScale: number,
  sparsity = 0.01,
): KernelBank {
  const { lengths } = waveletLengths(freqs, sr, alpha);
  let maxLen = 0;
  for (const l of lengths) maxLen = Math.max(maxLen, l);
  const nFft = Math.trunc(2.0 ** Math.ceil(Math.log2(maxLen)));
  const fft = new FFT(nFft);
  const data = fft.createComplexArray() as number[];
  const out = fft.createComplexArray() as number[];
  const nb = nFft / 2 + 1;
  const mags = new Float32Array(nb);
  const sorted = new Float32Array(nb);
  const re = new Float64Array(nb);
  const im = new Float64Array(nb);
  const rescale = Math.sqrt(srScale / sr);
  const q32 = f32(sparsity);
  const rows: SparseKernel[] = [];
  for (let b = 0; b < freqs.length; b++) {
    const L = lengths[b];
    const f = freqs[b];
    // np.arange(-L // 2, L // 2): floor(-L/2) .. floor(L/2) - 1
    const start = Math.floor(-L / 2);
    const count = Math.floor(L / 2) - start;
    const sr_ = new Float64Array(count);
    const si = new Float64Array(count);
    let l1 = 0;
    for (let i = 0; i < count; i++) {
      const ang = ((start + i) * 2 * Math.PI * f) / sr;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count); // periodic Hann of length count
      sr_[i] = Math.cos(ang) * w;
      si[i] = Math.sin(ang) * w;
    }
    for (let i = 0; i < count; i++) l1 += Math.hypot(sr_[i], si[i]);
    const lpad = Math.floor((nFft - count) / 2);
    const s = L / nFft;
    data.fill(0);
    for (let i = 0; i < count; i++) {
      // complex64 after normalising and centring, then * L / n_fft (rounded to complex64 again)
      data[2 * (lpad + i)] = f32(f32(sr_[i] / l1) * s);
      data[2 * (lpad + i) + 1] = f32(f32(si[i] / l1) * s);
    }
    fft.transform(out, data);
    for (let k = 0; k < nb; k++) {
      re[k] = f32(out[2 * k]);
      im[k] = f32(out[2 * k + 1]);
      mags[k] = f32(Math.hypot(re[k], im[k]));
    }
    // util.sparsify_rows (float32 like numpy on complex64 input)
    const norm = pairwiseSum(mags, 0, mags.length, f32);
    sorted.set(mags);
    sorted.sort();
    let cum = 0;
    let j = 0;
    for (; j < nb; j++) {
      cum = f32(cum + f32(sorted[j] / norm));
      if (!(cum < q32)) break;
    }
    if (j === nb) j = 0; // argmin of an all-True mask
    const thr = sorted[j];
    const keep: number[] = [];
    for (let k = 0; k < nb; k++) if (mags[k] >= thr) keep.push(k);
    const row: SparseKernel = {
      idx: Int32Array.from(keep),
      re: Float32Array.from(keep, (k) => re[k] * rescale),
      im: Float32Array.from(keep, (k) => im[k] * rescale),
    };
    rows.push(row);
  }
  return { nFft, rows };
}

export interface CqtPlan {
  freqs: Float64Array;
  alpha: Float64Array;
  nOctaves: number;
  /** Early downsample count c (2^c : 1). */
  early: number;
  /** sr and hop after the early downsample. */
  sr: number;
  hop: number;
  /** Per octave (0 = top): signal length, hop, sr. */
  octaves: { n: number; hop: number; sr: number }[];
  /** Output columns (min of the octaves' frame counts). */
  cols: number;
  /** sqrt(Q * sr / f) per bin with the post-early-downsample sr (the `scale=True` divisor). */
  scaleDiv: Float64Array;
}

export function cqtPlan(n: number, opts: CqtOptions): CqtPlan {
  const { nBins, bpo } = opts;
  const nOctaves = Math.ceil(nBins / bpo);
  const freqs = cqtFrequencies(nBins, opts.fmin, bpo, opts.tuning);
  const alpha = relativeBandwidth(freqs);
  const { cutoff } = waveletLengths(freqs, opts.sr, alpha);
  const nyquist = opts.sr / 2;
  if (cutoff > nyquist) throw new Error('CQT basis exceeds Nyquist');
  const early = earlyDownsampleCount(nyquist, cutoff, opts.hop, nOctaves);
  const f = 2 ** early;
  let len = early > 0 ? Math.ceil(n / f) : n;
  if (early > 0 && n < f)
    throw new Error(
      `signal of ${n} samples too short for ${nOctaves}-octave CQT`,
    );
  let hop = Math.floor(opts.hop / f);
  let sr = opts.sr / f;
  const srEarly = sr;
  const hopEarly = hop;
  const octaves: CqtPlan['octaves'] = [];
  let cols = Infinity;
  for (let i = 0; i < nOctaves; i++) {
    octaves.push({ n: len, hop, sr });
    cols = Math.min(cols, 1 + Math.floor(len / hop));
    if (hop % 2 === 0) {
      hop /= 2;
      sr /= 2;
      len = Math.ceil(len / 2);
    }
  }
  const { lengths } = waveletLengths(freqs, srEarly, alpha);
  const scaleDiv = Float64Array.from(lengths, (l) => Math.sqrt(l));
  return {
    freqs,
    alpha,
    nOctaves,
    early,
    sr: srEarly,
    hop: hopEarly,
    octaves,
    cols,
    scaleDiv,
  };
}

/**
 * Receives one octave of |CQT| as a row-major [nb, cols] float32 block covering bins
 * firstBin .. firstBin + nb - 1. The block is reused/released after the call.
 */
export type CqtSink = (
  firstBin: number,
  nb: number,
  cols: number,
  block: Float32Array,
) => void;

/**
 * |librosa.cqt(y, sr, hop_length, fmin, n_bins, bins_per_octave, tuning)| streamed per octave
 * (top octave first, as librosa computes it). Returns the plan (incl. the column count).
 */
export function cqtMagnitudeStream(
  y: Float32Array,
  opts: CqtOptions,
  sink: CqtSink,
  mem?: MemTracker,
): CqtPlan {
  const plan = cqtPlan(y.length, opts);
  const { nBins, bpo } = opts;
  const nFilters = Math.min(bpo, nBins);
  const cols = plan.cols;
  const chain = opts.chain;
  let level = plan.early;
  let cur = chain
    ? chain.get(level)
    : plan.early > 0
      ? decimatePow2(y, plan.early, mem, opts.halfBand)
      : y;
  const block = mem
    ? mem.f32(nFilters * cols)
    : new Float32Array(nFilters * cols);
  for (let o = 0; o < plan.nOctaves; o++) {
    const hi = nBins - nFilters * o;
    const lo = Math.max(0, hi - nFilters);
    const nb = hi - lo;
    const oct = plan.octaves[o];
    if (cur.length !== oct.n)
      throw new Error('internal: octave length mismatch');
    const bank = kernelBank(
      plan.freqs.subarray(lo, hi),
      plan.alpha.subarray(lo, hi),
      oct.sr,
      plan.sr,
      opts.sparsity,
    );
    cqtResponse(
      cur,
      bank,
      oct.hop,
      cols,
      plan.scaleDiv.subarray(lo, hi),
      block,
      mem,
    );
    sink(lo, nb, cols, nb === nFilters ? block : block.subarray(0, nb * cols));
    if (o < plan.nOctaves - 1 && oct.hop % 2 === 0) {
      if (chain) cur = chain.get(++level);
      else {
        const next = decimate2Fft(cur, mem, opts.halfBand);
        if (cur !== y) mem?.release(cur);
        cur = next;
      }
    }
  }
  if (!chain && cur !== y) mem?.release(cur);
  mem?.release(block);
  return plan;
}

/**
 * __cqt_response with a rectangular ('ones') window, centred zero-padded frames, complex64 storage,
 * no conjugate, then `V /= sqrt(lengths)` and |V| (all rounded to float32 like complex64 / float32).
 * Writes rows [nb, cols] into `out`.
 */
function cqtResponse(
  y: Float32Array,
  bank: KernelBank,
  hop: number,
  cols: number,
  scaleDiv: ArrayLike<number>,
  out: Float32Array,
  mem?: MemTracker,
): void {
  const { nFft, rows } = bank;
  const fft = new RealFft(nFft, mem);
  const alloc = (n: number) => (mem ? mem.f64(n) : new Float64Array(n));
  const buf = alloc(nFft);
  const nbins = nFft / 2 + 1;
  const re = alloc(nbins);
  const im = alloc(nbins);
  const n = y.length;
  const half = nFft / 2;
  for (let t = 0; t < cols; t++) {
    const start = t * hop - half;
    for (let i = 0; i < nFft; i++) {
      const j = start + i;
      buf[i] = j >= 0 && j < n ? y[j] : 0;
    }
    fft.rfft(buf, re, im);
    for (let k = 0; k < nbins; k++) {
      re[k] = f32(re[k]);
      im[k] = f32(im[k]);
    }
    for (let b = 0; b < rows.length; b++) {
      const { idx, re: kr, im: ki } = rows[b];
      let sr = 0;
      let si = 0;
      for (let m = 0; m < idx.length; m++) {
        const k = idx[m];
        sr += kr[m] * re[k] - ki[m] * im[k];
        si += kr[m] * im[k] + ki[m] * re[k];
      }
      const d = scaleDiv[b];
      const vr = f32(f32(sr) / d);
      const vi = f32(f32(si) / d);
      out[b * cols + t] = Math.hypot(vr, vi);
    }
  }
  mem?.release(buf, re, im);
}

/** Full |CQT| as a row-major [nBins, cols] float32 matrix (for tests and the parity dumps). */
export function cqtMagnitude(
  y: Float32Array,
  opts: CqtOptions,
  mem?: MemTracker,
): { mag: Float32Array; cols: number } {
  const plan0 = cqtPlan(y.length, opts);
  const mag = mem
    ? mem.f32(opts.nBins * plan0.cols)
    : new Float32Array(opts.nBins * plan0.cols);
  cqtMagnitudeStream(
    y,
    opts,
    (lo, nb, cols, block) => {
      mag.set(block.subarray(0, nb * cols), lo * cols);
    },
    mem,
  );
  return { mag, cols: plan0.cols };
}

// ---------------------------------------------------------------------------------------------
// Tuning: estimate_tuning(y, sr, n_fft=2048, resolution=0.01, bins_per_octave) -> piptrack

export interface TuningOptions {
  sr?: number;
  nFft?: number;
  bpo?: number;
  resolution?: number;
  fmin?: number;
  fmax?: number;
  threshold?: number;
}

/** Growable float32 list. */
class F32List {
  data = new Float32Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = v;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

/**
 * piptrack peaks (pitch, mag) over all frames, float32 like librosa. Streams the STFT frame by
 * frame. The bookkeeping arrays are counted in `mem` when they are released.
 */
export function piptrackPeaks(
  y: Float32Array,
  opts: TuningOptions = {},
  mem?: MemTracker,
): { pitch: Float32Array; mag: Float32Array } {
  const sr = opts.sr ?? 22050;
  const nFft = opts.nFft ?? 2048;
  const fmin = Math.max(opts.fmin ?? 150, 0);
  const fmax = Math.min(opts.fmax ?? 4000, sr / 2);
  const threshold = opts.threshold ?? 0.1;
  const framer = new StftFramer(y, { nFft, hop: Math.floor(nFft / 4) }, mem);
  const bins = framer.bins;
  const S = new Float32Array(bins);
  const masked = new Float32Array(bins);
  const binHz = sr / nFft;
  // fft_frequencies = rfftfreq(n_fft, 1/sr) = k * (1 / (n_fft * (1/sr)))
  const step = 1 / (nFft * (1 / sr));
  const pitches = new F32List();
  const mags = new F32List();
  for (let t = 0; t < framer.frames; t++) {
    framer.frame(t);
    let mx = 0;
    for (let k = 0; k < bins; k++) {
      S[k] = Math.hypot(f32(framer.re[k]), f32(framer.im[k]));
      if (S[k] > mx) mx = S[k];
    }
    const ref = f32(threshold * mx);
    for (let k = 0; k < bins; k++) masked[k] = S[k] > ref ? S[k] : 0;
    for (let k = 1; k < bins; k++) {
      const fk = k * step;
      if (!(fmin <= fk && fk < fmax)) continue;
      // util.localmax: x[k] > x[k-1] and x[k] >= x[k+1] (the last bin only needs the first)
      if (!(
        masked[k] > masked[k - 1] &&
        (k === bins - 1 || masked[k] >= masked[k + 1])
      ))
        continue;
      let shift = 0;
      let avg: number;
      if (k === bins - 1) {
        avg = f32(S[k] - S[k - 1]);
      } else {
        // numba stencil: a = (x1 + x-1)[f32] - 2 * x0 [f64]; b = (x1 - x-1)[f32] / 2 [f64]
        const a = f32(S[k + 1] + S[k - 1]) - 2 * S[k];
        const d = f32(S[k + 1] - S[k - 1]);
        const b = d / 2;
        shift = Math.abs(b) >= Math.abs(a) ? 0 : f32(-b / a);
        avg = f32(d / 2);
      }
      const dskew = f32(f32(0.5 * avg) * shift);
      pitches.push((k + shift) * binHz);
      mags.push(S[k] + dskew);
    }
  }
  mem?.adopt(pitches.data);
  mem?.adopt(mags.data);
  return { pitch: pitches.view(), mag: mags.view() };
}

/** pitch_tuning(frequencies, resolution, bins_per_octave) with float32 arithmetic like numpy. */
export function pitchTuning(
  freqs: ArrayLike<number>,
  resolution = 0.01,
  bpo = 36,
): number {
  const nb = Math.ceil(1.0 / resolution);
  // np.linspace(-0.5, 0.5, nb + 1): arange * step + start, last = stop
  const stepE = 1.0 / nb;
  const edges = new Float64Array(nb + 1);
  for (let i = 0; i <= nb; i++) edges[i] = i * stepE + -0.5;
  edges[nb] = 0.5;
  const counts = new Int32Array(nb);
  let any = false;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (!(f > 0)) continue;
    any = true;
    const octs = f32(Math.log2(f32(f / 27.5)));
    const x = f32(bpo * octs);
    let r = x - Math.floor(x);
    if (r >= 0.5) r -= 1.0;
    // np.histogram with explicit edges: [e_i, e_{i+1}), the last bin closed
    if (r < edges[0] || r > edges[nb]) continue;
    let lo = 0;
    let hi = nb; // find the last edge <= r
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= r) lo = mid;
      else hi = mid;
    }
    counts[Math.min(lo, nb - 1)]++;
  }
  if (!any) return 0.0;
  let best = 0;
  for (let i = 1; i < nb; i++) if (counts[i] > counts[best]) best = i;
  return edges[best];
}

/** np.median of float32 values (float32 mean of the two middle values). */
function medianF32(a: Float32Array): number {
  const s = Float32Array.from(a).sort();
  const n = s.length;
  if (n % 2) return s[(n - 1) / 2];
  return f32(f32(s[n / 2 - 1] + s[n / 2]) / 2);
}

/** librosa.estimate_tuning(y=y, sr, bins_per_octave) (n_fft 2048, resolution 0.01). */
export function estimateTuning(
  y: Float32Array,
  opts: TuningOptions = {},
  mem?: MemTracker,
): number {
  const { pitch, mag } = piptrackPeaks(y, opts, mem);
  let threshold = 0;
  const pos: number[] = [];
  for (let i = 0; i < pitch.length; i++) if (pitch[i] > 0) pos.push(i);
  if (pos.length > 0)
    threshold = medianF32(Float32Array.from(pos, (i) => mag[i]));
  const sel: number[] = [];
  for (const i of pos) if (mag[i] >= threshold) sel.push(pitch[i]);
  mem?.release(pitch.buffer, mag.buffer);
  return pitchTuning(sel, opts.resolution ?? 0.01, opts.bpo ?? 36);
}
