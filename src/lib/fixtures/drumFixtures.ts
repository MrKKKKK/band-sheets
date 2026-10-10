import type { DrumEvent, DrumHit, Shuffle } from '../drum';
import type { DrumInstrument } from '../drumKit';
import type { TimeSig } from '../melody';

/**
 * Shared golden data for the drum serializer (T11) and parser (T12); the
 * alphaTex subset is specified in drum.ts's header comment.
 *
 * - `serializeDrums(events, shuffle, ts)` must equal `tex` exactly.
 * - `parseDrums(tex, ts)` must deep-equal `{ events, shuffle }` (for an
 *   empty `tex`: no events, shuffle 'none').
 *
 * `tex` is a section body (no `\section` line), `\tf` line first, one bar
 * per line, no trailing newline. Events are normalized (`normalizeDrums`
 * returns them unchanged). drum.test.ts reads every non-empty `tex` with
 * alphaTab's AlphaTexImporter and compares it with `drumBars(events, ts)`.
 *
 * `drumReadVariants` are hand-written, non-canonical spellings the parser
 * must accept: `parseDrums(tex, ts)` must deep-equal `{ events, shuffle }`,
 * and serializing that result gives the canonical `canonical` text.
 */
export interface DrumFixture {
  name: string;
  ts: TimeSig;
  shuffle: Shuffle;
  events: DrumEvent[];
  tex: string;
}

export interface DrumReadVariant extends DrumFixture {
  /** `serializeDrums` of the parse result. */
  canonical: string;
}

type HitSpec = DrumInstrument | `${DrumInstrument}:${'g' | 'ac' | 'hac'}`;

const hit = (spec: HitSpec): DrumHit => {
  const [inst, eff] = spec.split(':') as [DrumInstrument, string | undefined];
  if (eff === 'g') return { inst, ghost: true };
  if (eff === 'ac') return { inst, accent: 'normal' };
  if (eff === 'hac') return { inst, accent: 'heavy' };
  return { inst };
};

/** A beat of `ticks` with the given hits (already in DRUM_KIT order). */
const b = (ticks: number, ...hits: HitSpec[]): DrumEvent => ({
  hits: hits.map(hit),
  ticks,
});
const r = (ticks: number): DrumEvent => ({ hits: [], ticks });

/** n tuplet slots from `items` (slot = position). */
const group = (n: number, items: DrumEvent[]): DrumEvent[] =>
  items.map((e, slot) => ({ ...e, tuplet: { n, slot } }));

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };

/** One 8-beat bar: (HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH. */
const eightBeatBar = (): DrumEvent[] => [
  b(8, 'HH', 'BD'),
  b(8, 'HH'),
  b(8, 'HH', 'SD'),
  b(8, 'HH'),
  b(8, 'HH', 'BD'),
  b(8, 'HH', 'BD'),
  b(8, 'HH', 'SD'),
  b(8, 'HH'),
];

const EIGHT_BEAT_LINE = '(HH BD) HH (HH SD) HH (HH BD) (HH BD) (HH SD) HH |';

/** sampleSong's Drums section A (4 bars, fill with 16ths in bar 4). */
export const eightBeat: DrumFixture = {
  name: '8ビート（サンプル曲）',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    ...eightBeatBar(),
    ...eightBeatBar(),
    ...eightBeatBar(),
    b(8, 'HH', 'BD'),
    b(8, 'HH'),
    b(8, 'HH', 'SD'),
    b(8, 'HH'),
    b(4, 'SD'),
    b(4, 'SD'),
    b(4, 'SD'),
    b(4, 'SD'),
    b(4, 'SD'),
    b(4, 'SD'),
    b(4, 'SD', 'BD'),
    b(4, 'SD', 'BD'),
  ],
  tex: [
    '\\tf none',
    `:8 ${EIGHT_BEAT_LINE}`,
    EIGHT_BEAT_LINE,
    EIGHT_BEAT_LINE,
    '(HH BD) HH (HH SD) HH :16 SD SD SD SD SD SD (SD BD) (SD BD) |',
  ].join('\n'),
};

