/**
 * Sliding median filters with the semantics of scipy.ndimage.median_filter(mode='reflect')
 * for an odd window k (librosa notes section 4): the k values are sorted and the middle one
 * (rank (k-1)/2) is returned as-is, no averaging. scipy's 'reflect' repeats the edge sample
 * (d c b a | a b c d | d c b a), i.e. numpy's 'symmetric'.
 *
 * Implementation: a sorted window updated by one remove + one insert per step (no full sort).
 * Values are float32 and compared exactly, so for the same input bits the output is bit-identical
 * to scipy's.
 */
import type { MemTracker } from './mem';

/** scipy.ndimage 'reflect' (= numpy 'symmetric') index into [0, n), any i, n >= 1. */
export function reflectIndex(i: number, n: number): number {
  if (n === 1) return 0;
  const p = 2 * n;
  let j = i % p;
  if (j < 0) j += p;
  return j < n ? j : p - 1 - j;
}

/** Index of the first element >= v in sorted win[off, off+len). */
function lowerBound(
  win: Float32Array,
  off: number,
  len: number,
  v: number,
): number {
  let lo = off;
  let hi = off + len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (win[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * In the sorted window win[off, off+k), replace one occurrence of `oldV` by `newV`, keeping it
 * sorted. `oldV` must be present (float32 value, compared exactly).
 */
export function replaceSorted(
  win: Float32Array,
  off: number,
  k: number,
  oldV: number,
  newV: number,
): void {
  let i = lowerBound(win, off, k, oldV);
  if (i >= off + k || win[i] !== oldV) {
    throw new Error(`replaceSorted: value ${oldV} not in window`);
  }
  const v = Math.fround(newV);
  if (v > oldV) {
    // shift smaller-than-v elements left
    while (i + 1 < off + k && win[i + 1] < v) {
      win[i] = win[i + 1];
      i++;
    }
  } else if (v < oldV) {
    while (i > off && win[i - 1] > v) {
      win[i] = win[i - 1];
      i--;
    }
  }
  win[i] = v;
}

/** Fill win[off, off+k) with values and sort ascending. */
function fillSorted(
  win: Float32Array,
  off: number,
  k: number,
  value: (j: number) => number,
): void {
  for (let j = 0; j < k; j++) win[off + j] = value(j);
  win.subarray(off, off + k).sort();
}

function checkK(k: number): void {
  if (!Number.isInteger(k) || k < 1 || k % 2 === 0)
    throw new Error(`median window must be odd, got ${k}`);
}

/**
 * 1-D median filter of x (length n) with odd window k, scipy 'reflect' edges. Writes into `out`
 * (length n, may not alias x). `scratch` (length >= k) is an optional work buffer.
 */
export function medianFilter1d(
  x: ArrayLike<number>,
  k: number,
  out: Float32Array,
  scratch?: Float32Array,
): Float32Array {
  checkK(k);
  const n = x.length;
  if (n === 0) return out;
  const h = (k - 1) / 2;
  const win = scratch ?? new Float32Array(k);
  fillSorted(win, 0, k, (j) => x[reflectIndex(j - h, n)]);
  for (let i = 0; i < n; i++) {
    out[i] = win[h];
    if (i + 1 < n) {
      replaceSorted(
        win,
        0,
        k,
        Math.fround(x[reflectIndex(i - h, n)]),
        x[reflectIndex(i + h + 1, n)],
      );
    }
  }
  return out;
}

/**
 * Many parallel sliding medians that advance together (e.g. one per frequency bin, sliding over
 * time frames). Lane l holds a sorted window of k values.
 */
export class SlidingMedians {
  readonly lanes: number;
  readonly k: number;
  private readonly win: Float32Array;

  constructor(lanes: number, k: number, mem?: MemTracker) {
    checkK(k);
    this.lanes = lanes;
    this.k = k;
    this.win = mem ? mem.f32(lanes * k) : new Float32Array(lanes * k);
  }

  /** Set lane l's window to value(0..k-1) (any order). */
  init(l: number, value: (j: number) => number): void {
    fillSorted(this.win, l * this.k, this.k, value);
  }

  /** Remove `oldV` from lane l's window and add `newV`. */
  replace(l: number, oldV: number, newV: number): void {
    replaceSorted(this.win, l * this.k, this.k, oldV, newV);
  }

  median(l: number): number {
    return this.win[l * this.k + (this.k - 1) / 2];
  }

  get byteLength(): number {
    return this.win.byteLength;
  }
}
