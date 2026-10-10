import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import {
  SHUFFLE_TEX,
  articulationOf,
  drumBars,
  hasHit,
  isDrumRest,
  isValidDrumTicks,
  normalizeDrums,
  setArticulation,
  sortHits,
  toggleHit,
  type DrumEvent,
  type DrumHit,
} from './drum';
import { DRUM_KIT, type DrumInstrument } from './drumKit';
import { DRUM_ARTICULATIONS } from './partsToAlphaTex';
import { groupsFitBars, tupletGroups } from './tuplet';
import { barTicks, type TimeSig } from './melody';
import {
  drumFixtures,
  drumReadVariants,
  type DrumFixture,
} from './fixtures/drumFixtures';

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };
const ev = (ticks: number, ...insts: DrumInstrument[]): DrumEvent => ({
  hits: insts.map((inst) => ({ inst })),
  ticks,
});
const r = (ticks: number): DrumEvent => ({ hits: [], ticks });
const tu = (e: DrumEvent, n: number, slot: number): DrumEvent => ({
  ...e,
  tuplet: { n, slot },
});
const insts = (e: DrumEvent) => e.hits.map((h) => h.inst);

describe('sortHits', () => {
  it('orders hits as DRUM_KIT (top of the staff first)', () => {
    const hits: DrumHit[] = [
      'BD',
      'SD',
      'FT',
      'T2',
      'T1',
      'RD',
      'HO',
      'CR',
    ].map((inst) => ({ inst: inst as DrumInstrument }));
    expect(sortHits(hits).map((h) => h.inst)).toEqual([
      'CR',
      'HO',
      'RD',
      'T1',
      'T2',
      'SD',
      'FT',
      'BD',
    ]);
  });

  it('keeps articulations and does not mutate the input', () => {
    const hits: DrumHit[] = [{ inst: 'SD', ghost: true }, { inst: 'HH' }];
    const sorted = sortHits(hits);
    expect(sorted).toEqual([{ inst: 'HH' }, { inst: 'SD', ghost: true }]);
    expect(hits[0].inst).toBe('SD');
  });

  it('matches the DRUM_KIT order exactly', () => {
    const all = DRUM_KIT.map((e) => ({ inst: e.id })).reverse();
    expect(sortHits(all).map((h) => h.inst)).toEqual(DRUM_KIT.map((e) => e.id));
  });
});

describe('isDrumRest / hasHit / isValidDrumTicks', () => {
  it('empty hits = rest', () => {
    expect(isDrumRest(r(8))).toBe(true);
    expect(isDrumRest(ev(8, 'SD'))).toBe(false);
    expect(hasHit(ev(8, 'HH', 'SD'), 'SD')).toBe(true);
    expect(hasHit(ev(8, 'HH'), 'HO')).toBe(false);
  });

  it.each([96, 64, 48, 32, 24, 16, 12, 8, 6, 4, 2])(
    '%i is one note value',
    (t) => expect(isValidDrumTicks(t)).toBe(true),
  );
  it.each([0, 3, 40, 20, 10, 128, -8])('%i is not', (t) =>
    expect(isValidDrumTicks(t)).toBe(false),
  );
});

describe('toggleHit', () => {
  it('adds an instrument in kit order, plain', () => {
    const e = toggleHit(ev(8, 'HH', 'BD'), 'SD');
    expect(insts(e)).toEqual(['HH', 'SD', 'BD']);
    expect(e.hits[1]).toEqual({ inst: 'SD' });
  });

  it('removes a present instrument (with its articulation)', () => {
    const e = toggleHit(
      { hits: [{ inst: 'HH' }, { inst: 'SD', ghost: true }], ticks: 8 },
      'SD',
    );
    expect(e.hits).toEqual([{ inst: 'HH' }]);
  });

  it('removing the last hit makes a rest; adding to a rest makes a beat', () => {
    expect(toggleHit(ev(16, 'SD'), 'SD')).toEqual(r(16));
    expect(toggleHit(r(16), 'BD')).toEqual(ev(16, 'BD'));
  });

  it('HH and HO exclude each other', () => {
    expect(insts(toggleHit(ev(8, 'HH', 'BD'), 'HO'))).toEqual(['HO', 'BD']);
    expect(insts(toggleHit(ev(8, 'HO', 'SD'), 'HH'))).toEqual(['HH', 'SD']);
  });

  it('keeps ticks and tuplet, does not mutate', () => {
    const before = tu(ev(8, 'SD'), 3, 1);
    const after = toggleHit(before, 'BD');
    expect(after).toEqual({ ...tu(ev(8, 'SD', 'BD'), 3, 1) });
    expect(insts(before)).toEqual(['SD']);
  });
});

