import { describe, expect, it } from 'vitest';
import { medianFilter1d, reflectIndex, replaceSorted, SlidingMedians } from './median';

function bruteMedian(x: ArrayLike<number>, k: number): Float32Array {
  const n = x.length;
  const h = (k - 1) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = Float32Array.from({ length: k }, (_, j) => x[reflectIndex(i + j - h, n)]).sort();
    out[i] = w[h];
  }
  return out;
}

describe('reflectIndex (scipy reflect = numpy symmetric)', () => {
  it('repeats the edge sample: d c b a | a b c d | d c b a', () => {
    expect([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((i) => reflectIndex(i, 4))).toEqual([
      3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0,
    ]);
    expect(reflectIndex(-5, 4)).toBe(3); // next period
    expect(reflectIndex(9, 4)).toBe(1);
    expect(reflectIndex(-7, 1)).toBe(0);
  });
});

describe('medianFilter1d', () => {
  it('matches scipy.ndimage.median_filter(mode="reflect") on hand examples', () => {
    // values from scipy 1.18.1 in the analysis image
    expect(Array.from(medianFilter1d([1, 5, 2, 8, 3], 3, new Float32Array(5)))).toEqual([1, 2, 5, 3, 3]);
    // window longer than the signal: reflected several times
    expect(Array.from(medianFilter1d([4, 1, 3], 5, new Float32Array(3)))).toEqual([3, 3, 3]);
    expect(Array.from(medianFilter1d([7], 31, new Float32Array(1)))).toEqual([7]);
  });

  it('equals a brute-force sort for random data with ties (k = 31)', () => {
    let s = 1;
    const x = Float32Array.from({ length: 1025 }, () => {
      s = (s * 48271) % 2147483647;
      return Math.floor((s / 2147483647) * 50) / 7; // many duplicates
    });
    const out = medianFilter1d(x, 31, new Float32Array(x.length));
    expect(Array.from(out)).toEqual(Array.from(bruteMedian(x, 31)));
  });

  it('rejects an even window', () => {
    expect(() => medianFilter1d([1, 2], 4, new Float32Array(2))).toThrow(/odd/);
  });
});

describe('replaceSorted / SlidingMedians', () => {
  it('keeps the window sorted in both directions', () => {
    const w = Float32Array.from([1, 2, 3, 4, 5]);
    replaceSorted(w, 0, 5, 2, 4.5);
    expect(Array.from(w)).toEqual([1, 3, 4, 4.5, 5]);
    replaceSorted(w, 0, 5, 5, 0);
    expect(Array.from(w)).toEqual([0, 1, 3, 4, 4.5]);
    replaceSorted(w, 0, 5, 3, 3);
    expect(Array.from(w)).toEqual([0, 1, 3, 4, 4.5]);
    expect(() => replaceSorted(w, 0, 5, 9, 1)).toThrow(/not in window/);
  });

  it('slides along the other axis like medianFilter1d', () => {
    const T = 40;
    const lanes = 3;
    const k = 7;
    const h = 3;
    const data = Array.from({ length: lanes }, (_, l) =>
      Float32Array.from({ length: T }, (_, t) => ((t * 37 + l * 11) % 13) - l),
    );
    const sm = new SlidingMedians(lanes, k);
    for (let l = 0; l < lanes; l++) sm.init(l, (j) => data[l][reflectIndex(j - h, T)]);
    const got = data.map(() => new Float32Array(T));
    for (let t = 0; t < T; t++) {
      for (let l = 0; l < lanes; l++) {
        got[l][t] = sm.median(l);
        if (t + 1 < T) sm.replace(l, data[l][reflectIndex(t - h, T)], data[l][reflectIndex(t + h + 1, T)]);
      }
    }
    for (let l = 0; l < lanes; l++) expect(Array.from(got[l])).toEqual(Array.from(bruteMedian(data[l], k)));
  });
});
