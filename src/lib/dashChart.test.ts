import { describe, expect, it } from 'vitest';
import {
  barUnits,
  dashBarCount,
  isDashLine,
  meterOf,
  parseDashLine,
  validateDashLine,
  writeDashBar,
  writeDashChart,
  writeDashLine,
} from './dashChart';
import { parseSong } from './parseSong';
import type { LyricLine } from './song';

const t44 = { num: 4, den: 4 };
const t34 = { num: 3, den: 4 };
const t68 = { num: 6, den: 8 };
const t24 = { num: 2, den: 4 };

/** Parses one chart line of ChordPro text. */
function line(text: string): LyricLine {
  const song = parseSong(`{start_of_verse: A}\n${text}\n{end_of_verse}\n`);
  const l = song.chart[0].lines[0];
  if ('raw' in l) throw new Error('raw line');
  return l;
}

describe('barUnits', () => {
  it('counts sixteenths per bar', () => {
    expect(barUnits(t44)).toBe(16);
    expect(barUnits(t34)).toBe(12);
    expect(barUnits(t68)).toBe(12);
    expect(barUnits(t24)).toBe(8);
    expect(barUnits({ num: 5, den: 4 })).toBe(20);
    expect(barUnits({ num: 3, den: 16 })).toBe(3);
  });
  it('rejects meters that are not a whole number of sixteenths', () => {
    expect(barUnits({ num: 4, den: 32 })).toBeNull();
    expect(barUnits({ num: 0, den: 4 })).toBeNull();
    expect(barUnits({ num: 4, den: 3 })).toBeNull();
  });
});

describe('isDashLine', () => {
  it('accepts lines with only chords, | - = and spaces', () => {
    expect(isDashLine(line('|[C]--------|[C]----[F]----|'))).toBe(true);
    expect(isDashLine(line('| [C][G] |'))).toBe(true);
    expect(isDashLine(line('[C]--|[G]=='))).toBe(true);
    expect(isDashLine(line('|[C]---- ----|'))).toBe(true);
  });
  it('rejects lines without |, with other text, raw and blank lines', () => {
    expect(isDashLine(line('[C]--------'))).toBe(false);
    expect(isDashLine(line('[C][G]'))).toBe(false);
    expect(isDashLine(line('|[C]ら--------|'))).toBe(false);
    expect(isDashLine(line('きらきら | ひかる'))).toBe(false);
    expect(isDashLine(line('---'))).toBe(false);
    expect(isDashLine(line(''))).toBe(false);
    expect(isDashLine({ raw: '# |--|' })).toBe(false);
  });
});

describe('dashBarCount', () => {
  it('counts bars between |, ignoring leading / trailing / empty ones', () => {
    expect(
      dashBarCount(
        line('|[C]--------|[C]----[F]----|[G]--------|[G]--------|'),
      ),
    ).toBe(4);
    expect(dashBarCount(line('[C]--------|[G]--------'))).toBe(2);
    expect(dashBarCount(line('|[C]--------||[G]--------|'))).toBe(2);
    expect(dashBarCount(line('| [C][G] |'))).toBe(1);
    expect(dashBarCount(line('|--------|[C]--------|'))).toBe(2);
    expect(dashBarCount(line('| |'))).toBe(0);
  });
});

