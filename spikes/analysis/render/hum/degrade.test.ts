import { describe, expect, it } from 'vitest';
import { prng } from '../prng';
import { activeRms, addNoise, addReverb, pinkNoise } from './degrade';

const rms = (x: ArrayLike<number>, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};

describe('activeRms', () => {
  it('ignores silent frames', () => {
    const x = new Float64Array(2048 * 10);
    for (let i = 0; i < 2048 * 5; i++) x[i] = Math.sin(i / 10);
    expect(activeRms(x)).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('pinkNoise', () => {
  it('has unit RMS, is deterministic and has more low than high energy', () => {
    const a = pinkNoise(1 << 15, prng(1));
    expect(rms(a)).toBeCloseTo(1, 9);
    expect(pinkNoise(1 << 15, prng(1))).toEqual(a);
    // first difference emphasizes highs: for pink noise its RMS is well below sqrt(2)
    const d = new Float64Array(a.length - 1).map((_, i) => a[i + 1] - a[i]);
    expect(rms(d)).toBeLessThan(0.9);
  });
});

describe('addNoise', () => {
  it('reaches the SNR against the active RMS', () => {
    const x = new Float64Array(2048 * 20);
    for (let i = 0; i < x.length / 2; i++) x[i] = 0.5 * Math.sin(i / 7);
    const y = Float64Array.from(x);
    addNoise(y, 20, prng(5));
    const noise = y.map((v, i) => v - x[i]);
    expect(20 * Math.log10(activeRms(x) / rms(noise))).toBeCloseTo(20, 6);
  });
});

describe('addReverb', () => {
  it('leaves a tail that is longer for a larger RT60', () => {
    const sr = 22050;
    const tail = (rt: number) => {
      const x = new Float64Array(sr * 2);
      for (let i = 0; i < 200; i++) x[i] = Math.sin(i / 3);
      addReverb(x, rt, sr);
      return rms(x, Math.round(0.3 * sr), Math.round(0.4 * sr));
    };
    expect(tail(0.3)).toBeGreaterThan(0);
    expect(tail(0.7)).toBeGreaterThan(3 * tail(0.3));
  });
});
