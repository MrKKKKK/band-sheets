import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTIONS_CONFIG,
  barSpans,
  findSections,
  labelSections,
  snap,
  unpickup,
  type SectionInputs,
} from './sections';

const sc = DEFAULT_SECTIONS_CONFIG;

describe('barSpans', () => {
  it('counts bars from the phase, a trailing partial bar included', () => {
    expect(barSpans(10, 1, 4)).toEqual([[1, 5], [5, 9], [9, 10]]);
  });
  it('puts the pickup first when asked', () => {
    expect(barSpans(10, 1, 4, true)).toEqual([[0, 1], [1, 5], [5, 9], [9, 10]]);
    expect(barSpans(10, 0, 4, true)).toEqual([[0, 4], [4, 8], [8, 10]]);
  });
});

describe('unpickup', () => {
  it('folds the pickup bar into the first section and shifts the rest', () => {
    const got = unpickup([
      { startBar: 0, endBar: 9, label: 'A' },
      { startBar: 9, endBar: 17, label: 'B' },
    ]);
    expect(got).toEqual([
      { startBar: 0, endBar: 8, label: 'A' },
      { startBar: 8, endBar: 16, label: 'B' },
    ]);
  });
  it('drops a section left with no full bar', () => {
    expect(unpickup([{ startBar: 0, endBar: 1, label: 'A' }, { startBar: 1, endBar: 5, label: 'B' }])).toEqual([
      { startBar: 0, endBar: 4, label: 'B' },
    ]);
  });
});

describe('snap', () => {
  it('moves only peaks <= snap_bars // 4 bars off the grid (Python round)', () => {
    // (10 - 0) / 4 = 2.5 -> 2 -> bar 8 is 2 bars away (> 4 // 4 = 1): stays
    expect(snap(10, null, sc)).toBe(10);
    // origin 1: (7 - 1) / 4 = 1.5 -> 2 -> bar 9 is 2 away: stays; (6 - 1) / 4 = 1.25 -> bar 5
    expect(snap(7, null, sc, 1)).toBe(7);
    expect(snap(6, null, sc, 1)).toBe(5);
    expect(snap(9, null, sc)).toBe(8);
  });
  it('keeps a peak pinned by a sharper loudness step', () => {
    const step = new Float64Array(20);
    step[9] = 6;
    step[8] = 1;
    expect(snap(9, step, sc)).toBe(9);
    step[8] = 5;
    expect(snap(9, step, sc)).toBe(8);
  });
});

describe('labelSections', () => {
  it('reuses the label of the most similar earlier section', () => {
    const n = 12;
    const s = new Float64Array(n * n);
    // bars 0-3 and 8-11 alike, 4-7 different
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) s[i * n + j] = (i < 4 || i >= 8) === (j < 4 || j >= 8) ? 1 : 0.2;
    expect(labelSections(s, n, [[0, 4], [4, 8], [8, 12]], 0.85)).toEqual(['A', 'B', 'A']);
  });
  it('goes on past Z as S27', () => {
    const n = 27;
    const s = new Float64Array(n * n);
    const spans = Array.from({ length: n }, (_, i) => [i, i + 1] as [number, number]);
    const got = labelSections(s, n, spans, 0.85);
    expect(got[25]).toBe('Z');
    expect(got[26]).toBe('S27');
  });
});

describe('findSections', () => {
  const flat = (nb: number): SectionInputs => {
    const chroma = new Float64Array(12 * nb);
    for (let r = 0; r < 12; r++) for (let b = 0; b < nb; b++) chroma[r * nb + b] = r === 0 ? 1 : 0.1;
    return {
      chroma,
      bass: null,
      nBeats: nb,
      beatTimes: Float64Array.from({ length: nb }, (_, i) => i * 0.5),
      phase: 0,
      beatsPerBar: 4,
      y: null,
      yPerc: null,
      sr: 22050,
      duration: nb * 0.5,
    };
  };
  it('returns nothing when disabled', () => {
    expect(findSections(flat(64), { ...sc, enabled: false })).toEqual([]);
  });
  it('a short song is one section', () => {
    expect(findSections(flat(20))).toEqual([{ startBar: 0, endBar: 5, label: 'A' }]);
  });
  it('an unchanging song is one section', () => {
    expect(findSections(flat(64))).toEqual([{ startBar: 0, endBar: 16, label: 'A' }]);
  });
  it('splits two different halves at the bar between them', () => {
    const inp = flat(64);
    const c = inp.chroma as Float64Array;
    for (let b = 32; b < 64; b++) {
      c[0 * 64 + b] = 0.1;
      c[7 * 64 + b] = 1;
    }
    expect(findSections(inp)).toEqual([
      { startBar: 0, endBar: 8, label: 'A' },
      { startBar: 8, endBar: 16, label: 'B' },
    ]);
  });
});
