import { describe, expect, it } from 'vitest';
import {
  TUPLET_PRESETS,
  TUPLET_UNITS,
  atoms,
  fillZone,
  groupAt,
  groupsFitBars,
  insertGroup,
  isValidTupletN,
  parseTupletItem,
  removeGroup,
  slotOffset,
  tupletDen,
  tupletGroups,
  tupletTex,
  type Timed,
  type TupletGroup,
  type TupletMark,
} from './tuplet';

interface Ev extends Timed {
  rest: boolean;
  id?: string;
}

const note = (ticks: number, id?: string): Ev => ({ rest: false, ticks, id });
const rest = (ticks: number): Ev => ({ rest: true, ticks });
/** An n-tuplet of `unit`-tick events; `rests` lists slots that are rests. */
const group = (n: number, unit: number, rests: number[] = []): Ev[] =>
  Array.from({ length: n }, (_, slot) => ({
    rest: rests.includes(slot),
    ticks: unit,
    tuplet: { n, slot },
  }));
const makeRest = (ticks: number, mark: TupletMark): Ev => ({
  rest: true,
  ticks,
  tuplet: mark,
});

describe('constants', () => {
  it('presets and units', () => {
    expect(TUPLET_PRESETS).toEqual([3, 5, 6, 7]);
    expect(TUPLET_UNITS).toEqual(['2', '4', '8', '16', '32']);
  });
});

describe('isValidTupletN', () => {
  it.each([
    [2, false],
    [3, true],
    [4, false],
    [5, true],
    [7, true],
    [8, false],
    [9, true],
    [15, true],
    [16, false],
    [0, false],
    [-3, false],
    [3.5, false],
    [NaN, false],
  ])('%s → %s', (n, ok) => {
    expect(isValidTupletN(n)).toBe(ok);
  });
});

describe('tupletDen', () => {
  it.each([
    [2, 1],
    [3, 2],
    [5, 4],
    [6, 4],
    [7, 4],
    [9, 8],
    [12, 8],
    [15, 8],
    [16, 8],
  ])('%s → %s', (n, d) => {
    expect(tupletDen(n)).toBe(d);
  });

  it('rejects n < 2 and non-integers', () => {
    expect(() => tupletDen(1)).toThrow(RangeError);
    expect(() => tupletDen(2.5)).toThrow(RangeError);
  });
});

describe('tupletTex', () => {
  it.each([
    [3, 'tu 3'],
    [5, 'tu 5'],
    [7, 'tu 7'],
    [9, 'tu 9'],
    [12, 'tu 12'],
    [13, 'tu 13 8'],
    [14, 'tu 14 8'],
    [15, 'tu 15 8'],
  ])('%s → %s', (n, tex) => {
    expect(tupletTex(n)).toBe(tex);
  });

  it('throws for invalid n', () => {
    expect(() => tupletTex(4)).toThrow(RangeError);
    expect(() => tupletTex(16)).toThrow(RangeError);
  });
});