describe('setArticulation / articulationOf', () => {
  const base: DrumEvent = { hits: [{ inst: 'HH' }, { inst: 'SD' }], ticks: 8 };

  it('sets ghost / accent / heavy on one hit only', () => {
    expect(setArticulation(base, 'SD', 'ghost').hits).toEqual([
      { inst: 'HH' },
      { inst: 'SD', ghost: true },
    ]);
    expect(setArticulation(base, 'HH', 'accent').hits[0]).toEqual({
      inst: 'HH',
      accent: 'normal',
    });
    expect(setArticulation(base, 'SD', 'heavy').hits[1]).toEqual({
      inst: 'SD',
      accent: 'heavy',
    });
  });

  it('ghost and accent exclude each other; none clears both', () => {
    const ghost = setArticulation(base, 'SD', 'ghost');
    const accent = setArticulation(ghost, 'SD', 'accent');
    expect(accent.hits[1]).toEqual({ inst: 'SD', accent: 'normal' });
    const back = setArticulation(accent, 'SD', 'ghost');
    expect(back.hits[1]).toEqual({ inst: 'SD', ghost: true });
    expect(setArticulation(back, 'SD', 'none').hits[1]).toEqual({
      inst: 'SD',
    });
  });

  it('returns the same event when the instrument is not on the beat', () => {
    expect(setArticulation(base, 'BD', 'ghost')).toBe(base);
    expect(setArticulation(r(8), 'SD', 'accent')).toEqual(r(8));
  });

  it('keeps ticks / tuplet and does not mutate', () => {
    const t = tu(base, 3, 0);
    const out = setArticulation(t, 'SD', 'ghost');
    expect(out.tuplet).toEqual({ n: 3, slot: 0 });
    expect(out.ticks).toBe(8);
    expect(t.hits[1]).toEqual({ inst: 'SD' });
  });

  it('articulationOf reads all four states', () => {
    expect(articulationOf({ inst: 'SD' })).toBe('none');
    expect(articulationOf({ inst: 'SD', ghost: true })).toBe('ghost');
    expect(articulationOf({ inst: 'SD', accent: 'normal' })).toBe('accent');
    expect(articulationOf({ inst: 'SD', accent: 'heavy' })).toBe('heavy');
  });
});

