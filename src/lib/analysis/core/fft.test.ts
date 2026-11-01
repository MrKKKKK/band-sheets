import { describe, expect, it } from 'vitest';
import { RealFft } from './fft';
import { MemTracker } from './mem';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

function naiveDft(x: ArrayLike<number>) {
  const n = x.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    for (let j = 0; j < n; j++) {
      re[k] += x[j] * Math.cos((2 * Math.PI * k * j) / n);
      im[k] -= x[j] * Math.sin((2 * Math.PI * k * j) / n);
    }
  }
  return { re, im };
}

describe('RealFft', () => {
  it('matches a naive DFT (numpy sign convention, bins 0..N/2)', () => {
    for (const n of [2, 4, 16, 64]) {
      const r = rng(n);
      const x = Array.from({ length: n }, r);
      const f = new RealFft(n);
      const re = new Float64Array(f.bins);
      const im = new Float64Array(f.bins);
      f.rfft(x, re, im);
      const ref = naiveDft(x);
      for (let k = 0; k < f.bins; k++) {
        expect(re[k]).toBeCloseTo(ref.re[k], 12);
        expect(im[k]).toBeCloseTo(ref.im[k], 12);
      }
    }
  });

  it('irfftPair inverts two spectra at once and ignores DC/Nyquist imaginary parts', () => {
    const n = 32;
    const r = rng(7);
    const a = Array.from({ length: n }, r);
    const b = Array.from({ length: n }, r);
    const f = new RealFft(n);
    const ar = new Float64Array(f.bins);
    const ai = new Float64Array(f.bins);
    const br = new Float64Array(f.bins);
    const bi = new Float64Array(f.bins);
    f.rfft(a, ar, ai);
    f.rfft(b, br, bi);
    ai[0] = 5; // irfft ignores these (scipy behaviour)
    bi[n / 2] = -3;
    const oa = new Float64Array(n);
    const ob = new Float64Array(n);
    f.irfftPair(ar, ai, br, bi, oa, ob);
    for (let i = 0; i < n; i++) {
      expect(oa[i]).toBeCloseTo(a[i], 12);
      expect(ob[i]).toBeCloseTo(b[i], 12);
    }
    const o = new Float64Array(n);
    f.irfft(br, bi, o);
    for (let i = 0; i < n; i++) expect(o[i]).toBeCloseTo(b[i], 12);
  });

  it('rejects non-power-of-two sizes and counts its buffers', () => {
    expect(() => new RealFft(12)).toThrow(/power of two/);
    const mem = new MemTracker();
    new RealFft(1024, mem);
    // cin + cout (2N each) + rin (N) + zeros (N/2+1), float64
    expect(mem.total).toBe((2 * 1024 + 2 * 1024 + 1024 + 513) * 8);
  });
});
