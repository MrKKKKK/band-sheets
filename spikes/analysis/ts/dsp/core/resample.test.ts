import { describe, expect, it } from 'vitest';
import { MemTracker } from './mem';
import { cqtHalfBand, decimate2, decimatePow2, designHalfBand, halfBandResponse } from './resample';

const db = (x: number) => 20 * Math.log10(x);

describe('half-band filter (librosa notes section 7 spec)', () => {
  const hb = cqtHalfBand();

  it('is symmetric with a 0.5 centre tap and zero even taps', () => {
    const { taps, half } = hb;
    expect(taps[half]).toBe(0.5);
    for (let j = 1; j <= half; j++) {
      expect(taps[half + j]).toBe(taps[half - j]);
      if (j % 2 === 0) expect(taps[half + j]).toBe(0);
    }
    expect(halfBandResponse(hb, 0)).toBeCloseTo(1, 14);
  });

  it('passband 0..0.5 x output Nyquist within 1e-4 dB, folding band >= 1.5 x output Nyquist <= -120 dB', () => {
    let pass = 0;
    let stop = 0;
    for (let i = 0; i <= 4000; i++) {
      pass = Math.max(pass, Math.abs(db(halfBandResponse(hb, (i / 4000) * 0.25 * Math.PI))));
      stop = Math.max(stop, halfBandResponse(hb, 0.75 * Math.PI + (i / 4000) * 0.25 * Math.PI));
    }
    expect(pass).toBeLessThan(1e-4);
    expect(db(stop)).toBeLessThan(-120);
  });

  it('rejects an even half length', () => {
    expect(() => designHalfBand(4)).toThrow();
  });
});

describe('decimate2 / decimatePow2', () => {
  it('output length ceil(n / 2)', () => {
    expect(decimate2(new Float32Array(10)).length).toBe(5);
    expect(decimate2(new Float32Array(11)).length).toBe(6);
    expect(decimatePow2(new Float32Array(1001), 4).length).toBe(Math.ceil(1001 / 16));
  });

  it('zero delay: an impulse at 2k comes out centred on k', () => {
    const x = new Float32Array(200);
    x[100] = 1;
    const y = decimate2(x);
    expect(y[50]).toBeCloseTo(0.5 * Math.SQRT2, 6);
    for (let d = 1; d < 20; d++) expect(y[50 + d]).toBeCloseTo(y[50 - d], 7);
  });

  it('scale sqrt(2) per stage, zero outside the signal (a constant starts at ~0.75 like soxr)', () => {
    const x = new Float32Array(400).fill(1);
    const y = decimate2(x);
    expect(y[100]).toBeCloseTo(Math.SQRT2, 6);
    expect(y[0] / Math.SQRT2).toBeCloseTo(0.75, 3);
    const z = decimatePow2(new Float32Array(4000).fill(1), 4);
    expect(z[120]).toBeCloseTo(4, 5);
  });

  it('a sine in the passband keeps amplitude and phase', () => {
    const n = 4000;
    const f = 0.1; // cycles / input sample (0.2 of the input Nyquist)
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * i));
    const y = decimate2(x);
    for (let k = 100; k < 1900; k++) expect(y[k]).toBeCloseTo(Math.SQRT2 * Math.sin(2 * Math.PI * f * 2 * k), 4);
  });

  it('counts intermediate arrays in the MemTracker and releases them', () => {
    const mem = new MemTracker();
    const out = decimatePow2(new Float32Array(1600), 4, mem);
    expect(mem.live).toBe(out.byteLength);
    expect(mem.total).toBe((800 + 400 + 200 + 100) * 4);
  });
});