describe('parseTupletItem', () => {
  it('accepts N with no denominator when alphaTab has a default for it', () => {
    // Verified against alphaTab 1.8.4's AlphaTexImporter: `{tu N}` with no
    // denominator imports fine for 3,5,6,7,9,10,11,12; 13,14,15 do not
    // (docs/m5-review.md R3).
    expect(parseTupletItem(['3'])).toEqual({ n: 3 });
    expect(parseTupletItem(['5'])).toEqual({ n: 5 });
    expect(parseTupletItem(['6'])).toEqual({ n: 6 });
    expect(parseTupletItem(['7'])).toEqual({ n: 7 });
    expect(parseTupletItem(['9'])).toEqual({ n: 9 });
    expect(parseTupletItem(['10'])).toEqual({ n: 10 });
    expect(parseTupletItem(['11'])).toEqual({ n: 11 });
    expect(parseTupletItem(['12'])).toEqual({ n: 12 });
  });

  it('accepts N D with the matching denominator for any valid N, including 13-15', () => {
    expect(parseTupletItem(['3', '2'])).toEqual({ n: 3 });
    expect(parseTupletItem(['13', '8'])).toEqual({ n: 13 });
    expect(parseTupletItem(['14', '8'])).toEqual({ n: 14 });
    expect(parseTupletItem(['15', '8'])).toEqual({ n: 15 });
  });

  it('rejects N with no denominator when alphaTab has no default for it (13-15)', () => {
    expect(parseTupletItem(['13'])).toHaveProperty('error');
    expect(parseTupletItem(['14'])).toHaveProperty('error');
    expect(parseTupletItem(['15'])).toHaveProperty('error');
  });

  it.each([
    [[]],
    [['3', '2', '1']],
    [['x']],
    [['3', 'a']],
    [['-3']],
    [['2']],
    [['4']],
    [['8']],
    [['16']],
    [['3', '4']],
    [['6', '8']],
  ])('rejects %j', (args) => {
    expect(parseTupletItem(args)).toHaveProperty('error');
  });
});

describe('tupletGroups', () => {
  it('finds groups and their spans per unit', () => {
    const cases: [number, number, number][] = [
      // n, unitTicks, span
      [3, 32, 64], // half-note triplet = whole
      [3, 16, 32], // quarter triplet = half
      [3, 8, 16], // eighth triplet = quarter
      [3, 4, 8],
      [3, 2, 4],
      [5, 4, 16], // 16th quintuplet = quarter
      [6, 4, 16],
      [7, 4, 16],
      [11, 2, 16], // 32nd 11-tuplet = quarter
      [15, 2, 16],
    ];
    for (const [n, unit, span] of cases) {
      expect(tupletGroups(group(n, unit))).toEqual([
        { start: 0, end: n, n, unitTicks: unit, span },
      ]);
    }
  });

  it('handles singles around and two adjacent groups of the same n', () => {
    const evs = [note(16), ...group(3, 8), ...group(3, 8), note(8)];
    expect(tupletGroups(evs)).toEqual([
      { start: 1, end: 4, n: 3, unitTicks: 8, span: 16 },
      { start: 4, end: 7, n: 3, unitTicks: 8, span: 16 },
    ]);
    expect(tupletGroups([note(16), rest(8)])).toEqual([]);
    expect(tupletGroups([])).toEqual([]);
  });

  const broken: [string, Ev[]][] = [
    ['starts mid-group', group(3, 8).slice(1)],
    ['cut short by a plain event', [...group(3, 8).slice(0, 2), note(8)]],
    ['cut short at the end', group(5, 4).slice(0, 4)],
    ['cut short by a new group', [...group(3, 8).slice(0, 2), ...group(3, 8)]],
    [
      'mixed n',
      [
        ...group(3, 8).slice(0, 2),
        { rest: true, ticks: 8, tuplet: { n: 5, slot: 2 } },
      ],
    ],
    ['slots out of order', [group(3, 8)[0], group(3, 8)[2], group(3, 8)[1]]],
    [
      'mixed lengths',
      [...group(3, 8).slice(0, 2), { ...group(3, 8)[2], ticks: 16 }],
    ],
    ['dotted unit', group(3, 12)],
    ['whole-note unit', group(3, 64)],
    ['invalid n (4)', group(4, 8)],
    ['invalid n (16)', group(16, 2)],
  ];
  it.each(broken)('reports a broken group: %s', (_, evs) => {
    const r = tupletGroups(evs);
    expect(r).toHaveProperty('error');
    expect(typeof (r as { error: string }).error).toBe('string');
  });
});

