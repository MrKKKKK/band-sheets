import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import {
  DRUM_KIT,
  drumKitEntry,
  drumKitEntryForCode,
  type DrumInstrument,
} from './drumKit';
import { DRUM_ARTICULATIONS } from './partsToAlphaTex';

describe('DRUM_KIT', () => {
  it('has exactly the 9 pieces from docs/m5-plan.md', () => {
    expect(DRUM_KIT).toHaveLength(9);
    expect(new Set(DRUM_KIT.map((e) => e.id))).toEqual(
      new Set(['CR', 'RD', 'HH', 'HO', 'T1', 'SD', 'T2', 'FT', 'BD']),
    );
  });

  it('has no duplicate ids or keys', () => {
    expect(new Set(DRUM_KIT.map((e) => e.id)).size).toBe(DRUM_KIT.length);
    expect(new Set(DRUM_KIT.map((e) => e.code)).size).toBe(DRUM_KIT.length);
  });

  it('matches the approved key map (docs/m5-decisions.md)', () => {
    const codes = Object.fromEntries(
      DRUM_KIT.map((e) => [e.id, e.code]),
    ) as Record<DrumInstrument, string>;
    expect(codes).toEqual({
      SD: 'KeyF',
      BD: 'KeyJ',
      HH: 'KeyH',
      HO: 'KeyG',
      T1: 'KeyK',
      T2: 'KeyL',
      FT: 'Semicolon',
      CR: 'KeyU',
      RD: 'KeyI',
    });
  });

  it('is ordered top of the staff to bottom (descending step)', () => {
    const steps = DRUM_KIT.map((e) => e.step);
    expect(steps).toEqual([...steps].sort((a, b) => b - a));
  });

  it('gives HH and HO the same step (told apart by notehead) and nobody else shares one', () => {
    const byStep = new Map<number, DrumInstrument[]>();
    for (const e of DRUM_KIT) {
      byStep.set(e.step, [...(byStep.get(e.step) ?? []), e.id]);
    }
    const shared = [...byStep.values()].filter((ids) => ids.length > 1);
    expect(shared).toEqual([['HH', 'HO']]);
    expect(DRUM_KIT.find((e) => e.id === 'HH')!.head).not.toBe(
      DRUM_KIT.find((e) => e.id === 'HO')!.head,
    );
  });

  it('uses the same midi ids as DRUM_ARTICULATIONS (partsToAlphaTex.ts)', () => {
    const fromKit = Object.fromEntries(DRUM_KIT.map((e) => [e.id, e.midi]));
    const fromArticulations = Object.fromEntries(DRUM_ARTICULATIONS);
    expect(fromKit).toEqual(fromArticulations);
  });

  it('drumKitEntry looks up by id and throws on an unknown one', () => {
    expect(drumKitEntry('SD').name).toBe('スネア');
    expect(() => drumKitEntry('XX' as DrumInstrument)).toThrow(RangeError);
  });

  it('drumKitEntryForCode looks up by e.code and returns undefined when unmatched', () => {
    expect(drumKitEntryForCode('KeyF')?.id).toBe('SD');
    expect(drumKitEntryForCode('Semicolon')?.id).toBe('FT');
    expect(drumKitEntryForCode('KeyZ')).toBeUndefined();
  });
});

/**
 * Feeds a percussion track declaring the project's own DRUM_ARTICULATIONS
 * aliases, with one beat per piece, to alphaTab's AlphaTexImporter (same
 * approach as melody.test.ts / melodyTex.test.ts) and checks that all 9
 * pieces parse and that `DRUM_KIT.step` matches `8 − staffLine`, exactly as
 * verified manually in docs/m5-alphatab-findings.md §8.4.
 */
describe('DRUM_KIT.step vs alphaTab staffLine', () => {
  it('parses all 9 pieces and step = 8 − staffLine for each', () => {
    const tex = [
      '\\instrument percussion',
      ...DRUM_ARTICULATIONS.map(
        ([name, midi]) => `\\articulation ${name} ${midi}`,
      ),
      '\\clef neutral',
      `:4 ${DRUM_KIT.map((e) => e.id).join(' ')} |`,
    ].join('\n');

    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.logErrors = false;
    importer.initFromString(tex, new alphaTab.Settings());
    const score = importer.readScore();

    const track = score.tracks[0];
    const beats = track.staves[0].bars[0].voices[0].beats;
    expect(beats).toHaveLength(DRUM_KIT.length);

    beats.forEach((beat, i) => {
      const entry = DRUM_KIT[i];
      expect(beat.notes).toHaveLength(1);
      const note = beat.notes[0];
      const articulation =
        track.percussionArticulations[note.percussionArticulation];
      expect(8 - articulation.staffLine).toBe(entry.step);
    });
  });
});
