import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import {
  DURATION_TICKS,
  INPUT_DURATIONS,
  WHOLE_TICKS,
  barTicks,
  cleanTexText,
  decompose,
  durationTicks,
  isValidPitch,
  isValidTicks,
  melismas,
  melodyTimeSignature,
  padToFullBar,
  slurId,
  slurMarks,
  splitAtBars,
  ticksToDuration,
  totalTicks,
  type MelodyEvent,
} from './melody';
import { tupletDen } from './tuplet';
import {
  edgeFixtures,
  kirakiraA,
  melodyFixtures,
} from './fixtures/melodyFixtures';

const note = (pitch: string, ticks: number, extra = {}): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...extra,
});
const rest = (ticks: number): MelodyEvent => ({ kind: 'rest', ticks });
const FOUR_FOUR = { num: 4, den: 4 };
/** n events as the slots of one tuplet. */
const tuplet = (n: number, items: MelodyEvent[]): MelodyEvent[] =>
  items.map((e, slot) => ({ ...e, tuplet: { n, slot } }));

describe('durations', () => {
  it('uses whole = 64 ticks', () => {
    expect(WHOLE_TICKS).toBe(64);
    expect(DURATION_TICKS).toEqual({
      '1': 64,
      '2': 32,
      '4': 16,
      '8': 8,
      '16': 4,
      '32': 2,
    });
    expect(INPUT_DURATIONS).toEqual(['1', '2', '4', '8', '16']);
  });

  it('durationTicks applies the dot as 1.5x', () => {
    expect(durationTicks('4', false)).toBe(16);
    expect(durationTicks('4', true)).toBe(24);
    expect(durationTicks('16', true)).toBe(6);
    expect(durationTicks('1', true)).toBe(96);
  });

  it('ticksToDuration only maps exact single values', () => {
    expect(ticksToDuration(16)).toEqual({ d: '4', dotted: false });
    expect(ticksToDuration(24)).toEqual({ d: '4', dotted: true });
    expect(ticksToDuration(6)).toEqual({ d: '16', dotted: true });
    expect(ticksToDuration(2)).toEqual({ d: '32', dotted: false });
    expect(ticksToDuration(96)).toEqual({ d: '1', dotted: true });
    // dotted 32nd is not part of the subset
    expect(ticksToDuration(3)).toBeNull();
    expect(ticksToDuration(40)).toBeNull();
    expect(ticksToDuration(0)).toBeNull();
    expect(ticksToDuration(128)).toBeNull();
  });

  it('isValidTicks accepts positive even integers', () => {
    expect(isValidTicks(2)).toBe(true);
    expect(isValidTicks(40)).toBe(true);
    expect(isValidTicks(0)).toBe(false);
    expect(isValidTicks(-4)).toBe(false);
    expect(isValidTicks(3)).toBe(false);
    expect(isValidTicks(4.5)).toBe(false);
    expect(isValidTicks(NaN)).toBe(false);
  });
});

describe('decompose', () => {
  it('returns a single value when exact', () => {
    expect(decompose(16)).toEqual([{ d: '4', dotted: false }]);
    expect(decompose(48)).toEqual([{ d: '2', dotted: true }]);
  });

  it('splits largest first', () => {
    expect(decompose(40)).toEqual([
      { d: '2', dotted: false },
      { d: '8', dotted: false },
    ]);
    expect(decompose(28)).toEqual([
      { d: '4', dotted: true },
      { d: '16', dotted: false },
    ]);
    expect(decompose(160)).toEqual([
      { d: '1', dotted: true },
      { d: '1', dotted: false },
    ]);
  });

  it('avoids 32nds unless the total is not a multiple of 4', () => {
    // 8 + 2 would also work; 6 + 4 avoids the 32nd
    expect(decompose(10)).toEqual([
      { d: '16', dotted: true },
      { d: '16', dotted: false },
    ]);
    expect(decompose(2)).toEqual([{ d: '32', dotted: false }]);
  });

  it('sums back to the input', () => {
    for (let t = 2; t <= 200; t += 2) {
      const sum = decompose(t).reduce(
        (s, p) => s + durationTicks(p.d, p.dotted),
        0,
      );
      expect(sum).toBe(t);
    }
  });

  it('throws on unrepresentable ticks', () => {
    expect(() => decompose(0)).toThrow(RangeError);
    expect(() => decompose(3)).toThrow(RangeError);
    expect(() => decompose(-4)).toThrow(RangeError);
  });
});

