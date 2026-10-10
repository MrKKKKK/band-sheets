import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import { drumBars, type DrumEvent, type Shuffle } from './drum';
import { DRUM_KIT, type DrumInstrument } from './drumKit';
import { DRUM_ARTICULATIONS } from './partsToAlphaTex';
import { serializeDrums } from './drumTex';
import { drumFixtures } from './fixtures/drumFixtures';
import type { TimeSig } from './melody';

const FOUR_FOUR: TimeSig = { num: 4, den: 4 };
const ev = (ticks: number, ...insts: DrumInstrument[]): DrumEvent => ({
  hits: insts.map((inst) => ({ inst })),
  ticks,
});
const tu = (e: DrumEvent, n: number, slot: number): DrumEvent => ({
  ...e,
  tuplet: { n, slot },
});

describe('serializeDrums', () => {
  it('returns empty string for no events', () => {
    expect(serializeDrums([], 'none', FOUR_FOUR)).toBe('');
    expect(serializeDrums([], '8', FOUR_FOUR)).toBe('');
  });

  it.each(drumFixtures.map((f) => [f.name, f] as const))(
    '%s: matches the golden tex exactly',
    (_name, f) => {
      expect(serializeDrums(f.events, f.shuffle, f.ts)).toBe(f.tex);
    },
  );

  describe('alphaTab agrees with the serialized text', () => {
    const midiToInst = new Map(DRUM_KIT.map((k) => [k.midi, k.id]));
    const kitIndex = (id: DrumInstrument | undefined) =>
      DRUM_KIT.findIndex((k) => k.id === id);
    const feel: Record<Shuffle, number> = { none: 0, '8': 2, '16': 1 };

    /**
     * Feeds `serializeDrums`'s output to alphaTab's AlphaTexImporter (same
     * wrapping `partsToAlphaTex` would use for a drum part) and checks beat
     * counts, durations, tuplets (hasTuplet + numerator/denominator),
     * instruments (via `percussionArticulation`), ghost/accent and the
     * masterBar's `tripletFeel` against `drumBars(events, ts)`.
     */
    function expectAlphaTabAgrees(f: {
      events: DrumEvent[];
      shuffle: Shuffle;
      ts: TimeSig;
    }): void {
      const tex = serializeDrums(f.events, f.shuffle, f.ts);
      const head = [
        `\\ts ${f.ts.num} ${f.ts.den}`,
        '\\instrument percussion',
        ...DRUM_ARTICULATIONS.map(([n, m]) => `\\articulation ${n} ${m}`),
        '\\clef neutral',
        '\\section "A"',
      ];
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.logErrors = false;
      importer.initFromString(
        [...head, tex].join('\n'),
        new alphaTab.Settings(),
      );
      const score = importer.readScore();
      const track = score.tracks[0];
      const actual = track.staves[0].bars.map((bar) =>
        bar.voices[0].beats.map((beat) => ({
          ticks: (64 / beat.duration) * (beat.dots === 1 ? 1.5 : 1),
          tuplet: beat.hasTuplet ? beat.tupletNumerator : undefined,
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
    }

    it.each(
      drumFixtures
        .filter((f) => f.events.length > 0)
        .map((f) => [f.name, f] as const),
    )('%s', (_name, f) => {
      expectAlphaTabAgrees(f);
    });
  });

  describe('RangeError on unnormalized / broken input', () => {
    it('a beat crossing the barline', () => {
      // 4/4: 48 + 8 + 16 = 72, the last beat crosses the barline at 64.
      const events = [ev(48, 'BD'), ev(8, 'HH'), ev(16, 'SD')];
      expect(() => serializeDrums(events, 'none', FOUR_FOUR)).toThrow(
        RangeError,
      );
    });

    it('a tuplet group crossing the barline', () => {
      const group = [0, 1, 2].map((slot) => tu(ev(8, 'SD'), 3, slot));
      const events = [ev(48, 'BD'), ev(8, 'HH'), ...group];
      expect(() => serializeDrums(events, 'none', FOUR_FOUR)).toThrow(
        RangeError,
      );
    });

    it('a broken tuplet group', () => {
      const events = [tu(ev(8, 'SD'), 3, 0), ev(8, 'SD')];
      expect(() => serializeDrums(events, 'none', FOUR_FOUR)).toThrow(
        RangeError,
      );
    });

    it('an event ticks value that is not one note value', () => {
      const events = [ev(40, 'SD')];
      expect(() => serializeDrums(events, 'none', FOUR_FOUR)).toThrow(
        RangeError,
      );
    });
  });
});