describe('parseDashLine', () => {
  it('reads chord positions and lengths in sixteenths', () => {
    const r = parseDashLine(line('|[C]--------|[C]----[F]----|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars).toEqual([
      { leading: 0, chords: [{ chord: 'C', start: 0, length: 16 }] },
      {
        leading: 0,
        chords: [
          { chord: 'C', start: 0, length: 8 },
          { chord: 'F', start: 8, length: 8 },
        ],
      },
    ]);
  });
  it('counts only dashes: the chord name has no length', () => {
    const r = parseDashLine(line('|[Dm]---[Am7]- --[Abm7]--|'), {
      num: 4,
      den: 4,
    });
    expect(r.errors).toEqual([]);
    expect(r.bars[0].chords.map((c) => c.length)).toEqual([6, 6, 4]);
  });
  it('counts = as a sixteenth', () => {
    const r = parseDashLine(line('|[C]-------=[G]=|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[0].chords).toEqual([
      { chord: 'C', start: 0, length: 15 },
      { chord: 'G', start: 15, length: 1 },
    ]);
  });
  it('ignores spaces and works without outer |', () => {
    const r = parseDashLine(line('[C]-- -- --  -- | [G]----  ----'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars).toHaveLength(2);
  });
  it('splits a bar equally when no chord has a dash', () => {
    const r = parseDashLine(line('| [C][G] |[F][G][C][Am]|[C]|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[0].chords).toEqual([
      { chord: 'C', start: 0, length: 8 },
      { chord: 'G', start: 8, length: 8 },
    ]);
    expect(r.bars[1].chords.map((c) => c.length)).toEqual([4, 4, 4, 4]);
    expect(r.bars[2].chords).toEqual([{ chord: 'C', start: 0, length: 16 }]);
  });
  it('splits a bar that does not divide evenly without gaps', () => {
    const r = parseDashLine(line('|[C][F][G]|'), t44);
    const c = r.bars[0].chords;
    expect(c.map((x) => x.start)).toEqual([0, 5, 11]);
    expect(c.reduce((s, x) => s + x.length, 0)).toBe(16);
  });
  it('lets leading dashes continue the previous bar last chord', () => {
    const r = parseDashLine(line('|[C]--------|--[G]------|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[1]).toEqual({
      leading: 4,
      chords: [{ chord: 'G', start: 4, length: 12 }],
    });
  });
  it('accepts a bar that only continues the previous chord', () => {
    const r = parseDashLine(line('|[C]--------|--------|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[1]).toEqual({ leading: 16, chords: [] });
  });
  it('works in 3/4, 6/8 and 2/4', () => {
    expect(validateDashLine(line('|[C]------|[G]---[C]---|'), t34)).toEqual([]);
    expect(validateDashLine(line('|[C]---[G]---|'), t68)).toEqual([]);
    expect(validateDashLine(line('|[C]----|[G]--[C]--|'), t24)).toEqual([]);
    expect(validateDashLine(line('|[C]--------|'), t34)).toHaveLength(1);
    expect(validateDashLine(line('|[C]------|'), t24)).toHaveLength(1);
  });
  it('treats N.C. as an ordinary chord name', () => {
    const r = parseDashLine(line('|[N.C.]--------|[Am?]----[G]----|'), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[0].chords[0].chord).toBe('N.C.');
    expect(r.bars[1].chords[0].chord).toBe('Am?');
  });
  it('reports a meter that dash notation cannot express', () => {
    expect(validateDashLine(line('|[C]--|'), { num: 4, den: 32 })).toEqual([
      '拍子 4/32 はダッシュ記法に対応していません',
    ]);
  });
});

describe('validateDashLine', () => {
  it('returns no errors for a correct line', () => {
    expect(
      validateDashLine(
        line('|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|'),
        t44,
      ),
    ).toEqual([]);
  });
  it('reports too few / too many dashes with the bar number', () => {
    const errors = validateDashLine(
      line('|[C]--------|[C]---[F]----|[G]---------|'),
      t44,
    );
    expect(errors).toEqual([
      '2小節目: ダッシュの合計が八分音符 7 個ぶんです（4/4 は 8 個ぶん）',
      '3小節目: ダッシュの合計が八分音符 9 個ぶんです（4/4 は 8 個ぶん）',
    ]);
  });
  it('shows half eighths for =', () => {
    expect(validateDashLine(line('|[C]-------=|'), t44)).toEqual([
      '1小節目: ダッシュの合計が八分音符 7.5 個ぶんです（4/4 は 8 個ぶん）',
    ]);
  });
  it('reports a chord without dashes in a bar where others have them', () => {
    expect(validateDashLine(line('|[C]--------[G]|'), t44)).toEqual([
      '1小節目: [G] にダッシュがありません（ほかのコードにはあります）',
    ]);
  });
  it('reports leading dashes that do not fill the bar when chords have no dash', () => {
    expect(validateDashLine(line('|--[C][G]|'), t44)).toHaveLength(1);
  });
});

describe('writeDashBar', () => {
  it('writes one chord over the whole bar with explicit dashes', () => {
    expect(writeDashBar([{ chord: 'C', start: 0 }], t44)).toBe('[C]--------');
  });
  it('writes lengths as floor(L/2) dashes plus = for odd L', () => {
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'G', start: 5 },
          { chord: 'F', start: 6 },
        ],
        t44,
      ),
    ).toBe('[C]--=[G]=[F]-----');
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'G', start: 15 },
        ],
        t44,
      ),
    ).toBe('[C]-------=[G]=');
  });
  it('snaps starts to the sixteenth grid', () => {
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0.2 },
          { chord: 'G', start: 7.6 },
        ],
        t44,
      ),
    ).toBe('[C]----[G]----');
  });
  it('merges zero-length chords and equal neighbours', () => {
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'D', start: 7.9 },
          { chord: 'G', start: 8.1 },
        ],
        t44,
      ),
    ).toBe('[C]----[G]----');
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'C', start: 8 },
        ],
        t44,
      ),
    ).toBe('[C]--------');
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'G', start: 15.9 },
        ],
        t44,
      ),
    ).toBe('[C]--------');
  });
  it('starts the bar with a chord even if the first starts late', () => {
    expect(writeDashBar([{ chord: 'G', start: 4 }], t44)).toBe('[G]--------');
  });
  it('sorts chords by start', () => {
    expect(
      writeDashBar(
        [
          { chord: 'G', start: 8 },
          { chord: 'C', start: 0 },
        ],
        t44,
      ),
    ).toBe('[C]----[G]----');
  });
  it('writes N.C. for a bar without chords and keeps ? in the name', () => {
    expect(writeDashBar([], t44)).toBe('[N.C.]--------');
    expect(writeDashBar([{ chord: 'Am?', start: 0 }], t34)).toBe('[Am?]------');
  });
  it('writes other meters', () => {
    expect(
      writeDashBar(
        [
          { chord: 'C', start: 0 },
          { chord: 'G', start: 6 },
        ],
        t68,
      ),
    ).toBe('[C]---[G]---');
    expect(writeDashBar([{ chord: 'C', start: 0 }], t24)).toBe('[C]----');
  });
  it('throws on an unsupported meter', () => {
    expect(() => writeDashBar([], { num: 4, den: 32 })).toThrow();
  });
});

