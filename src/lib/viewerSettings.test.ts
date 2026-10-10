import { describe, expect, it } from 'vitest';
import type { Song } from './song';
import {
  ZOOM_STEPS,
  clampSpeed,
  defaultViewerSettings,
  normalizeViewerSettings,
  zoomStep,
} from './viewerSettings';

const DRUM = '\\instrument percussion\n:4 r';
function song(parts: [string, string][]): Song {
  return {
    meta: {},
    chart: [],
    parts: parts.map(([name, body]) => ({ name, body })),
  } as unknown as Song;
}
const band = song([
  ['ドラム', DRUM],
  ['ボーカル', ':4 c4'],
  ['ベース', ':4 c2'],
]);

describe('defaultViewerSettings', () => {
  it('picks the first non-drum part', () => {
    expect(defaultViewerSettings(band)).toEqual({
      layout: 'part',
      part: 'ボーカル',
      scoreHidden: [],
      scoreChart: true,
      nav: 'page',
      zoom: 1,
      speedPct: 100,
      countIn: true,
      transpose: 0,
    });
  });
  it('falls back to the first part when all are drums', () => {
    expect(defaultViewerSettings(song([['Dr', DRUM]])).part).toBe('Dr');
  });
  it('is chart-only when there are no parts', () => {
    expect(defaultViewerSettings(song([])).part).toBeNull();
  });
});

describe('normalizeViewerSettings', () => {
  const def = defaultViewerSettings(band);
  it('returns defaults for non-objects', () => {
    for (const raw of [undefined, null, 5, 'x', [], true]) {
      expect(normalizeViewerSettings(raw, band)).toEqual(def);
    }
  });
  it('keeps valid values', () => {
    const raw = {
      layout: 'score',
      part: 'ベース',
      scoreHidden: ['ドラム'],
      scoreChart: false,
      nav: 'auto',
      zoom: 1.2,
      speedPct: 75,
      countIn: false,
      transpose: -2,
    };
    expect(normalizeViewerSettings(raw, band)).toEqual(raw);
  });
  it('resets only the bad items', () => {
    const out = normalizeViewerSettings(
      { layout: 'x', part: 'ベース', nav: 3, zoom: 1.15, countIn: 'yes' },
      band,
    );
    expect(out).toEqual({ ...def, part: 'ベース' });
  });
  it('keeps null part (chart only)', () => {
    expect(normalizeViewerSettings({ part: null }, band).part).toBeNull();
  });
  it('falls back to the default part when the saved one is gone or wrong type', () => {
    expect(normalizeViewerSettings({ part: 'ギター' }, band).part).toBe(
      'ボーカル',
    );
    expect(normalizeViewerSettings({ part: 7 }, band).part).toBe('ボーカル');
  });
  it('drops vanished / non-string names from scoreHidden and dedupes', () => {
    const out = normalizeViewerSettings(
      { scoreHidden: ['ドラム', 'ギター', 3, 'ドラム'] },
      band,
    );
    expect(out.scoreHidden).toEqual(['ドラム']);
    expect(
      normalizeViewerSettings({ scoreHidden: 'ドラム' }, band).scoreHidden,
    ).toEqual([]);
  });
  it('clamps speed to the 5% grid and rejects non-numbers', () => {
    expect(normalizeViewerSettings({ speedPct: 999 }, band).speedPct).toBe(150);
    expect(normalizeViewerSettings({ speedPct: 62 }, band).speedPct).toBe(60);
    expect(normalizeViewerSettings({ speedPct: '80' }, band).speedPct).toBe(
      100,
    );
    expect(normalizeViewerSettings({ speedPct: NaN }, band).speedPct).toBe(100);
  });
});

describe('transpose setting', () => {
  it('defaults to 0, rounds and clamps to -6..6', () => {
    expect(normalizeViewerSettings({}, band).transpose).toBe(0);
    expect(normalizeViewerSettings({ transpose: 9 }, band).transpose).toBe(6);
    expect(normalizeViewerSettings({ transpose: -9 }, band).transpose).toBe(-6);
    expect(normalizeViewerSettings({ transpose: 2.6 }, band).transpose).toBe(3);
  });
  it('rejects non-numbers and old settings without it', () => {
    for (const v of ['2', null, NaN, Infinity, true]) {
      expect(normalizeViewerSettings({ transpose: v }, band).transpose).toBe(0);
    }
  });
});

describe('zoomStep', () => {
  it('moves one step', () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
  });
  it('stays at the ends', () => {
    expect(zoomStep(ZOOM_STEPS[0], -1)).toBe(0.8);
    expect(zoomStep(1.4, 1)).toBe(1.4);
  });
  it('snaps an off-grid value to the nearest step first', () => {
    expect(zoomStep(1.04, 1)).toBe(1.1);
  });
});

describe('clampSpeed', () => {
  it('rounds to 5 and clamps', () => {
    expect(clampSpeed(100)).toBe(100);
    expect(clampSpeed(103)).toBe(105);
    expect(clampSpeed(10)).toBe(50);
    expect(clampSpeed(500)).toBe(150);
    expect(clampSpeed(Infinity)).toBe(100);
  });
});