describe('atoms', () => {
  it('lists singles and groups in order', () => {
    const evs = [note(16), ...group(3, 8), rest(8)];
    expect(atoms(evs)).toEqual([
      { kind: 'single', index: 0, ticks: 16 },
      {
        kind: 'group',
        group: { start: 1, end: 4, n: 3, unitTicks: 8, span: 16 },
      },
      { kind: 'single', index: 4, ticks: 8 },
    ]);
  });

  it('throws on a broken group', () => {
    expect(() => atoms(group(3, 8).slice(1))).toThrow(RangeError);
  });
});

describe('groupAt', () => {
  const evs = [note(16), ...group(3, 8), note(8)];
  it('returns the containing group', () => {
    expect(groupAt(evs, 0)).toBeNull();
    expect(groupAt(evs, 1)).toMatchObject({ start: 1, end: 4 });
    expect(groupAt(evs, 3)).toMatchObject({ start: 1, end: 4 });
    expect(groupAt(evs, 4)).toBeNull();
    expect(groupAt(evs, 99)).toBeNull();
  });

  it('throws on a broken group', () => {
    expect(() => groupAt(group(3, 8).slice(0, 2), 0)).toThrow(RangeError);
  });
});

describe('fillZone', () => {
  const isRestOf = (evs: Ev[]) => (i: number) => evs[i].rest;

  it('at the start: only when the whole group is rests', () => {
    const fresh = [note(16), ...group(3, 8, [0, 1, 2])];
    expect(fillZone(fresh, 1, isRestOf(fresh))).toMatchObject({ start: 1 });
    const partly = [note(16), ...group(3, 8, [1, 2])];
    expect(fillZone(partly, 1, isRestOf(partly))).toBeNull();
    const lastFilled = [note(16), ...group(3, 8, [0, 1])];
    expect(fillZone(lastFilled, 1, isRestOf(lastFilled))).toBeNull();
  });

  it('in the middle: always', () => {
    const evs = [note(16), ...group(3, 8, [2])];
    expect(fillZone(evs, 2, isRestOf(evs))).toMatchObject({ start: 1 });
    expect(fillZone(evs, 3, isRestOf(evs))).toMatchObject({ start: 1 });
  });

  it('at the end or outside: never', () => {
    const evs = [note(16), ...group(3, 8, [0, 1, 2]), note(8)];
    expect(fillZone(evs, 4, isRestOf(evs))).toBeNull();
    expect(fillZone(evs, 0, isRestOf(evs))).toBeNull();
    expect(fillZone(evs, 5, isRestOf(evs))).toBeNull();
  });

  it('distinguishes adjacent groups', () => {
    const evs = [...group(3, 8), ...group(3, 8, [0, 1, 2])];
    // Cursor 3 is the end of the first (filled) group and the start of the
    // second (all-rest) one.
    expect(fillZone(evs, 3, isRestOf(evs))).toMatchObject({ start: 3 });
  });

  it('throws on a broken group', () => {
    const evs = group(3, 8).slice(1);
    expect(() => fillZone(evs, 0, isRestOf(evs))).toThrow(RangeError);
  });
});

describe('insertGroup', () => {
  it('inserts n rests of the unit with marks', () => {
    const evs = [note(16, 'a'), note(16, 'b')];
    const r = insertGroup(evs, 1, 3, '8', makeRest);
    expect(r).toEqual([
      note(16, 'a'),
      ...group(3, 8, [0, 1, 2]),
      note(16, 'b'),
    ]);
    expect(insertGroup([], 0, 5, '16', makeRest)).toEqual(
      group(5, 4, [0, 1, 2, 3, 4]),
    );
    expect(evs).toHaveLength(2);
  });

  it('may go right before or after another group', () => {
    const evs = group(3, 8);
    expect(insertGroup(evs, 0, 3, '8', makeRest)).toHaveLength(6);
    expect(insertGroup(evs, 3, 3, '8', makeRest)).toHaveLength(6);
  });

  it('refuses inside a group, invalid n or unit', () => {
    const evs = [note(16), ...group(3, 8)];
    expect(insertGroup(evs, 2, 3, '8', makeRest)).toEqual({
      error: '連符の中に連符は入れられません',
    });
    expect(insertGroup(evs, 0, 4, '8', makeRest)).toHaveProperty('error');
    expect(insertGroup(evs, 0, 16, '8', makeRest)).toHaveProperty('error');
    expect(insertGroup(evs, 0, 3, '1', makeRest)).toHaveProperty('error');
  });

  it('throws for an out-of-range position', () => {
    expect(() => insertGroup([], 1, 3, '8', makeRest)).toThrow(RangeError);
    expect(() => insertGroup([], -1, 3, '8', makeRest)).toThrow(RangeError);
  });
});

