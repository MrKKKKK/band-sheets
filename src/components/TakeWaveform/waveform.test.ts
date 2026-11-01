import { describe, expect, it } from 'vitest';
import { barLineTimes, waveformColumns } from './waveform';

describe('waveformColumns', () => {
  it('keeps the largest peak of each column', () => {
    expect(waveformColumns([0.1, 0.5, 0.2, 0.3], 2)).toEqual([0.5, 0.3]);
  });
  it('never makes more columns than peaks', () => {
    expect(waveformColumns([0.1, 0.2], 10)).toEqual([0.1, 0.2]);
  });
  it('is empty without peaks and clamps to 0–1', () => {
    expect(waveformColumns([], 5)).toEqual([]);
    expect(waveformColumns([2, -1], 2)).toEqual([1, 0]);
  });
});

describe('barLineTimes', () => {
  it('starts at 0 and steps by a bar', () => {
    expect(barLineTimes(10, 2.5)).toEqual([0, 2.5, 5, 7.5]);
  });
  it('is empty for a bad length', () => {
    expect(barLineTimes(0, 2)).toEqual([]);
    expect(barLineTimes(5, 0)).toEqual([]);
  });
});
