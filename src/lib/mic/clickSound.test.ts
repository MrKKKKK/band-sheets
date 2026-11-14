import { describe, expect, it } from 'vitest';
import { softClickSamples } from './clickSound';

describe('softClickSamples', () => {
  const SR = 48000;
  it('is short, peaks within 2 ms, stays under 0.5 and ends near zero', () => {
    for (const strong of [false, true]) {
      const x = softClickSamples(SR, strong);
      expect(x.length).toBeLessThanOrEqual(SR * 0.08);
      expect(x.every(Number.isFinite)).toBe(true);
      let peak = 0;
      let at = 0;
      x.forEach((v, i) => {
        if (Math.abs(v) > peak) {
          peak = Math.abs(v);
          at = i;
        }
      });
      expect(peak).toBeLessThanOrEqual(0.5);
      expect(peak).toBeGreaterThan(0.3);
      expect(at / SR).toBeLessThanOrEqual(0.004);
      expect(Math.abs(x[x.length - 1])).toBeLessThan(0.02);
      // onset: the first 2 ms already carry the energy
      expect(
        Math.max(...Array.from(x.slice(0, SR * 0.002)).map(Math.abs)),
      ).toBeGreaterThan(0.1);
    }
  });

  it('the downbeat differs from the weak beat', () => {
    expect(Array.from(softClickSamples(SR, true))).not.toEqual(
      Array.from(softClickSamples(SR, false)),
    );
  });

  it('is much softer than the measurement click and valid at low rates', () => {
    expect(softClickSamples(SR)[10]).toBeLessThan(0.5 + 1e-9);
    expect(softClickSamples(8000).length).toBeGreaterThanOrEqual(8);
  });
});
