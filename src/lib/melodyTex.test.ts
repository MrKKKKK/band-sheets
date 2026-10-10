import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import {
  cleanTexText,
  splitAtBars,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { melodyFixtures } from './fixtures/melodyFixtures';
import { serializeMelody } from './melodyTex';
import { tupletDen } from './tuplet';

const note = (
  pitch: string,
  ticks: number,
  lyric?: string,
  chord?: string,
): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...(lyric !== undefined && { lyric }),
  ...(chord !== undefined && { chord }),
});
const rest = (ticks: number, chord?: string): MelodyEvent => ({
  kind: 'rest',
  ticks,
  ...(chord !== undefined && { chord }),
});
const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** Minimal pitch → MIDI for checking against alphaTab (same as melody.test.ts). */
function midi(pitch: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(pitch)!;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]!;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

/**
 * Feeds `tex` to alphaTab's AlphaTexImporter (same way melody.test.ts does
 * for the golden fixtures) and asserts the resulting beats match what
 * `splitAtBars(events, ts)` says: beat count, durations, dots, ties,
 * lyrics, pitches and tuplets (`hasTuplet`, numerator/denominator, which
 * beats share a `TupletGroup`), plus each bar's real length.
 */
function expectAlphaTabAgrees(tex: string, events: MelodyEvent[], ts: TimeSig) {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.logErrors = false;
  const tsHeader = `\\ts ${ts.num} ${ts.den}\n`;
  importer.initFromString(tsHeader + tex, new alphaTab.Settings());
  const score = importer.readScore();
  const bars = score.tracks[0].staves[0].bars;
  const groupIds = new Map<unknown, number>();
  const actual = bars.map((bar) =>
    bar.voices[0].beats.map((b) => ({
      d: String(b.duration),
      dotted: b.dots === 1,
      rest: b.isRest,
      midi: b.isRest ? undefined : b.notes[0].realValue,
      tieFromPrev: b.isRest ? false : b.notes[0].isTieDestination,
      lyric: b.lyrics?.[0],
      chord: b.chordId ? b.chord?.name : undefined,
      tuplet: b.hasTuplet
        ? `${b.tupletNumerator}/${b.tupletDenominator}#${
            groupIds.get(b.tupletGroup) ??
            (groupIds.set(b.tupletGroup, groupIds.size), groupIds.size - 1)
          }`
        : undefined,
    })),
  );
  // alphaTab: quarter = 960; ours: quarter = 16 ticks
  const barLengths = bars.map((bar) =>
    bar.voices[0].beats.reduce((t, b) => t + b.playbackDuration, 0),
  );
  let group = -1;
  const expectedBars = splitAtBars(events, ts).map((bar) =>
    bar.map((p) => {
      const isNote = p.event.kind === 'note';
      if (p.tuplet?.slot === 0) group++;
      return {
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
        tuplet: p.tuplet
          ? `${p.tuplet.n}/${tupletDen(p.tuplet.n)}#${group}`
          : undefined,
      };
    }),
  );
  expect(actual).toEqual(expectedBars);
  const realTicks = (p: { ticks: number; tuplet?: { n: number } }) =>
    p.tuplet ? (p.ticks * tupletDen(p.tuplet.n)) / p.tuplet.n : p.ticks;
  // alphaTab rounds each tuplet beat's playbackDuration down to an integer,
  // so allow < 1 unit per beat.
  const expectedLengths = splitAtBars(events, ts).map((bar) =>
    bar.reduce((t, p) => t + realTicks(p) * 60, 0),
  );
  expect(barLengths).toHaveLength(expectedLengths.length);
  barLengths.forEach((len, i) => {
    const beats = bars[i].voices[0].beats.length;
    expect(Math.abs(len - expectedLengths[i])).toBeLessThan(beats);
  });
  expect(tex.split('\n')).toHaveLength(expectedBars.length);
}

