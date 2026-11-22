import { describe, expect, it } from 'vitest';
import type { RowId } from './baseline';
import { devTakes, expectedTruthHeldOut, groupOf, outsideVocab, pairUnits } from './r2';
import type { EvalChord } from './score';

const beats = [0, 1, 2, 3, 4].map((t) => ({ t }));
const ch = (start: number, end: number, root: string, quality: string, extra: Partial<EvalChord> = {}): EvalChord => ({ start, end, root, quality, bass: null, ...extra });

describe('R2 helpers', () => {
  it('selects only dev takes, sorted; never held-out ones', () => {
    const reg = {
      'chd-11-k-jp': { split: 'heldOut', heldOut: true, variant: 'jp' },
      'chd-07-g': { split: 'dev', heldOut: false },
      'bas-05-e': { split: 'dev', heldOut: false, from: { spike: 6, heldOut: true } },
      'chd-11-k-cp': { split: 'heldOut', heldOut: true },
      odd: { split: 'dev', heldOut: true },
    };
    expect(devTakes(reg)).toEqual(['bas-05-e', 'chd-07-g']);
    expect(() => devTakes(null)).toThrow();
  });

  it('groups by letter and expects spike 6 truth flags for a-f', () => {
    expect(['bas-01-a', 'bas-04-d', 'bas-05-e', 'bas-06-f', 'chd-07-g', 'chd-10-j'].map(groupOf)).toEqual(['a-d', 'a-d', 'e-f', 'e-f', 'g-j', 'g-j']);
    expect(expectedTruthHeldOut({ split: 'dev', heldOut: false, from: { spike: 6, heldOut: true } })).toBe(true);
    expect(expectedTruthHeldOut({ split: 'dev', heldOut: false, from: { spike: 6, heldOut: false } })).toBe(false);
    expect(expectedTruthHeldOut({ split: 'dev', heldOut: false })).toBe(false);
  });

  it('counts points whose full truth quality is outside the stage vocabulary', () => {
    const truth = [ch(0, 2, 'A', 'min', { originalQuality: 'm6' }), ch(2, 4, 'C', 'maj')];
    expect(outsideVocab(truth, beats, 'V0')).toEqual({ out: 2, n: 4 });
    expect(outsideVocab(truth, beats, 'V1')).toEqual({ out: 0, n: 4 });
  });

  it('pair units: pair qualities only, conflict when the bass is not the root, references', () => {
    const truth = [
      ch(0, 1, 'A', 'min7', { bass: 'C', originalQuality: 'min7' }), // conflict (Am7 over C)
      ch(1, 2, 'C', 'maj', { originalQuality: '6' }), // C6 on C, no conflict
      ch(2, 4, 'G', '7'), // not in a pair
    ];
    const got = [ch(0, 2, 'C', 'maj'), ch(2, 4, 'G', '7')];
    const rows = Object.fromEntries(['v1a', 'bassT8', 'bassG2', 'V0', 'V1', 'V2', 'V3'].map((r) => [r, got])) as Record<RowId, EvalChord[]>;
    const u = pairUnits(truth, rows);
    expect(u.byRow.v1a.map((x) => x.conflict)).toEqual([true, false]);
    expect(u.byRow.v1a.map((x) => x.got)).toEqual([{ root: 0, quality: 'maj' }, { root: 0, quality: 'maj' }]);
    expect(u.soundOnly.map((x) => x.got)).toEqual([{ root: 9, quality: 'min7' }, { root: 9, quality: 'min7' }]);
    expect(u.bassOnly.map((x) => x.got)).toEqual([{ root: 0, quality: '6' }, { root: 0, quality: '6' }]);
  });
});
