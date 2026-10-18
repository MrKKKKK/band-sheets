import { describe, expect, it } from 'vitest';
import { MemTracker } from './mem';
import {
  DecimationChain,
  cqtDecimator,
  decimate2,
  decimate2Fft,
  decimatePow2,
  type HalfBand,
} from './resample';

const db = (x: number) => 20 * Math.log10(x);

/** |H(e^{i w})| of a centred symmetric FIR, w in radians/sample of the INPUT rate. */
function halfBandResponse(hb: HalfBand, w: number): number {
  const { taps, half } = hb;
  let s = taps[half];
  for (let j = 1; j <= half; j++) s += 2 * taps[half + j] * Math.cos(w * j);
  return Math.abs(s);
}

describe('cqtDecimator (soxr_hq band edges; librosa notes section 7 spec)', () => {
  const hb = cqtDecimator();

  it('symmetric, unit DC gain', () => {
    const { taps, half } = hb;
    for (let j = 1; j <= half; j++) expect(taps[half + j]).toBe(taps[half - j]);
    expect(halfBandResponse(hb, 0)).toBeCloseTo(1, 12);
  });

  it('flat to 0.9 x output Nyquist (+-1e-4 dB), <= -150 dB from the output Nyquist on', () => {
    let pass = 0;
    let stop = 0;
    for (let i = 0; i <= 4000; i++) {
      pass = Math.max(pass, Math.abs(db(halfBandResponse(hb, (i / 4000) * 0.9 * 0.5 * Math.PI))));
      stop = Math.max(stop, halfBandResponse(hb, 0.5 * Math.PI + (i / 4000) * 0.5 * Math.PI));
    }
    expect(pass).toBeLessThan(1e-4);
    expect(db(stop)).toBeLessThan(-150);
  });
});

describe('decimate2 / decimatePow2', () => {
  it('output length ceil(n / 2)', () => {
    expect(decimate2(new Float32Array(10)).length).toBe(5);
    expect(decimate2(new Float32Array(11)).length).toBe(6);
    expect(decimatePow2(new Float32Array(1001), 4).length).toBe(Math.ceil(1001 / 16));
  });

  it('zero delay: an impulse at 2k comes out centred on k', () => {
    const x = new Float32Array(1200);
    x[600] = 1;
    const y = decimate2(x);
    expect(y[300]).toBeCloseTo(cqtDecimator().taps[cqtDecimator().half] * Math.SQRT2, 6);
    for (let d = 1; d < 150; d++) expect(y[300 + d]).toBeCloseTo(y[300 - d], 7);
  });

  it('scale sqrt(2) per stage, zero outside the signal (a constant starts at ~0.75 like soxr)', () => {
    const x = new Float32Array(2000).fill(1);
    const y = decimate2(x);
    expect(y[500]).toBeCloseTo(Math.SQRT2, 6);
    expect(y[0] / Math.SQRT2).toBeCloseTo(0.74, 2); // soxr_hq: 0.74
    const z = decimatePow2(new Float32Array(40000).fill(1), 4);
    expect(z[1200]).toBeCloseTo(4, 5);
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

  it('decimate2Fft equals the direct form (after float32 rounding)', () => {
    for (const n of [1, 9, 1000, 20001]) {
      const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + (i % 13 === 0 ? 1 : 0));
      expect(Array.from(decimate2Fft(x))).toEqual(Array.from(decimate2(x)));
    }
  });

  it('DecimationChain: level k = k stages; levels below keepFrom released, the rest reused', () => {
    const mem = new MemTracker();
    const x = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 0.01));
    const chain = new DecimationChain(x, 2, mem);
    const l1 = chain.get(1);
    const l3 = chain.get(3);
    expect(Array.from(l3)).toEqual(Array.from(decimatePow2(x, 3)));
    expect(chain.get(2).length).toBe(4000); // kept (>= keepFrom)
    expect(l1.length).toBe(8000);
    expect(mem.live).toBe((4000 + 2000) * 4); // level 1 released, 2 and 3 held
    chain.release();
    expect(mem.live).toBe(0);
  });
});