describe('serializeMelody', () => {
  it('returns empty string for no events', () => {
    expect(serializeMelody([], FOUR_FOUR)).toBe('');
  });

  it.each(melodyFixtures.map((f) => [f.name, f] as const))(
    '%s: matches the golden tex exactly',
    (_name, f) => {
      expect(serializeMelody(f.events, f.ts)).toBe(f.tex);
    },
  );

  it.each(melodyFixtures.map((f) => [f.name, f] as const))(
    '%s: alphaTab reads the serialized tex as splitAtBars says',
    (_name, f) => {
      expectAlphaTabAgrees(serializeMelody(f.events, f.ts), f.events, f.ts);
    },
  );

  describe('extra cases (not in the golden fixtures)', () => {
    const cases: { name: string; ts: TimeSig; events: MelodyEvent[] }[] = [
      {
        name: 'duration changes mid-bar without crossing a barline',
        ts: FOUR_FOUR,
        events: [
          note('C4', 16),
          note('D4', 8),
          note('E4', 8),
          note('F4', 16),
          note('G4', 16),
        ],
      },
      {
        name: 'dotted note tied across the barline',
        ts: FOUR_FOUR,
        events: [rest(16), note('C4', 60)],
      },
      {
        name: 'chord on a rest',
        ts: FOUR_FOUR,
        events: [rest(32, 'G7"{}\\')],
      },
      {
        name: 'lyric with forbidden characters',
        ts: FOUR_FOUR,
        events: [note('C4', 16, 'ら\\{}"い')],
      },
      {
        name: '3/4 time signature',
        ts: { num: 3, den: 4 },
        events: [note('C4', 24), note('D4', 24)],
      },
      {
        name: '6/8 time signature',
        ts: { num: 6, den: 8 },
        events: [
          note('C4', 8),
          note('D4', 8),
          note('E4', 8),
          note('F4', 8),
          note('G4', 8),
          note('A4', 8),
        ],
      },
    ];

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const tex = serializeMelody(c.events, c.ts);
      expectAlphaTabAgrees(tex, c.events, c.ts);
    });

    it('cleans the chord text on a rest', () => {
      const tex = serializeMelody([rest(32, 'G7"{}\\')], FOUR_FOUR);
      expect(tex).toBe(':2 r{ch "G7"} |');
    });

    it('cleans the lyric text on a note', () => {
      const tex = serializeMelody([note('C4', 16, 'ら\\{}"い')], FOUR_FOUR);
      expect(tex).toBe(':4 C4{lyrics "らい"} |');
    });

    it('writes :N on the first beat of a 6/8 bar', () => {
      const tex = serializeMelody(
        [
          note('C4', 8),
          note('D4', 8),
          note('E4', 8),
          note('F4', 8),
          note('G4', 8),
          note('A4', 8),
        ],
        { num: 6, den: 8 },
      );
      expect(tex).toBe(':8 C4 D4 E4 F4 G4 A4 |');
    });
  });

  describe('tuplets (M5)', () => {
    const t = (e: MelodyEvent, n: number, slot: number): MelodyEvent => ({
      ...e,
      tuplet: { n, slot },
    });
    const triplet = (items: MelodyEvent[]) =>
      items.map((e, slot) => t(e, 3, slot));

    it('writes {tu N} on every slot, after d/t and before lyrics/ch/slur', () => {
      const events = [
        ...triplet([note('C4', 8, 'き', 'C'), note('D4', 8), rest(8, 'G')]),
        note('E4', 48),
      ];
      expect(serializeMelody(events, FOUR_FOUR, 'A')).toBe(
        ':8 C4{tu 3 lyrics "き" ch "C" slur "A-1"} D4{tu 3 slur "A-1"} r{tu 3 ch "G"} :2 E4{d} |',
      );
    });

    it('writes tu N D for 13/14/15, tu N otherwise', () => {
      const of = (n: number) =>
        Array.from({ length: n }, (_, slot) => t(rest(2), n, slot));
      expect(serializeMelody(of(14), FOUR_FOUR)).toBe(
        `:32 ${Array(14).fill('r{tu 14 8}').join(' ')} |`,
      );
      expect(serializeMelody(of(12), FOUR_FOUR)).toBe(
        `:32 ${Array(12).fill('r{tu 12}').join(' ')} |`,
      );
    });

    it('a note tied over a barline can follow a tuplet; a tuplet can open the next bar', () => {
      const events = [
        note('C4', 16),
        ...triplet([note('D4', 16), note('E4', 16), note('F4', 16)]),
        note('G4', 32),
        ...triplet([note('A4', 8), note('B4', 8), note('C5', 8)]),
        note('D5', 32),
      ];
      const tex = serializeMelody(events, FOUR_FOUR);
      expect(tex).toBe(
        [
          ':4 C4 D4{tu 3} E4{tu 3} F4{tu 3} G4 |',
          'G4{t} :8 A4{tu 3} B4{tu 3} C5{tu 3} :2 D5 |',
        ].join('\n'),
      );
      expectAlphaTabAgrees(tex, events, FOUR_FOUR);
    });

    it.each([3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15])(
      'alphaTab agrees for an %i-tuplet of 32nds (+ fill)',
      (n) => {
        const events = [
          ...Array.from({ length: n }, (_, slot) =>
            t(slot % 4 === 1 ? rest(2) : note('C5', 2), n, slot),
          ),
          note('G4', 16),
        ];
        expectAlphaTabAgrees(
          serializeMelody(events, FOUR_FOUR),
          events,
          FOUR_FOUR,
        );
      },
    );

    it('throws (Japanese) when a tuplet would cross a barline', () => {
      const events = [
        note('C4', 48),
        ...triplet([note('D4', 16), note('E4', 16), note('F4', 16)]),
      ];
      expect(() => serializeMelody(events, FOUR_FOUR)).toThrow(
        /1 小節目の 3 連符が小節線をまたぎます/,
      );
    });

    it('throws on a broken group', () => {
      expect(() =>
        serializeMelody([t(note('C4', 8), 3, 0), note('D4', 8)], FOUR_FOUR),
      ).toThrow(RangeError);
    });
  });

  describe('melisma slurs', () => {
    const melisma = [note('C4', 16, 'る'), note('D4', 16), note('E4', 16)];

    it('slurs a 3-note melisma, ids prefixed with the section label', () => {
      expect(serializeMelody(melisma, FOUR_FOUR, 'A')).toBe(
        ':4 C4{lyrics "る" slur "A-1"} D4 E4{slur "A-1"} |',
      );
      expect(serializeMelody(melisma, FOUR_FOUR)).toBe(
        ':4 C4{lyrics "る" slur "1"} D4 E4{slur "1"} |',
      );
    });

    it('no slur when every note has a lyric, or across a rest', () => {
      expect(
        serializeMelody([note('C4', 16, 'a'), note('D4', 16, 'b')], FOUR_FOUR),
      ).toBe(':4 C4{lyrics "a"} D4{lyrics "b"} |');
      expect(
        serializeMelody(
          [note('C4', 16, 'a'), rest(16), note('D4', 16)],
          FOUR_FOUR,
        ),
      ).toBe(':4 C4{lyrics "a"} r D4 |');
    });

    it('numbers melismas in order; alphaTab pairs them correctly', () => {
      const events = [
        note('C4', 16, 'a'),
        note('D4', 16),
        note('E4', 16, 'b'),
        note('F4', 16),
      ];
      const tex = serializeMelody(events, FOUR_FOUR, 'サビ');
      expect(tex).toBe(
        ':4 C4{lyrics "a" slur "サビ-1"} D4{slur "サビ-1"} E4{lyrics "b" slur "サビ-2"} F4{slur "サビ-2"} |',
      );
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.logErrors = false;
      importer.initFromString(tex, new alphaTab.Settings());
      const notes = importer
        .readScore()
        .tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.notes[0]);
      expect(notes[0].slurDestination).toBe(notes[1]);
      expect(notes[2].slurDestination).toBe(notes[3]);
      expect(notes[1].isSlurOrigin).toBe(false);
    });

    it('alphaTab agrees with the beats of a melisma across a barline', () => {
      const events = [note('C4', 48, 'a'), note('D4', 32), note('E4', 16)];
      expectAlphaTabAgrees(
        serializeMelody(events, FOUR_FOUR, 'A'),
        events,
        FOUR_FOUR,
      );
    });
  });
});
