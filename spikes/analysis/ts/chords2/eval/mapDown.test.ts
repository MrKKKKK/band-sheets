import { describe, expect, it } from 'vitest';
import { STAGE_ADDS, stageQualities } from '../vocab';
import { FULL_QUALITIES, fullQuality, MAP_DOWN, mapDown } from './mapDown';

describe('mapDown (落) table', () => {
  it('maps every quality of the full vocabulary as the theory note §4.2 / proposal N7 say', () => {
    const expected: Record<string, string | null> = {
      maj: 'maj', min: 'min', '7': '7', maj7: 'maj7', min7: 'min7', dim: 'dim', aug: 'aug', sus4: 'sus4', m7b5: 'm7b5', dim7: 'dim7',
      mM7: 'min', m6: 'min', '6': 'maj',
      sus2: null, '7sus4': 'sus4', add9: 'maj', madd9: 'min',
      '9': '7', m9: 'min7', maj9: 'maj7',
    };
    expect(stageQualities('V3').sort()).toEqual(Object.keys(expected).sort());
    for (const [q, down] of Object.entries(expected)) expect(mapDown(q), q).toBe(down);
  });
  it('the table rows are exactly the qualities the stages add (V0 maps to itself)', () => {
    expect(Object.keys(MAP_DOWN).sort()).toEqual([...STAGE_ADDS.V1, ...STAGE_ADDS.V2, ...STAGE_ADDS.V3].sort());
  });
  it('verbatim suffixes: spike 6 rules, plus minor-major forms to min', () => {
    expect(mapDown('7(#9)')).toBe('7');
    expect(mapDown('13')).toBe('7');
    expect(mapDown('mM7(9)')).toBe('min');
    expect(mapDown('mM7sus2')).toBeNull();
    expect(mapDown('aug7')).toBeNull();
    expect(mapDown('7(b5)')).toBeNull();
    expect(mapDown('5')).toBe('5');
    expect(mapDown('2')).toBe('maj');
    expect(mapDown(null)).toBeNull();
  });
});

describe('fullQuality (全)', () => {
  it('keeps the full vocabulary and the power chord, drops the rest', () => {
    for (const q of FULL_QUALITIES) expect(fullQuality(q)).toBe(q);
    expect(FULL_QUALITIES).toContain('5');
    expect(fullQuality('13')).toBeNull();
    expect(fullQuality('aug7')).toBeNull();
    expect(fullQuality('2')).toBeNull();
    expect(fullQuality(undefined)).toBeNull();
  });
});