describe('removeGroup', () => {
  it('removes the whole group from any slot', () => {
    const evs = [note(16, 'a'), ...group(3, 8), note(8, 'b')];
    for (const i of [1, 2, 3]) {
      expect(removeGroup(evs, i)).toEqual({
        events: [note(16, 'a'), note(8, 'b')],
        start: 1,
      });
    }
  });

  it('throws outside a group', () => {
    expect(() => removeGroup([note(16), ...group(3, 8)], 0)).toThrow(
      RangeError,
    );
  });
});

describe('groupsFitBars', () => {
  const bar = 64; // 4/4

  it('accepts groups inside bars, including at a bar end and bar start', () => {
    expect(groupsFitBars([], bar)).toEqual({ ok: true });
    // 3 quarters + eighth triplet (span 16) ends exactly at the barline.
    expect(
      groupsFitBars([note(16), note(16), note(16), ...group(3, 8)], bar),
    ).toEqual({ ok: true });
    // A whole bar, then a triplet at the start of bar 2.
    expect(groupsFitBars([note(64), ...group(3, 8)], bar)).toEqual({
      ok: true,
    });
    // Half-note triplet fills a whole 4/4 bar.
    expect(groupsFitBars(group(3, 32), bar)).toEqual({ ok: true });
  });

  it('allows singles to cross barlines', () => {
    expect(groupsFitBars([note(48), note(32), ...group(3, 8)], bar)).toEqual({
      ok: true,
    });
  });

  it('rejects a group crossing a barline, naming the bar', () => {
    // 3 quarters + eighth = 56, triplet span 16 crosses into bar 2.
    const evs = [note(16), note(16), note(16), note(8), ...group(3, 8)];
    expect(groupsFitBars(evs, bar)).toEqual({
      ok: false,
      error: '1 小節目の 3 連符が小節線をまたぎます',
    });
    const late = [note(64), note(48), note(8), ...group(5, 4)];
    expect(groupsFitBars(late, bar)).toEqual({
      ok: false,
      error: '2 小節目の 5 連符が小節線をまたぎます',
    });
    // Half-note triplet does not fit 3/4.
    expect(groupsFitBars(group(3, 32), 48)).toMatchObject({ ok: false });
  });

  it('reports broken groups as not ok', () => {
    expect(groupsFitBars(group(3, 8).slice(1), bar)).toMatchObject({
      ok: false,
    });
  });

  it('throws for an invalid bar length', () => {
    expect(() => groupsFitBars([], 0)).toThrow(RangeError);
  });
});

describe('slotOffset', () => {
  const g: TupletGroup = { start: 0, end: 3, n: 3, unitTicks: 8, span: 16 };
  it('spreads slots evenly over the span', () => {
    expect(slotOffset(g, 0)).toBe(0);
    expect(slotOffset(g, 1)).toBeCloseTo(16 / 3);
    expect(slotOffset(g, 2)).toBeCloseTo(32 / 3);
    expect(slotOffset(g, 3)).toBe(16);
  });

  it('throws out of range', () => {
    expect(() => slotOffset(g, -1)).toThrow(RangeError);
    expect(() => slotOffset(g, 4)).toThrow(RangeError);
  });
});
