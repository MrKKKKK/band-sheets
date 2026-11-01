import { describe, expect, it } from 'vitest';
import { highShelf, realGain, realParams, realTimes, resample } from './realistic';
import { allDrumVariants, synthParams } from './variants';

const real = allDrumVariants().filter((v) => v.real);

describe('T12b realistic set (R1)', () => {
  it('81 tuning-only variants, level 1, kits A / D / H, seeds 31-33, fills on', () => {
    expect(real.length).toBe(81);
    for (const v of real) {
      expect([v.split, v.level, v.heldOut, v.ext]).toEqual(['tuning', 1, false, false]);
      expect(['A', 'D', 'H']).toContain(v.kit);
      expect([31, 32, 33]).toContain(v.seed);
      expect(v.name.startsWith('syn-r1-')).toBe(true);
      expect(synthParams(v).fills).toBe(true);
    }
  });

  it('parameters stay in their ranges and are deterministic', () => {
    for (const v of real) {
      const p = realParams(v);
      expect(p).toEqual(realParams(v));
      expect(p.hhDepthDb).toBeGreaterThanOrEqual(6);
      expect(p.hhDepthDb).toBeLessThanOrEqual(15);
      expect(p.hhBusDb).toBeGreaterThanOrEqual(-20);
      expect(p.hhBusDb).toBeLessThanOrEqual(-10);
      expect(p.jitterSigmaSec).toBeGreaterThanOrEqual(0.015);
      expect(p.jitterSigmaSec).toBeLessThanOrEqual(0.025);
      expect(Math.abs(p.driftPerSec * 60)).toBeLessThanOrEqual(0.02);
      for (const o of Object.values(p.instOffsetSec)) expect(Math.abs(o)).toBeLessThanOrEqual(0.01);
    }
  });

  it('simultaneous hits share their jitter (offsets per piece and the drift aside)', () => {
    const v = real[0];
    const p = { ...realParams(v), instOffsetSec: {}, driftPerSec: 0 };
    const timed = [
      { inst: 'BD' as const, tick: 0, bar: 0, t: 1 },
      { inst: 'HH' as const, tick: 0, bar: 0, t: 1 },
      { inst: 'HH' as const, tick: 8, bar: 0, t: 1.25 },
    ];
    const out = realTimes(v, p, timed, 1);
    expect(out[0].t).toBe(out[1].t);
    expect(out[2].t - 1.25).not.toBe(out[0].t - 1);
    for (const h of out) expect(Math.abs(h.t - timed[out.indexOf(h)].t)).toBeLessThanOrEqual(2.5 * p.jitterSigmaSec + 1e-12);
  });

  it('HH level pattern: quarter 0 dB, 8th off-beat -0.6 depth, 16th -depth (+ bus), no change for other pieces', () => {
    const p = { ...realParams(real[0]), levelSigmaDb: 0 };
    const db = (inst: 'HH' | 'SD', tick: number) => 20 * Math.log10(realGain({ inst, tick, bar: 0, t: 0 }, p, 16, () => 0.5));
    expect(db('HH', 0)).toBeCloseTo(p.hhBusDb, 6);
    expect(db('HH', 8)).toBeCloseTo(p.hhBusDb - 0.6 * p.hhDepthDb, 6);
    expect(db('HH', 4)).toBeCloseTo(p.hhBusDb - p.hhDepthDb, 6);
    expect(db('SD', 4)).toBe(0);
  });

  it('high shelf: unity at DC, the gain near Nyquist; resample lowers the pitch', () => {
    const n = 4000;
    const dc = highShelf(new Float32Array(n).fill(1), 6000, -6, 44100);
    expect(dc[n - 1]).toBeCloseTo(1, 4);
    const alt = highShelf(Float32Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1)), 6000, -6, 44100);
    expect(20 * Math.log10(Math.abs(alt[n - 1]))).toBeCloseTo(-6, 1);
    const x = Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 44100));
    const y = resample(x, 0.5);
    let zc = 0;
    for (let i = 1; i < 4410; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    expect(zc).toBeGreaterThanOrEqual(9); // 200 Hz -> 100 Hz: 10 cycles in 0.1 s
    expect(zc).toBeLessThanOrEqual(11);
  });
});