describe('normalizeDrums', () => {
  it('returns the same array and the identity map when nothing crosses', () => {
    const input = [ev(16, 'BD'), r(16), ev(32, 'CR')];
    const out = normalizeDrums(input, FOUR_FOUR);
    expect(out.events).toBe(input);
    expect(out.map).toEqual([0, 1, 2]);
    expect(normalizeDrums([], FOUR_FOUR)).toEqual({ events: [], map: [] });
  });

  it('cuts a beat at the barline into the hit + a rest', () => {
    // 3.5 beats, then a quarter (crosses by an eighth).
    const input = [ev(48, 'CR'), ev(8, 'HH'), ev(16, 'SD', 'BD'), ev(8, 'HH')];
    const { events, map } = normalizeDrums(input, FOUR_FOUR);
    expect(events).toEqual([
      ev(48, 'CR'),
      ev(8, 'HH'),
      ev(8, 'SD', 'BD'),
      r(8),
      ev(8, 'HH'),
    ]);
    expect(map).toEqual([0, 1, 2, 4]);
  });

  it('keeps articulations on the struck part', () => {
    const hit: DrumEvent = {
      hits: [{ inst: 'SD', accent: 'heavy' }],
      ticks: 16,
    };
    const { events } = normalizeDrums(
      [ev(48, 'BD'), ev(8, 'HH'), hit],
      FOUR_FOUR,
    );
    expect(events.slice(2)).toEqual([{ ...hit, ticks: 8 }, r(8)]);
  });

  it('cuts a rest the same way', () => {
    const { events } = normalizeDrums([ev(48, 'BD'), r(32)], FOUR_FOUR);
    expect(events).toEqual([ev(48, 'BD'), r(16), r(16)]);
  });

  it('a room that is not one note value: hit + rests up to the barline', () => {
    // position 44: 20 ticks left (16 + 4), a half note crosses.
    const input = [ev(32, 'BD'), ev(12, 'SD'), ev(32, 'CR')];
    const { events, map } = normalizeDrums(input, FOUR_FOUR);
    expect(events).toEqual([
      ev(32, 'BD'),
      ev(12, 'SD'),
      ev(16, 'CR'),
      r(4),
      r(12),
    ]);
    expect(map).toEqual([0, 1, 2]);
  });

  it('an overflow longer than a bar is written bar by bar', () => {
    // 2/4: a whole note at position 8 → 24 | 32 | 8.
    const ts = { num: 2, den: 4 };
    const { events } = normalizeDrums([ev(8, 'HH'), ev(64, 'CR')], ts);
    expect(events).toEqual([ev(8, 'HH'), ev(24, 'CR'), r(32), r(8)]);
  });

  it('splits a non-note-value length inside a bar (largest first)', () => {
    const { events } = normalizeDrums([ev(40, 'SD')], FOUR_FOUR);
    expect(events).toEqual([ev(32, 'SD'), r(8)]);
  });

  it('maps a cursor past the last event via the new length', () => {
    const input = [ev(48, 'BD'), ev(8, 'HH'), ev(16, 'SD')];
    const { events, map } = normalizeDrums(input, FOUR_FOUR);
    const mapCursor = (c: number) =>
      c < input.length ? map[c] : events.length;
    expect([0, 1, 2, 3].map(mapCursor)).toEqual([0, 1, 2, 4]);
  });

  it('counts a tuplet group as its span and never splits it', () => {
    // 8th triplet (span 16) at position 40 → ends at 56; the quarter after
    // it crosses.
    const g = [0, 1, 2].map((s) => tu(ev(8, 'SD'), 3, s));
    const input = [ev(32, 'BD'), ev(8, 'HH'), ...g, ev(16, 'CR')];
    const { events, map } = normalizeDrums(input, FOUR_FOUR);
    expect(events).toEqual([
      ev(32, 'BD'),
      ev(8, 'HH'),
      ...g,
      ev(8, 'CR'),
      r(8),
    ]);
    expect(map).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('leaves a group that crosses a barline as it is (groupsFitBars refuses it)', () => {
    const g = [0, 1, 2].map((s) => tu(ev(8, 'SD'), 3, s));
    const input = [ev(48, 'BD'), ev(8, 'HH'), ...g];
    expect(groupsFitBars(input, 64).ok).toBe(false);
    expect(normalizeDrums(input, FOUR_FOUR).events).toBe(input);
  });

  it('throws on a broken tuplet group', () => {
    const broken = [tu(ev(8, 'SD'), 3, 0), ev(8, 'SD')];
    expect(() => normalizeDrums(broken, FOUR_FOUR)).toThrow(RangeError);
  });

  it('does not mutate the input', () => {
    const input = [ev(48, 'BD'), ev(8, 'HH'), ev(16, 'SD')];
    const copy = structuredClone(input);
    normalizeDrums(input, FOUR_FOUR);
    expect(input).toEqual(copy);
  });

  it('is idempotent', () => {
    const once = normalizeDrums(
      [ev(12, 'SD'), ev(64, 'CR'), ev(48, 'BD')],
      FOUR_FOUR,
    ).events;
    const twice = normalizeDrums(once, FOUR_FOUR);
    expect(twice.events).toBe(once);
  });
});

describe('drumBars', () => {
  it('no events → no bars', () => {
    expect(drumBars([], FOUR_FOUR)).toEqual([]);
  });

  it('full bars and a short last bar', () => {
    const events = [ev(32, 'BD'), ev(32, 'SD'), ev(16, 'BD'), ev(16, 'SD')];
    expect(drumBars(events, FOUR_FOUR)).toEqual([
      { start: 0, end: 2, ticks: 64 },
      { start: 2, end: 4, ticks: 32 },
    ]);
  });

  it('counts a tuplet group as its span', () => {
    const g = [0, 1, 2, 3, 4].map((s) => tu(ev(4, 'SD'), 5, s));
    const events = [...g, ev(48, 'BD'), ev(16, 'SD')];
    expect(drumBars(events, FOUR_FOUR)).toEqual([
      { start: 0, end: 6, ticks: 64 },
      { start: 6, end: 7, ticks: 16 },
    ]);
  });

  it('uses the time signature', () => {
    const events = [ev(24, 'BD'), ev(24, 'SD')];
    expect(drumBars(events, { num: 6, den: 8 })).toEqual([
      { start: 0, end: 2, ticks: 48 },
    ]);
  });

  it('throws when a beat or a group crosses a barline', () => {
    expect(() =>
      drumBars([ev(48, 'BD'), ev(8, 'HH'), ev(16, 'SD')], FOUR_FOUR),
    ).toThrow(RangeError);
    const g = [0, 1, 2].map((s) => tu(ev(8, 'SD'), 3, s));
    expect(() =>
      drumBars([ev(48, 'BD'), ev(8, 'HH'), ...g], FOUR_FOUR),
    ).toThrow(RangeError);
  });
});

describe('SHUFFLE_TEX', () => {
  it('maps each shuffle to its canonical \\tf value', () => {
    expect(SHUFFLE_TEX).toEqual({
      none: 'none',
      '8': 'triplet8th',
      '16': 'triplet16th',
    });
  });
});

const allFixtures: readonly DrumFixture[] = [
  ...drumFixtures,
  ...drumReadVariants,
];

describe('golden fixtures', () => {
  it('cover the agreed cases', () => {
    expect(drumFixtures.length).toBeGreaterThanOrEqual(10);
    const ns = new Set(
      drumFixtures.flatMap((f) => f.events.map((e) => e.tuplet?.n)),
    );
    for (const n of [3, 5, 6, 7, 13]) expect(ns.has(n)).toBe(true);
    const shuffles = new Set(drumFixtures.map((f) => f.shuffle));
    expect(shuffles).toEqual(new Set(['none', '8', '16']));
  });

  it.each(allFixtures.map((f) => [f.name, f] as const))(
    '%s: events are valid and normalized',
    (_name, f) => {
      expect(normalizeDrums(f.events, f.ts).events).toBe(f.events);
      expect(groupsFitBars(f.events, barTicks(f.ts))).toEqual({ ok: true });
      expect('error' in tupletGroups(f.events)).toBe(false);
      for (const e of f.events) {
        expect(e.hits).toEqual(sortHits(e.hits));
        expect(new Set(insts(e)).size).toBe(e.hits.length);
        expect(hasHit(e, 'HH') && hasHit(e, 'HO')).toBe(false);
        for (const h of e.hits) {
          expect(h.ghost && h.accent).toBeFalsy();
        }
        if (!e.tuplet) expect(isValidDrumTicks(e.ticks)).toBe(true);
      }
    },
  );

  const midiToInst = new Map(DRUM_KIT.map((k) => [k.midi, k.id]));
  const kitIndex = (id: DrumInstrument | undefined) =>
    DRUM_KIT.findIndex((k) => k.id === id);
  const feel = { none: 0, '8': 2, '16': 1 } as const;

  /**
   * Reads `tex` with alphaTab (as partsToAlphaTex would wrap a drum part)
   * and compares each bar's beats with `drumBars(events)`.
   */
  it.each(
    allFixtures
      .filter((f) => f.events.length > 0)
      .flatMap((f) => {
        const texts: [string, string][] = [['tex', f.tex]];
        if ('canonical' in f) {
          texts.push(['canonical', (f as { canonical: string }).canonical]);
        }
        return texts.map(
          ([which, tex]) => [`${f.name} (${which})`, f, tex] as const,
        );
      }),
  )('%s: alphaTab reads the text as the events say', (_name, f, tex) => {
    const head = [
      `\\ts ${f.ts.num} ${f.ts.den}`,
      '\\instrument percussion',
      ...DRUM_ARTICULATIONS.map(([n, m]) => `\\articulation ${n} ${m}`),
      '\\clef neutral',
      '\\section "A"',
    ];
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.logErrors = false;
    importer.initFromString([...head, tex].join('\n'), new alphaTab.Settings());
    const score = importer.readScore();
    const track = score.tracks[0];
    const actual = track.staves[0].bars.map((bar) =>
      bar.voices[0].beats.map((beat) => ({
        ticks: (64 / beat.duration) * (beat.dots === 1 ? 1.5 : 1),
        tuplet: beat.hasTuplet ? beat.tupletNumerator : undefined,
        // alphaTab keeps the written order; hand-written variants may differ.
        hits: beat.notes
          .map((note) => ({
            inst: midiToInst.get(
              track.percussionArticulations[note.percussionArticulation]
                .outputMidiNumber,
            ),
            ghost: note.isGhost,
            accent: note.accentuated,
          }))
          .sort((a, b) => kitIndex(a.inst) - kitIndex(b.inst)),
      })),
    );
    const expected = drumBars(f.events, f.ts).map((b) =>
      f.events.slice(b.start, b.end).map((e) => ({
        ticks: e.ticks,
        tuplet: e.tuplet?.n,
        hits: e.hits.map((h) => ({
          inst: h.inst,
          ghost: h.ghost === true,
          accent: h.accent === 'heavy' ? 2 : h.accent === 'normal' ? 1 : 0,
        })),
      })),
    );
    expect(actual).toEqual(expected);
    for (const mb of score.masterBars) {
      expect(mb.tripletFeel).toBe(feel[f.shuffle]);
    }
    expect(score.masterBars[0].section?.text).toBe('A');
  });
});
