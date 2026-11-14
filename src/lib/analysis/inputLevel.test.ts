import { describe, expect, it } from 'vitest';
import {
  levelDb,
  normalizeGainDb,
  normalizeLevel,
  PEAK_CEILING_DB,
  TARGET_RMS_DB,
} from './inputLevel';
import { SILENCE_PEAK } from './chords/analyze';

const db = (x: number) => 20 * Math.log10(x);

describe('constants', () => {
  it('are the spike 6 R3 values', () => {
    expect(TARGET_RMS_DB).toBe(-22);
    expect(PEAK_CEILING_DB).toBe(-1);
  });
});

describe('levelDb', () => {
  it('measures whole-array RMS and peak in dBFS', () => {
    const y = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const l = levelDb(y);
    expect(l.rmsDb).toBeCloseTo(db(0.5), 9);
    expect(l.peakDb).toBeCloseTo(db(0.5), 9);
  });
  it('floors empty and all-zero input at -240 dB instead of -Infinity', () => {
    expect(levelDb(new Float32Array(0))).toEqual({ rmsDb: -240, peakDb: -240 });
    expect(levelDb(new Float32Array(8))).toEqual({ rmsDb: -240, peakDb: -240 });
  });
});

describe('normalizeGainDb', () => {
  it('quiet file: brings RMS to the target', () => {
    expect(normalizeGainDb(-39, -20)).toBeCloseTo(17, 12);
  });
  it('peak-limited: stops at the ceiling', () => {
    // target would need +10, but the peak at -6 only has 5 dB of room
    expect(normalizeGainDb(-32, -6)).toBeCloseTo(5, 12);
  });
  it('already loud: attenuates (negative gain)', () => {
    expect(normalizeGainDb(-10, -0.5)).toBeCloseTo(-12, 12);
  });
});

describe('normalizeLevel', () => {
  it('scales a quiet signal to the target RMS and returns the applied dB', () => {
    const y = new Float32Array(1000);
    for (let i = 0; i < y.length; i++) y[i] = 0.01 * Math.sin(i * 0.1);
    const before = levelDb(y);
    const g = normalizeLevel(y);
    expect(g).toBeCloseTo(normalizeGainDb(before.rmsDb, before.peakDb), 9);
    expect(levelDb(y).rmsDb).toBeCloseTo(TARGET_RMS_DB, 3);
  });
  it('limits a peaky signal to the ceiling', () => {
    const y = new Float32Array(1000);
    y[10] = 0.2;
    y[500] = -0.001;
    normalizeLevel(y);
    expect(levelDb(y).peakDb).toBeCloseTo(PEAK_CEILING_DB, 3);
  });
  it('attenuates a clipped 0 dBFS input to a peak at or below -1 dBFS', () => {
    const y = new Float32Array(1000).map((_, i) => (i % 2 ? 1 : -1));
    const g = normalizeLevel(y);
    expect(g).toBeLessThan(0);
    expect(levelDb(y).peakDb).toBeLessThanOrEqual(PEAK_CEILING_DB + 1e-6);
  });
  it('handles a single sample', () => {
    const y = new Float32Array([0.001]);
    normalizeLevel(y);
    expect(levelDb(y).peakDb).toBeLessThanOrEqual(PEAK_CEILING_DB + 1e-6);
    expect(Number.isFinite(y[0])).toBe(true);
  });
  it('leaves empty and all-zero input untouched and returns 0', () => {
    const e = new Float32Array(0);
    expect(normalizeLevel(e)).toBe(0);
    const z = new Float32Array(16);
    expect(normalizeLevel(z)).toBe(0);
    expect(Array.from(z).every((v) => v === 0)).toBe(true);
  });
  it('leaves a signal at or below SILENCE_PEAK untouched (stays silent for the analyzer)', () => {
    const y = new Float32Array(100).fill(SILENCE_PEAK);
    expect(normalizeLevel(y)).toBe(0);
    expect(y[0]).toBe(SILENCE_PEAK);
  });
  it.each([NaN, Infinity, -Infinity])(
    'leaves input containing %s untouched and returns 0',
    (bad) => {
      const y = new Float32Array([0.1, bad, -0.2]);
      const copy = y.slice();
      expect(normalizeLevel(y)).toBe(0);
      expect(Array.from(y)).toEqual(Array.from(copy));
    },
  );
  it('is idempotent: a second pass applies (almost) no gain', () => {
    const y = new Float32Array(1000);
    for (let i = 0; i < y.length; i++) y[i] = 0.01 * Math.sin(i * 0.1);
    normalizeLevel(y);
    expect(Math.abs(normalizeLevel(y))).toBeLessThan(1e-4);
  });
});