describe('time signatures', () => {
  it('barTicks', () => {
    expect(barTicks({ num: 4, den: 4 })).toBe(64);
    expect(barTicks({ num: 3, den: 4 })).toBe(48);
    expect(barTicks({ num: 6, den: 8 })).toBe(48);
    expect(barTicks({ num: 5, den: 16 })).toBe(20);
    expect(barTicks({ num: 3, den: 32 })).toBe(6);
    expect(() => barTicks({ num: 7, den: 64 })).toThrow(RangeError);
    expect(() => barTicks({ num: 0, den: 4 })).toThrow(RangeError);
  });

  it('melodyTimeSignature falls back to 4/4', () => {
    expect(melodyTimeSignature('3/4')).toEqual({ num: 3, den: 4 });
    expect(melodyTimeSignature(' 6 / 8 ')).toEqual({ num: 6, den: 8 });
    expect(melodyTimeSignature(undefined)).toEqual(FOUR_FOUR);
    expect(melodyTimeSignature('abc')).toEqual(FOUR_FOUR);
    expect(melodyTimeSignature('4/3')).toEqual(FOUR_FOUR);
    expect(melodyTimeSignature('7/64')).toEqual(FOUR_FOUR);
  });
});

describe('isValidPitch', () => {
  it('accepts the subset spelling', () => {
    for (const p of ['C4', 'C#4', 'Bb3', 'Cb4', 'E#4', 'A0', 'C8']) {
      expect(isValidPitch(p)).toBe(true);
    }
  });
  it('rejects anything else', () => {
    for (const p of ['c4', 'C', 'H4', 'C##4', 'Cbb4', 'C9', 'C-1', ' C4', '']) {
      expect(isValidPitch(p)).toBe(false);
    }
  });
});

describe('cleanTexText', () => {
  it('strips quote, backslash and braces', () => {
    expect(cleanTexText('a"b\\c{d}e')).toBe('abcde');
  });
  it('turns line breaks and tabs into spaces', () => {
    expect(cleanTexText('a\nb\tc\r\nd')).toBe('a b c  d');
  });
  it('returns undefined when nothing visible is left', () => {
    expect(cleanTexText('{"}')).toBeUndefined();
    expect(cleanTexText('  ')).toBeUndefined();
    expect(cleanTexText(undefined)).toBeUndefined();
  });
  it('keeps inner spaces as written', () => {
    expect(cleanTexText('a b')).toBe('a b');
  });
});