describe('writeDashLine / writeDashChart', () => {
  const bar = (chord: string) => [{ chord, start: 0 }];
  it('wraps bars in |', () => {
    expect(writeDashLine([bar('C'), bar('G')], t44)).toBe(
      '|[C]--------|[G]--------|',
    );
  });
  it('puts 4 bars on a line; the last line may be shorter', () => {
    const bars = ['C', 'F', 'G', 'C', 'Am', 'G'].map(bar);
    const lines = writeDashChart(bars, t44);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('|[Am]--------|[G]--------|');
    expect(writeDashChart([], t44)).toEqual([]);
  });
  it('round-trips through parseDashLine', () => {
    const bars = [
      [
        { chord: 'C', start: 0 },
        { chord: 'G', start: 5 },
      ],
      [{ chord: 'Am?', start: 0 }],
      [],
      [
        { chord: 'F', start: 0 },
        { chord: 'G7', start: 11 },
      ],
    ];
    const text = writeDashLine(bars, t44);
    const r = parseDashLine(line(text), t44);
    expect(r.errors).toEqual([]);
    expect(r.bars.map((b) => b.chords.map((c) => [c.chord, c.start]))).toEqual([
      [
        ['C', 0],
        ['G', 5],
      ],
      [['Am?', 0]],
      [['N.C.', 0]],
      [
        ['F', 0],
        ['G7', 11],
      ],
    ]);
  });
});

