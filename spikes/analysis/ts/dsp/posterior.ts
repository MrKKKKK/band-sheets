/**
 * Chord posterior (port of py/dsp/posterior.py, default path: no `trans` argument).
 *
 *   chordPosterior(emis, k, n, stay, nMove) -> Float64Array [k, n], each column sums to 1
 *   segmentCandidates / attachCandidates     top-k states of a merged segment
 *   numpySum(a, off, n)                      numpy's add.reduce summation order (see below)
 *
 * Plain scaled forward-backward in float64. The matrix products numpy does with BLAS
 * (a.T @ alpha) are plain loops here; the order of those sums differs, so posteriors agree
 * to ~1e-15, not bit-for-bit.
 */
import type { ChordSegment } from './chords';
import { states as vocabStates, type ChordState, type VocabConfig } from './vocab';

/**
 * numpy's float64 sum of a contiguous run: pairwise summation (8-way unrolled blocks of up to 128,
 * split in halves above that). np.mean = this / n.
 * Mean-of-confidences and mean-posterior in the Python code go through it, so the ULPs match.
 */
export function numpySum(a: ArrayLike<number>, off: number, n: number): number {
  if (n === 0) return 0;
  return pairwise(a, off, n);
}

function pairwise(a: ArrayLike<number>, off: number, n: number): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => a[off + j]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[off + i + j];
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, off, n2) + pairwise(a, off + n2, n - n2);
}

/** emis: log emission scores [k, n] (the caller passes BETA * emis_w * scores). */
export function chordPosterior(
  emis: Float64Array,
  k: number,
  n: number,
  stay0: number,
  nMove: number | null = null,
): Float64Array {
  if (n === 0 || k === 0) return new Float64Array(k * n);
  if (k === 1) return new Float64Array(n).fill(1);
  const m = nMove ?? k;
  const stay = Math.min(Math.max(stay0, 1 / m + 1e-9), 1 - 1e-9);
  const off = (1 - stay) / (m - 1);
  // b = exp(emis - column max)
  const b = new Float64Array(k * n);
  for (let t = 0; t < n; t++) {
    let mx = -Infinity;
    for (let i = 0; i < k; i++) mx = Math.max(mx, emis[i * n + t]);
    for (let i = 0; i < k; i++) b[i * n + t] = Math.exp(emis[i * n + t] - mx);
  }
  // alpha / beta stored column-major ([t][i]) for cache-friendly loops
  const alpha = new Float64Array(n * k);
  const beta = new Float64Array(n * k).fill(1);
  const v = new Float64Array(k);
  const normalize = (dst: Float64Array, o: number) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += v[i];
    for (let i = 0; i < k; i++) dst[o + i] = v[i] / s;
  };
  for (let i = 0; i < k; i++) v[i] = b[i * n] / k;
  normalize(alpha, 0);
  for (let t = 1; t < n; t++) {
    // (a.T @ alpha)[j] = sum_i a[i][j] alpha[i], a = off everywhere, stay on the diagonal
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += (i === j ? stay : off) * alpha[(t - 1) * k + i];
      v[j] = s * b[j * n + t];
    }
    normalize(alpha, t * k);
  }
  const w = new Float64Array(k);
  for (let t = n - 2; t >= 0; t--) {
    for (let j = 0; j < k; j++) w[j] = b[j * n + t + 1] * beta[(t + 1) * k + j];
    for (let i = 0; i < k; i++) {
      let s = 0;
      for (let j = 0; j < k; j++) s += (i === j ? stay : off) * w[j];
      v[i] = s;
    }
    normalize(beta, t * k);
  }
  const post = new Float64Array(k * n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = 0; i < k; i++) {
      const p = alpha[t * k + i] * beta[t * k + i];
      post[i * n + t] = p;
      s += p;
    }
    for (let i = 0; i < k; i++) post[i * n + t] /= s;
  }
  return post;
}

export interface Candidate {
  root: number;
  quality: string;
  prob: number;
}

/**
 * Top-k states by the mean posterior over columns [start, end) of `post` ([k, n]); prob descending,
 * ties by state order.
 */
export function segmentCandidates(
  post: Float64Array,
  sts: readonly ChordState[],
  n: number,
  start: number,
  end: number,
  k: number,
): Candidate[] {
  const a = Math.max(start, 0);
  const b = Math.min(end, n);
  if (b <= a || k < 1) return [];
  const mean = sts.map((_, i) => numpySum(post.subarray(i * n, (i + 1) * n), a, b - a) / (b - a));
  const order = sts
    .map((_, i) => i)
    .sort((i, j) => (mean[i] !== mean[j] ? (mean[j] > mean[i] ? 1 : -1) : i - j))
    .slice(0, k);
  return order.map((i) => ({ root: sts[i].root, quality: sts[i].quality, prob: mean[i] }));
}

export interface PosteriorConfig extends VocabConfig {
  candidates: boolean;
  candidates_k: number;
}

/** Segments with `.candidates` from the per-column posteriors; no-chord segments keep []. */
export function attachCandidates(
  segments: ChordSegment[],
  columnPosteriors: readonly (Float64Array | null)[],
  cfg: PosteriorConfig,
): ChordSegment[] {
  if (segments.length === 0 || !cfg.candidates) return segments;
  const n = columnPosteriors.length;
  if (n === 0 || columnPosteriors.some((p) => p === null)) return segments;
  const sts = vocabStates(cfg);
  const k = sts.length;
  const post = new Float64Array(k * n);
  for (let t = 0; t < n; t++) {
    const col = columnPosteriors[t] as Float64Array;
    for (let i = 0; i < k; i++) post[i * n + t] = col[i];
  }
  return segments.map((seg) =>
    seg.root === null
      ? seg
      : { ...seg, candidates: segmentCandidates(post, sts, n, seg.startBeat, seg.endBeat, cfg.candidates_k) },
  );
}