export const simultaneous: DrumFixture = {
  name: '同時打ち（3 つ以上、全楽器、キットの順）',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    b(16, 'CR', 'BD'),
    b(16, 'HO', 'SD', 'BD'),
    b(16, 'RD', 'T1', 'T2'),
    b(16, 'HH', 'FT', 'BD'),
  ],
  tex: ['\\tf none', ':4 (CR BD) (HO SD BD) (RD T1 T2) (HH FT BD) |'].join(
    '\n',
  ),
};

export const articulations: DrumFixture = {
  name: 'ゴースト・アクセント・強いアクセント',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    b(8, 'CR:hac', 'BD'),
    b(8, 'SD:g'),
    b(8, 'HH', 'SD:ac'),
    b(8, 'SD:g'),
    b(8, 'HH:ac', 'BD'),
    b(8, 'HH', 'SD:g'),
    b(16, 'SD:hac'),
  ],
  tex: [
    '\\tf none',
    ':8 (CR{hac} BD) SD{g} (HH SD{ac}) SD{g} (HH{ac} BD) (HH SD{g}) :4 SD{hac} |',
  ].join('\n'),
};

export const dottedAndRests: DrumFixture = {
  name: '付点と休符',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    r(16),
    b(16, 'BD'),
    r(8),
    b(8, 'SD'),
    r(16),
    b(24, 'SD:g'),
    b(8, 'BD'),
    b(24, 'HH', 'BD'),
    r(8),
    r(24),
    r(8),
  ],
  tex: [
    '\\tf none',
    ':4 r BD :8 r SD :4 r |',
    'SD{g d} :8 BD :4 (HH BD){d} :8 r |',
    ':4 r{d} :8 r |',
  ].join('\n'),
};

export const triplets: DrumFixture = {
  name: '8分の3連（休符・同時打ち・ゴースト入り）',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    ...group(3, [b(8, 'HH', 'BD'), b(8, 'HH'), b(8, 'HH')]),
    ...group(3, [b(8, 'HH', 'SD:g'), r(8), b(8, 'SD:ac')]),
    b(16, 'HH', 'BD'),
    ...group(3, [b(8, 'T1'), b(8, 'T2'), b(8, 'FT')]),
  ],
  tex: [
    '\\tf none',
    ':8 (HH BD){tu 3} HH{tu 3} HH{tu 3} (HH SD{g}){tu 3} r{tu 3} SD{ac tu 3} :4 (HH BD) :8 T1{tu 3} T2{tu 3} FT{tu 3} |',
  ].join('\n'),
};

export const quintupletsToSeptuplets: DrumFixture = {
  name: '16分の5・6・7連',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    ...group(5, [b(4, 'SD:g'), b(4, 'SD'), b(4, 'SD'), b(4, 'SD'), b(4, 'SD')]),
    ...group(6, [
      b(4, 'SD'),
      b(4, 'SD'),
      b(4, 'SD'),
      b(4, 'SD'),
      r(4),
      b(4, 'SD', 'BD'),
    ]),
    ...group(7, [
      b(4, 'T1'),
      b(4, 'T1'),
      b(4, 'T2'),
      b(4, 'T2'),
      b(4, 'FT'),
      b(4, 'FT'),
      b(4, 'FT'),
    ]),
    b(16, 'CR:hac', 'BD'),
  ],
  tex: [
    '\\tf none',
    ':16 SD{g tu 5} SD{tu 5} SD{tu 5} SD{tu 5} SD{tu 5} SD{tu 6} SD{tu 6} SD{tu 6} SD{tu 6} r{tu 6} (SD BD){tu 6} T1{tu 7} T1{tu 7} T2{tu 7} T2{tu 7} FT{tu 7} FT{tu 7} FT{tu 7} :4 (CR{hac} BD) |',
  ].join('\n'),
};

export const thirteenTuplet: DrumFixture = {
  name: '32分の13連（{tu 13 8}）',
  ts: FOUR_FOUR,
  shuffle: 'none',
  events: [
    ...group(
      13,
      Array.from({ length: 13 }, (_, i) => (i === 12 ? r(2) : b(2, 'SD'))),
    ),
    r(16),
    r(32),
  ],
  tex: [
    '\\tf none',
    `:32 ${[...Array<string>(12).fill('SD{tu 13 8}'), 'r{tu 13 8}'].join(' ')} :4 r :2 r |`,
  ].join('\n'),
};

