import type { MelodyEvent, TimeSig } from '../melody';

/**
 * Shared golden data for the melody serializer (T2) and parser (T3).
 *
 * - `serializeMelody(events, ts)` must equal `tex` exactly.
 * - `parseMelody(tex, ts)` must deep-equal `parsed ?? events`.
 *
 * `tex` is a section body (no `\section` line), one bar per line, no
 * trailing newline. melody.test.ts checks every `tex` with alphaTab's
 * AlphaTexImporter against `splitAtBars(events, ts)`.
 */
export interface MelodyFixture {
  name: string;
  ts: TimeSig;
  events: MelodyEvent[];
  tex: string;
  /** Expected parse result when it differs from `events` (cleaned text). */
  parsed?: MelodyEvent[];
}

const n = (
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
const r = (ticks: number, chord?: string): MelodyEvent => ({
  kind: 'rest',
  ticks,
  ...(chord !== undefined && { chord }),
});

/** `e` as slot `slot` of an n-tuplet (M5). */
const tu = (e: MelodyEvent, n: number, slot: number): MelodyEvent => ({
  ...e,
  tuplet: { n, slot },
});
/** n tuplet slots from `items` (slot = position). */
const group = (n: number, items: MelodyEvent[]): MelodyEvent[] =>
  items.map((e, slot) => tu(e, n, slot));

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** きらきら星 section A (4/4), chords as in sampleSong's chart. */
export const kirakiraA: MelodyFixture = {
  name: 'きらきら星 A',
  ts: FOUR_FOUR,
  events: [
    n('C4', 16, 'き', 'C'),
    n('C4', 16, 'ら'),
    n('G4', 16, 'き'),
    n('G4', 16, 'ら'),
    n('A4', 16, 'ひ', 'F'),
    n('A4', 16, 'か'),
    n('G4', 32, 'る', 'C'),
    n('F4', 16, 'お', 'F'),
    n('F4', 16, 'そ'),
    n('E4', 16, 'ら'),
    n('E4', 16, 'の', 'C'),
    n('D4', 16, 'ほ', 'G'),
    n('D4', 16, 'し'),
    n('C4', 32, 'よ', 'C'),
  ],
  tex: [
    ':4 C4{lyrics "き" ch "C"} C4{lyrics "ら"} G4{lyrics "き"} G4{lyrics "ら"} |',
    'A4{lyrics "ひ" ch "F"} A4{lyrics "か"} :2 G4{lyrics "る" ch "C"} |',
    ':4 F4{lyrics "お" ch "F"} F4{lyrics "そ"} E4{lyrics "ら"} E4{lyrics "の" ch "C"} |',
    'D4{lyrics "ほ" ch "G"} D4{lyrics "し"} :2 C4{lyrics "よ" ch "C"} |',
  ].join('\n'),
};

/** Melismas → derived slurs (one ending on a tied piece across a barline). */
export const melismaFixture: MelodyFixture = {
  name: 'melismas (slurs)',
  ts: FOUR_FOUR,
  events: [
    n('C4', 16, 'る'),
    n('D4', 16),
    n('E4', 16),
    n('F4', 32, 'ら'),
    n('G4', 16),
    n('A4', 48),
    r(16),
    n('B4', 16),
    n('C5', 16, 'あ'),
  ],
  tex: [
    ':4 C4{lyrics "る" slur "1"} D4 E4{slur "1"} F4{lyrics "ら" slur "2"} |',
    'F4{t} G4 :2 A4 |',
    ':4 A4{t slur "2"} r B4 C5{lyrics "あ"} |',
  ].join('\n'),
};

export const edgeFixtures: MelodyFixture[] = [
  {
    name: 'dotted',
    ts: FOUR_FOUR,
    events: [n('C4', 24, 'き'), n('D4', 8, 'ら'), n('E4', 32)],
    tex: ':4 C4{d lyrics "き"} :8 D4{lyrics "ら" slur "1"} :2 E4{slur "1"} |',
  },
  {
    name: 'note tied across the barline',
    ts: FOUR_FOUR,
    events: [
      n('C4', 16),
      n('C4', 16),
      n('G4', 16),
      n('D4', 32, 'ばー', 'G'),
      n('E4', 48),
    ],
    tex: [
      ':4 C4 C4 G4 D4{lyrics "ばー" ch "G" slur "1"} |',
      'D4{t} :2 E4{d slur "1"} |',
    ].join('\n'),
  },
  {
    name: 'rests (split without tie)',
    ts: FOUR_FOUR,
    events: [n('C4', 48), r(32, 'F'), n('D4', 16), n('E4', 32)],
    tex: [':2 C4{d} :4 r{ch "F"} |', 'r D4 :2 E4 |'].join('\n'),
  },
  {
    name: 'incomplete last bar',
    ts: FOUR_FOUR,
    events: [n('C4', 16), n('D4', 16), n('E4', 16), n('F4', 16), n('G4', 16)],
    tex: [':4 C4 D4 E4 F4 |', 'G4 |'].join('\n'),
  },
  {
    name: 'long note over several bars',
    ts: FOUR_FOUR,
    events: [n('B3', 24), n('C4', 168, 'あー')],
    tex: [
      ':4 B3{d} :2 C4{lyrics "あー"} :8 C4{t} |',
      ':1 C4{t} |',
      'C4{t} |',
    ].join('\n'),
  },
  {
    name: '3/4 with accidentals',
    ts: { num: 3, den: 4 },
    events: [n('C#4', 32), n('Bb3', 32), r(32)],
    tex: [':2 C#4 :4 Bb3 |', 'Bb3{t} :2 r |'].join('\n'),
  },
  {
    name: '32nd remainder at the barline (2/4)',
    ts: { num: 2, den: 4 },
    events: [n('C4', 24), n('D4', 6), n('E4', 6), n('G4', 28)],
    tex: [':4 C4{d} :16 D4{d} :32 E4 |', ':16 E4{t} :4 G4{d} :16 G4{t} |'].join(
      '\n',
    ),
  },
  {
    name: 'text cleaning',
    ts: FOUR_FOUR,
    events: [
      n('C4', 32, 'き"{}', '\\Am'),
      n('D4', 16, '{"}'),
      { kind: 'rest', ticks: 16, lyric: 'x' },
    ],
    tex: ':2 C4{lyrics "き" ch "Am" slur "1"} :4 D4{slur "1"} r |',
    parsed: [n('C4', 32, 'き', 'Am'), n('D4', 16), r(16)],
  },
  melismaFixture,
  ...tupletFixtures(),
];

/** Tuplets (M5): `{tu N}` on every slot, effect order `tu lyrics ch slur`. */
function tupletFixtures(): MelodyFixture[] {
  const thirteen = [
    'C4',
    'D4',
    'E4',
    'F4',
    'G4',
    'A4',
    'B4',
    'C5',
    'D5',
    'E5',
    'F5',
    'G5',
    'A5',
  ];
  return [
    {
      name: 'tuplets: triplet with lyric/chord/slur, rests in tuplets',
      ts: FOUR_FOUR,
      events: [
        ...group(3, [n('C4', 8, 'き', 'C'), n('D4', 8), n('E4', 8, 'ら')]),
        ...group(3, [r(8), r(8), n('F4', 8)]),
        n('G4', 32),
        r(16),
        ...group(5, [n('A4', 4), n('B4', 4), n('C5', 4), n('D5', 4), r(4)]),
        r(32),
      ],
      tex: [
        ':8 C4{tu 3 lyrics "き" ch "C" slur "1"} D4{tu 3 slur "1"} E4{tu 3 lyrics "ら"} r{tu 3} r{tu 3} F4{tu 3} :2 G4 |',
        ':4 r :16 A4{tu 5} B4{tu 5} C5{tu 5} D5{tu 5} r{tu 5} :2 r |',
      ].join('\n'),
    },
    {
      name: 'tuplets: quarter triplet, two eighth triplets, melismas across them',
      ts: FOUR_FOUR,
      events: [
        ...group(3, [n('C4', 16, 'あ'), n('D4', 16), n('E4', 16)]),
        ...group(3, [n('F4', 8), n('G4', 8, 'い'), n('A4', 8)]),
        ...group(3, [n('B4', 8), n('C5', 8), n('D5', 8)]),
      ],
      tex: ':4 C4{tu 3 lyrics "あ" slur "1"} D4{tu 3} E4{tu 3} :8 F4{tu 3 slur "1"} G4{tu 3 lyrics "い" slur "2"} A4{tu 3} B4{tu 3} C5{tu 3} D5{tu 3 slur "2"} |',
    },
    {
      name: 'tuplets: 13-tuplet of 32nds (tu 13 8) in 3/4',
      ts: { num: 3, den: 4 },
      events: [
        ...group(
          13,
          thirteen.map((p) => n(p, 2)),
        ),
        r(32),
      ],
      tex: `:32 ${thirteen.map((p) => `${p}{tu 13 8}`).join(' ')} :2 r |`,
    },
  ];
}

export const melodyFixtures: MelodyFixture[] = [kirakiraA, ...edgeFixtures];