describe('splitAtBars', () => {
  it('keeps notes that fit in one piece each', () => {
    const bars = splitAtBars(kirakiraA.events, FOUR_FOUR);
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.length)).toEqual([4, 3, 4, 3]);
    expect(bars[1][2]).toEqual({
      event: kirakiraA.events[6],
      ticks: 32,
      d: '2',
      dotted: false,
      tieToNext: false,
      isContinuation: false,
    });
  });

  it('ties a note across the barline', () => {
    const e = note('D4', 32, { lyric: 'ばー', chord: 'G' });
    const bars = splitAtBars([note('C4', 48), e, note('E4', 48)], FOUR_FOUR);
    expect(bars).toHaveLength(2);
    expect(bars[0][1]).toMatchObject({
      event: e,
      ticks: 16,
      tieToNext: true,
      isContinuation: false,
    });
    expect(bars[1][0]).toMatchObject({
      event: e,
      ticks: 16,
      tieToNext: false,
      isContinuation: true,
    });
  });

  it('splits rests without ties', () => {
    const r = rest(32);
    const bars = splitAtBars([note('C4', 48), r], FOUR_FOUR);
    expect(bars[0][1]).toMatchObject({
      event: r,
      ticks: 16,
      tieToNext: false,
      isContinuation: false,
    });
    expect(bars[1][0]).toMatchObject({
      event: r,
      ticks: 16,
      tieToNext: false,
      isContinuation: true,
    });
  });

  it('decomposes a piece inside a bar and across several bars', () => {
    const e = note('C4', 168); // 40 + 64 + 64
    const bars = splitAtBars([note('B3', 24), e], FOUR_FOUR);
    expect(bars).toHaveLength(3);
    const pieces = bars.flat().filter((p) => p.event === e);
    expect(pieces.map((p) => [p.d, p.dotted, p.tieToNext])).toEqual([
      ['2', false, true],
      ['8', false, true],
      ['1', false, true],
      ['1', false, false],
    ]);
    expect(pieces.map((p) => p.isContinuation)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it('leaves the last bar incomplete', () => {
    const bars = splitAtBars([note('C4', 64), note('D4', 16)], FOUR_FOUR);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toHaveLength(1);
  });

  it('returns no bars for no events', () => {
    expect(splitAtBars([], FOUR_FOUR)).toEqual([]);
  });

  it('throws on invalid ticks', () => {
    expect(() => splitAtBars([note('C4', 3)], FOUR_FOUR)).toThrow(RangeError);
  });

  describe('tuplets (M5)', () => {
    const triplet = tuplet(3, [note('C4', 8), rest(8), note('E4', 8)]);

    it('one undotted, untied piece per slot, carrying the mark; bar counts the span', () => {
      const events = [...triplet, note('F4', 48)];
      const bars = splitAtBars(events, FOUR_FOUR);
      expect(bars).toHaveLength(1);
      expect(
        bars[0].map((p) => [p.d, p.ticks, p.dotted, p.tieToNext, p.tuplet]),
      ).toEqual([
        ['8', 8, false, false, { n: 3, slot: 0 }],
        ['8', 8, false, false, { n: 3, slot: 1 }],
        ['8', 8, false, false, { n: 3, slot: 2 }],
        ['2', 48, true, false, undefined],
      ]);
      expect(bars[0][1].event).toBe(events[1]);
      expect(bars[0].every((p) => !p.isContinuation)).toBe(true);
    });

    it('a tuplet that fills a bar closes it; the next event starts a new bar', () => {
      const events = [note('C4', 48), ...triplet, note('G4', 16)];
      const bars = splitAtBars(events, FOUR_FOUR);
      expect(bars.map((b) => b.length)).toEqual([4, 1]);
    });

    it('a note may still be tied across the barline after a tuplet', () => {
      const bars = splitAtBars([...triplet, note('G4', 64)], FOUR_FOUR);
      expect(bars.map((b) => b.map((p) => p.ticks))).toEqual([
        [8, 8, 8, 48],
        [16],
      ]);
      expect(bars[0][3].tieToNext).toBe(true);
    });

    it('throws a Japanese RangeError when a tuplet would cross a barline', () => {
      const events = [
        note('C4', 64),
        note('D4', 56),
        ...tuplet(
          5,
          [1, 2, 3, 4, 5].map(() => note('E4', 4)),
        ),
      ];
      expect(() => splitAtBars(events, FOUR_FOUR)).toThrow(
        '2 小節目の 5 連符が小節線をまたぎます',
      );
    });

    it('throws on a broken group (missing slot, mixed length)', () => {
      expect(() => splitAtBars(triplet.slice(0, 2), FOUR_FOUR)).toThrow(
        RangeError,
      );
      expect(() =>
        splitAtBars(
          [triplet[0], triplet[1], { ...triplet[2], ticks: 16 }],
          FOUR_FOUR,
        ),
      ).toThrow(RangeError);
    });
  });
});

describe('totalTicks', () => {
  it('sums written ticks, with tuplets counted as their span', () => {
    expect(totalTicks([])).toBe(0);
    expect(totalTicks([note('C4', 16), rest(8)])).toBe(24);
    expect(
      totalTicks([
        ...tuplet(3, [note('C4', 8), note('D4', 8), note('E4', 8)]),
        ...tuplet(
          5,
          [1, 2, 3, 4, 5].map(() => note('E4', 4)),
        ),
        note('F4', 16),
      ]),
    ).toBe(16 + 16 + 16);
  });
  it('throws on a broken group', () => {
    expect(() => totalTicks(tuplet(3, [note('C4', 8)]))).toThrow(RangeError);
  });
});

describe('melismas', () => {
  const rest = (ticks: number): MelodyEvent => ({ kind: 'rest', ticks });
  it('a lyric note followed by lyric-less notes', () => {
    expect(
      melismas([
        note('C4', 16, { lyric: 'る' }),
        note('D4', 16),
        note('E4', 16),
        note('F4', 16, { lyric: 'ら' }),
      ]),
    ).toEqual([{ start: 0, end: 2 }]);
  });
  it('none when every note has a lyric, or no lyric precedes', () => {
    expect(
      melismas([
        note('C4', 16, { lyric: 'a' }),
        note('D4', 16, { lyric: 'b' }),
      ]),
    ).toEqual([]);
    expect(melismas([note('C4', 16), note('D4', 16)])).toEqual([]);
    expect(melismas([])).toEqual([]);
  });
  it('a rest ends it; notes after the rest are not part of it', () => {
    expect(
      melismas([
        note('C4', 16, { lyric: 'a' }),
        rest(16),
        note('D4', 16),
        note('E4', 16, { lyric: 'b' }),
        note('F4', 16),
        rest(16),
        note('G4', 16),
      ]),
    ).toEqual([{ start: 3, end: 4 }]);
  });
  it('a whitespace-only / cleaned-away lyric counts as no lyric', () => {
    expect(
      melismas([
        note('C4', 16, { lyric: 'a' }),
        note('D4', 16, { lyric: ' ' }),
        note('E4', 16, { lyric: '{"}' }),
        note('F4', 16, { lyric: ' ' }),
      ]),
    ).toEqual([{ start: 0, end: 3 }]);
  });
  it('several melismas in a row', () => {
    expect(
      melismas([
        note('C4', 16, { lyric: 'a' }),
        note('D4', 16),
        note('E4', 16, { lyric: 'b' }),
        note('F4', 16),
      ]),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });
});

describe('slurMarks', () => {
  it('start on the first piece, end on the last tied piece', () => {
    const events = [
      note('C4', 48, { lyric: 'a' }), // dotted half
      note('D4', 32), // crosses the barline: D4 | D4{t}
    ];
    const bars = splitAtBars(events, { num: 4, den: 4 });
    const marks = slurMarks(bars, events);
    expect(marks.get(bars[0][0])).toEqual({ role: 'start', n: 1 });
    expect(marks.get(bars[0][1])).toBeUndefined();
    expect(marks.get(bars[1][0])).toEqual({ role: 'end', n: 1 });
    expect(marks.size).toBe(2);
  });
  it('counts events correctly with a repeated rest object', () => {
    const r: MelodyEvent = { kind: 'rest', ticks: 16 };
    const events = [r, r, note('C4', 16, { lyric: 'a' }), note('D4', 16)];
    const bars = splitAtBars(events, { num: 4, den: 4 });
    const marks = slurMarks(bars, events);
    expect(marks.get(bars[0][2])).toEqual({ role: 'start', n: 1 });
    expect(marks.get(bars[0][3])).toEqual({ role: 'end', n: 1 });
  });
});

describe('slurId', () => {
  it('label-n, or n for an empty label; label cleaned', () => {
    expect(slurId('A', 1)).toBe('A-1');
    expect(slurId('サビ 2', 3)).toBe('サビ 2-3');
    expect(slurId('', 2)).toBe('2');
    expect(slurId('"{}', 2)).toBe('2');
    expect(slurId('a"b', 1)).toBe('ab-1');
  });
});

describe('padToFullBar', () => {
  it('fills the last bar with rests, smallest first', () => {
    const events = [note('C4', 64), note('D4', 16)];
    expect(padToFullBar(events, FOUR_FOUR)).toEqual([
      ...events,
      rest(16),
      rest(32),
    ]);
  });
  it('counts a tuplet by its span', () => {
    const events = tuplet(3, [note('C4', 16), note('D4', 16), note('E4', 16)]);
    expect(padToFullBar(events, FOUR_FOUR)).toEqual([...events, rest(32)]);
  });
  it('returns the same array when already full or empty', () => {
    const full = [note('C4', 64)];
    expect(padToFullBar(full, FOUR_FOUR)).toBe(full);
    const empty: MelodyEvent[] = [];
    expect(padToFullBar(empty, FOUR_FOUR)).toBe(empty);
  });
});

/** Minimal pitch → MIDI for checking fixtures against alphaTab. */
function midi(pitch: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(pitch)!;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]!;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

describe('fixtures (golden alphaTex for T2/T3)', () => {
  it('has the expected fixtures', () => {
    expect(melodyFixtures[0]).toBe(kirakiraA);
    expect(edgeFixtures.length).toBeGreaterThanOrEqual(5);
    expect(kirakiraA.events.map((e) => e.lyric).join('')).toBe(
      'きらきらひかるおそらのほしよ',
    );
  });

  it.each(melodyFixtures.map((f) => [f.name, f] as const))(
    '%s: alphaTab reads the golden text as splitAtBars says',
    (_name, f) => {
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.logErrors = false;
      const ts = `\\ts ${f.ts.num} ${f.ts.den}\n`;
      importer.initFromString(ts + f.tex, new alphaTab.Settings());
      const score = importer.readScore();
      const bars = score.tracks[0].staves[0].bars;
      const groupIds = new Map<unknown, number>();
      const groupId = (g: unknown) => {
        if (!groupIds.has(g)) groupIds.set(g, groupIds.size);
        return groupIds.get(g);
      };
      const actual = bars.map((bar) =>
        bar.voices[0].beats.map((b) => ({
          tuplet: b.hasTuplet
            ? `${b.tupletNumerator}/${b.tupletDenominator}#${groupId(b.tupletGroup)}`
            : undefined,
          d: String(b.duration),
          dotted: b.dots === 1,
          rest: b.isRest,
          midi: b.isRest ? undefined : b.notes[0].realValue,
          tieFromPrev: b.isRest ? false : b.notes[0].isTieDestination,
          lyric: b.lyrics?.[0],
          chord: b.chordId ? b.chord?.name : undefined,
          slur: b.isRest
            ? undefined
            : b.notes[0].isSlurOrigin
              ? `start>${b.notes[0].slurDestination!.realValue}`
              : b.notes[0].isSlurDestination
                ? 'end'
                : undefined,
        })),
      );
      const pieces = splitAtBars(f.events, f.ts);
      const marks = slurMarks(pieces, f.events);
      const ends = new Map(
        [...marks]
          .filter(([, m]) => m.role === 'end')
          .map(([p, m]) => [m.n, p]),
      );
      let group = -1;
      const expected = pieces.map((bar) =>
        bar.map((p) => {
          const mark = marks.get(p);
          const isNote = p.event.kind === 'note';
          if (p.tuplet?.slot === 0) group++;
          return {
            tuplet: p.tuplet
              ? `${p.tuplet.n}/${tupletDen(p.tuplet.n)}#${group}`
              : undefined,
            d: p.d,
            dotted: p.dotted,
            rest: !isNote,
            midi: isNote ? midi(p.event.pitch!) : undefined,
            tieFromPrev: isNote && p.isContinuation,
            lyric: p.isContinuation
              ? undefined
              : isNote
                ? cleanTexText(p.event.lyric)
                : undefined,
            chord: p.isContinuation ? undefined : cleanTexText(p.event.chord),
            slur:
              mark?.role === 'start'
                ? `start>${midi(ends.get(mark.n)!.event.pitch!)}`
                : mark?.role === 'end'
                  ? 'end'
                  : undefined,
          };
        }),
      );
      expect(actual).toEqual(expected);
      expect(f.tex.split('\n')).toHaveLength(expected.length);
    },
  );
});