describe('meterOf', () => {
  it('reads n/d and falls back to 4/4', () => {
    expect(meterOf('3/4')).toEqual({ num: 3, den: 4 });
    expect(meterOf(' 6 / 8 ')).toEqual({ num: 6, den: 8 });
    expect(meterOf(undefined)).toEqual({ num: 4, den: 4 });
    expect(meterOf('abc')).toEqual({ num: 4, den: 4 });
  });
});

describe('writer carries chords across bars', () => {
  it('writes the carry chord at 0 when the first chord starts late', () => {
    expect(writeDashBar([{ chord: 'F', start: 8 }], t44, 'C')).toBe(
      '[C]----[F]----',
    );
    // Very first bar (no carry): the first chord moves to 0.
    expect(writeDashBar([{ chord: 'F', start: 8 }], t44)).toBe('[F]--------');
  });
  it('carries the previous bar last chord in writeDashChart', () => {
    const lines = writeDashChart(
      [[{ chord: 'C', start: 0 }], [{ chord: 'G', start: 4 }], []],
      t44,
    );
    expect(lines).toEqual(['|[C]--------|[C]--[G]------|[N.C.]--------|']);
  });
  it('carries across lines', () => {
    const bars = [
      [{ chord: 'C', start: 0 }],
      [{ chord: 'C', start: 0 }],
      [{ chord: 'C', start: 0 }],
      [{ chord: 'C', start: 0 }],
      [{ chord: 'G', start: 8 }],
    ];
    expect(writeDashChart(bars, t44)[1]).toBe('|[C]----[G]----|');
  });
  it('moves a chord that snaps to the bar end into the next bar', () => {
    const lines = writeDashChart(
      [
        [
          { chord: 'C', start: 0 },
          { chord: 'G', start: 15.8 },
        ],
        [{ chord: 'F', start: 4 }],
      ],
      t44,
    );
    expect(lines).toEqual(['|[C]--------|[G]--[F]------|']);
    // ...and is simply replaced when the next bar starts with its own chord.
    expect(
      writeDashChart(
        [
          [
            { chord: 'C', start: 0 },
            { chord: 'G', start: 16 },
          ],
          [{ chord: 'F', start: 0 }],
        ],
        t44,
      ),
    ).toEqual(['|[C]--------|[F]--------|']);
  });
  it('keeps an empty bar as N.C. and carries the N.C. forward', () => {
    expect(writeDashChart([[], [{ chord: 'G', start: 8 }]], t44)[0]).toBe(
      '|[N.C.]--------|[N.C.]----[G]----|',
    );
  });
  it('throws on a non-finite start', () => {
    expect(() => writeDashBar([{ chord: 'C', start: NaN }], t44)).toThrow();
  });
});

describe('meterOf falls back to 4/4 for invalid meters', () => {
  it.each(['0/4', '4/3', '7/32', '4/0', '', '3/4/4'])('%s', (t) => {
    expect(meterOf(t)).toEqual({ num: 4, den: 4 });
  });
  it('keeps valid ones', () => {
    expect(meterOf('6/8')).toEqual({ num: 6, den: 8 });
  });
});

describe('what is (not) a dash line — pinned behaviour', () => {
  it('lines with only | are dash lines with no bars', () => {
    for (const t of ['|', '||', '| |']) {
      const l = line(t);
      expect(isDashLine(l)).toBe(true);
      expect(dashBarCount(l)).toBe(0);
    }
  });
  it('full-width or look-alike characters make it a normal line', () => {
    for (const t of [
      '｜[C]--------｜',
      '|[C]ーーーーーーーー|',
      '|[C]————————|',
      '|[C]－－－－－－－－|',
    ])
      expect(isDashLine(line(t))).toBe(false);
  });
  it('a line without | is not a dash line', () => {
    expect(isDashLine(line('[C]--------[G]--------'))).toBe(false);
  });
  it('| [C] [G] [Am] [F] | is ONE bar split equally', () => {
    const l = line('| [C] [G] [Am] [F] |');
    expect(dashBarCount(l)).toBe(1);
    const r = parseDashLine(l, t44);
    expect(r.errors).toEqual([]);
    expect(r.bars[0].chords.map((c) => c.length)).toEqual([4, 4, 4, 4]);
  });
});
