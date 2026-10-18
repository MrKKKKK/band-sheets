import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import { disambiguateChordCase, restoreChordNames } from './chordCase';

const CHORDS = [
  'CM7',
  'C#M7',
  'DbM7',
  'Cmaj7',
  'CΔ7',
  'Cm7',
  'CmM7',
  'C#m7-5',
  'CM9',
  'C7',
  'C#M7/G#',
  'C#m7',
  'cm7',
];

function tex(chords: string[]): string {
  return `\\ts 4 4\n${chords.map((c) => `C4.4 {ch "${c}"}`).join(' ')} |`;
}

function importNames(src: string, fix: boolean): string[] {
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.logErrors = false;
  imp.initFromString(src, new alphaTab.Settings());
  const score = imp.readScore();
  if (fix) restoreChordNames(score);
  return score.tracks[0].staves[0].bars
    .flatMap((b) => b.voices[0].beats)
    .map((b) => b.chord?.name ?? '');
}

describe('alphaTab chord-name case (bug: C#M7 shown as C#m7)', () => {
  it('reproduces: raw alphaTab merges names that differ only in case', () => {
    expect(importNames(tex(['C#m7', 'C#M7']), false)).toEqual(['C#m7', 'C#m7']);
  });

  it('shows every spelling exactly as written', () => {
    for (const c of CHORDS) {
      expect(importNames(disambiguateChordCase(tex([c])), true)).toEqual([c]);
    }
  });

  it('keeps M7 and m7 apart when both appear (any order)', () => {
    expect(
      importNames(disambiguateChordCase(tex(['C#m7', 'C#M7', 'C#m7'])), true),
    ).toEqual(['C#m7', 'C#M7', 'C#m7']);
    expect(importNames(disambiguateChordCase(tex(CHORDS)), true)).toEqual(
      CHORDS,
    );
  });

  it('leaves tex without case clashes untouched', () => {
    const t = tex(['C', 'Am', 'C']);
    expect(disambiguateChordCase(t)).toBe(t);
  });
});
