import { describe, expect, it } from 'vitest';
import { levelDb, normalizeLevel, PEAK_CEILING_DB, TARGET_RMS_DB } from '../../../../../src/lib/analysis/inputLevel';
import { CHORDS_SR, prepareInput } from './input';

const tone = (sr: number, sec: number, amp: number): Float32Array => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr));

describe('prepareInput (runChords.ts order: resample, then normalize)', () => {
  it('off: only the resampling; the result is at 22,050 Hz', () => {
    const x = tone(44100, 1, 0.01);
    const p = prepareInput(x, 44100, false);
    expect(p.sampleRate).toBe(CHORDS_SR);
    expect(p.y.length).toBe(22050);
    expect(p.gainDb).toBe(0);
    expect(Math.abs(levelDb(p.y).rmsDb - levelDb(x).rmsDb)).toBeLessThan(0.05);
  });
  it('on: the RMS after resampling is the target (or the peak cap)', () => {
    const x = tone(44100, 1, 0.01);
    const p = prepareInput(x, 44100, true);
    const l = levelDb(p.y);
    expect(l.rmsDb).toBeCloseTo(TARGET_RMS_DB, 3);
    expect(l.peakDb).toBeLessThanOrEqual(PEAK_CEILING_DB + 1e-9);
    expect(p.gainDb).toBeCloseTo(TARGET_RMS_DB - levelDb(x).rmsDb, 1); // about +21 dB
  });
  it('on: normalization comes after resampling (the gain is that of the 22,050 Hz signal) and caps the peak', () => {
    const x = tone(44100, 1, 0.9);
    const p = prepareInput(x, 44100, true);
    const ref = prepareInput(x, 44100, false);
    const g = normalizeLevel(ref.y);
    expect(p.gainDb).toBe(g);
    expect(levelDb(p.y).peakDb).toBeLessThanOrEqual(PEAK_CEILING_DB + 1e-9);
  });
  it('never changes its input, also at the same rate (resampleSinc returns the input there)', () => {
    const x = tone(22050, 1, 0.01);
    const before = x.slice();
    prepareInput(x, 22050, true);
    expect(x).toEqual(before);
  });
  it('silence is left untouched', () => {
    const p = prepareInput(new Float32Array(44100), 44100, true);
    expect(p.gainDb).toBe(0);
    expect(levelDb(p.y).peakDb).toBeLessThan(-200);
  });
});