export const shuffle8: DrumFixture = {
  name: 'シャッフル 8分',
  ts: FOUR_FOUR,
  shuffle: '8',
  events: [...eightBeatBar(), ...eightBeatBar()],
  tex: ['\\tf triplet8th', `:8 ${EIGHT_BEAT_LINE}`, EIGHT_BEAT_LINE].join('\n'),
};

export const shuffle16: DrumFixture = {
  name: 'シャッフル 16分（短い最後の小節）',
  ts: FOUR_FOUR,
  shuffle: '16',
  events: [
    b(4, 'HH', 'BD'),
    b(4, 'HH'),
    b(4, 'HH'),
    b(4, 'HH'),
    b(4, 'HH', 'SD'),
    b(4, 'HH'),
    b(4, 'HH'),
    b(4, 'HH'),
  ],
  tex: ['\\tf triplet16th', ':16 (HH BD) HH HH HH (HH SD) HH HH HH |'].join(
    '\n',
  ),
};

export const threeFour: DrumFixture = {
  name: '3/4 拍子・付点2分の同時打ち',
  ts: { num: 3, den: 4 },
  shuffle: 'none',
  events: [
    b(16, 'RD', 'BD'),
    b(16, 'RD', 'SD'),
    b(16, 'RD', 'SD'),
    b(48, 'CR', 'BD'),
  ],
  tex: ['\\tf none', ':4 (RD BD) (RD SD) (RD SD) |', ':2 (CR BD){d} |'].join(
    '\n',
  ),
};

export const emptySection: DrumFixture = {
  name: '拍のないセクション（シャッフルの指定があっても何も書かない）',
  ts: FOUR_FOUR,
  shuffle: '8',
  events: [],
  tex: '',
};

/** Fixtures that round-trip exactly (except `emptySection`'s shuffle). */
export const drumFixtures: readonly DrumFixture[] = [
  eightBeat,
  simultaneous,
  articulations,
  dottedAndRests,
  triplets,
  quintupletsToSeptuplets,
  thirteenTuplet,
  shuffle8,
  shuffle16,
  threeFour,
  emptySection,
];

/** Non-canonical hand-written spellings T12 must read (and normalize). */
export const drumReadVariants: readonly DrumReadVariant[] = [
  {
    name: '.N 付き・楽器の順不同・\\tf の別名・改行の自由',
    ts: FOUR_FOUR,
    shuffle: '8',
    events: [b(8, 'HH', 'BD'), b(8, 'HH'), b(8, 'HH', 'SD'), b(8, 'HH'), r(32)],
    tex: ['\\tf t8', '', '(BD HH).8 HH', '(SD HH) HH r.2 |'].join('\n'),
    canonical: ['\\tf triplet8th', ':8 (HH BD) HH (HH SD) HH :2 r |'].join(
      '\n',
    ),
  },
  {
    name: '\\tf なし（none 扱い）・最後の | なし・(SD) は 1 打',
    ts: FOUR_FOUR,
    shuffle: 'none',
    events: [b(16, 'SD'), b(16, 'BD'), b(16, 'SD')],
    tex: ':4 (SD) BD SD',
    canonical: ['\\tf none', ':4 SD BD SD |'].join('\n'),
  },
  {
    name: '.N の後ろの拍の効果・まとめた {} の順不同',
    ts: FOUR_FOUR,
    shuffle: '16',
    events: [
      ...group(3, [b(8, 'SD:g'), b(8, 'SD'), b(8, 'HH', 'SD:g')]),
      b(24, 'BD'),
      b(8, 'SD'),
      b(16, 'HH'),
    ],
    tex: [
      '\\tf triplet-16th',
      'SD{g}.8{tu 3} SD{tu 3} (SD{g} HH){tu 3} BD.4{d} :8 SD HH.4 |',
    ].join('\n'),
    canonical: [
      '\\tf triplet16th',
      ':8 SD{g tu 3} SD{tu 3} (HH SD{g}){tu 3} :4 BD{d} :8 SD :4 HH |',
    ].join('\n'),
  },
];
