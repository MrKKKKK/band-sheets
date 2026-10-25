import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grid, songText, type TakeDef } from './builder';
import { swingTick, tickTruth } from './truth';
import { writeAll } from './truthCli';

const def: TakeDef = {
  letter: 'e', title: 't', bpm: 100, time: '4/4', style: 's',
  sections: [
    { label: 'A', shuffle: 'none', bars: [grid(8, { HH: 'xxxxxxxx', SD: '..g...a.', BD: 'x...x...' }), ':1 (CR BD)'] },
    { label: 'B', shuffle: '8', bars: [grid(8, { HH: 'xxxxxxxx' })] },
  ],
};

describe('tickTruth', () => {
  const t = tickTruth(songText(def), 'e');
  it('names, held-out, bars and swing come from the score / TAKE_ROLE', () => {
    expect(t.name).toBe('drm-05-e');
    expect(t.heldOut).toBe(true);
    expect([t.bpm, t.ts, t.barTicks, t.nBars]).toEqual([100, [4, 4], 64, 3]);
    expect(t.swingBars).toEqual([{ bar: 0, kind: 'none' }, { bar: 1, kind: 'none' }, { bar: 2, kind: '8' }]);
  });
  it('hits have bar / tick / inst / marks', () => {
    const b0 = t.hits.filter((h) => h.bar === 0);
    expect(b0.filter((h) => h.inst === 'HH').map((h) => h.tick)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(b0.find((h) => h.inst === 'SD' && h.tick === 16)?.mark).toBe('g');
    expect(b0.find((h) => h.inst === 'SD' && h.tick === 48)?.mark).toBe('ac');
    expect(b0.find((h) => h.inst === 'BD' && h.tick === 0)?.mark).toBeUndefined();
    expect(t.hits.filter((h) => h.bar === 1).map((h) => `${h.inst}@${h.tick}`).sort()).toEqual(['BD@0', 'CR@0']);
  });
  it('triplet feel moves only off-beat hits (playTick), plain bars are unchanged', () => {
    const b2 = t.hits.filter((h) => h.bar === 2).map((h) => [h.tick, Number(h.playTick.toFixed(3))]);
    expect(b2).toEqual([[0, 0], [8, 10.667], [16, 16], [24, 26.667], [32, 32], [40, 42.667], [48, 48], [56, 58.667]]);
    expect(t.hits.filter((h) => h.bar === 0).every((h) => h.playTick === h.tick)).toBe(true);
    expect(swingTick(4, '16', [4, 4])).toBeCloseTo(5.333, 3);
  });
  it('CLI writes <x>.ticks.json for the scores present', () => {
    const d = mkdtempSync(join(tmpdir(), 'drm-'));
    writeFileSync(join(d, 'e.song.txt'), songText(def));
    expect(writeAll(d)).toEqual(['drm-05-e']);
    expect(JSON.parse(readFileSync(join(d, 'e.ticks.json'), 'utf8')).nBars).toBe(3);
  });
  it('rejects a section that is not whole bars', () => {
    expect(() => tickTruth(songText({ ...def, sections: [{ label: 'A', shuffle: 'none', bars: [':4 HH HH'] }] }), 'a')).toThrow();
  });
});
