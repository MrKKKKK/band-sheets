import { describe, expect, it } from 'vitest';
import { addToPalette, paletteGroups, removeFromPalette } from './palette';
import { parseSong } from './parseSong';
import type { Song } from './song';

const song = (text: string): Song => parseSong(text);

describe('paletteGroups', () => {
  it('returns user, used and diatonic groups and a deduplicated all', () => {
    const s = song(
      '{key: C}\n{x_palette: C7(9,13) G Fmaj7}\n[Am]a[E7]b[G]c[C7(9,13)]d',
    );
    const groups = paletteGroups(s);
    expect(groups.user).toEqual(['C7(9,13)', 'G', 'Fmaj7']);
    expect(groups.used).toEqual(['Am', 'E7', 'G', 'C7(9,13)']);
    expect(groups.diatonic).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
    expect(groups.all).toEqual([
      'C7(9,13)',
      'G',
      'Fmaj7',
      'Am',
      'E7',
      'C',
      'Dm',
      'Em',
      'F',
      'Bdim',
    ]);
  });

  it('has an empty diatonic group without a parseable key', () => {
    const groups = paletteGroups(song('{key: H}\n[C]a'));
    expect(groups).toEqual({ user: [], used: ['C'], diatonic: [], all: ['C'] });
  });

  it('drops palette entries that fail isValidChordText (R12)', () => {
    // Hand-edited x_palette with a stray ']' — parseSong keeps the raw text
    // (for round-trip), but paletteGroups must not surface it as a chip.
    const s = song('{x_palette: A]b C}');
    expect(s.meta.palette).toEqual(['A]b', 'C']);
    const groups = paletteGroups(s);
    expect(groups.user).toEqual(['C']);
    expect(groups.all).toEqual(['C']);
  });

  it('is empty for an empty song', () => {
    expect(paletteGroups(song(''))).toEqual({
      user: [],
      used: [],
      diatonic: [],
      all: [],
    });
  });
});

describe('addToPalette', () => {
  it('appends a valid chord without mutating the song', () => {
    const s = song('{x_palette: C}');
    const next = addToPalette(s, 'Fmaj7');
    expect(next.meta.palette).toEqual(['C', 'Fmaj7']);
    expect(s.meta.palette).toEqual(['C']);
    expect(next).not.toBe(s);
  });

  it('creates the palette when absent and trims the chord', () => {
    expect(addToPalette(song('{title: X}'), ' Am ').meta.palette).toEqual([
      'Am',
    ]);
  });

  it.each(['', 'C G', '[C]', '{C}'])(
    'returns the song unchanged for invalid %j',
    (chord) => {
      const s = song('{x_palette: C}');
      expect(addToPalette(s, chord)).toBe(s);
    },
  );

  it('returns the song unchanged for a duplicate', () => {
    const s = song('{x_palette: C Am}');
    expect(addToPalette(s, 'Am')).toBe(s);
  });
});

describe('removeFromPalette', () => {
  it('removes the chord without mutating the song', () => {
    const s = song('{x_palette: C Am F}');
    const next = removeFromPalette(s, 'Am');
    expect(next.meta.palette).toEqual(['C', 'F']);
    expect(s.meta.palette).toEqual(['C', 'Am', 'F']);
  });

  it('returns the song unchanged when the chord is not in the palette', () => {
    const s = song('{x_palette: C}');
    expect(removeFromPalette(s, 'G')).toBe(s);
    const empty = song('');
    expect(removeFromPalette(empty, 'G')).toBe(empty);
  });
});
