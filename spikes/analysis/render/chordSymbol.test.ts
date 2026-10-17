import { describe, expect, it } from 'vitest';
import { parseChordSymbol } from './chordSymbol';

describe('parseChordSymbol', () => {
  it.each([
    ['C', 0, 'C'],
    ['C#', 1, 'C#'],
    ['Db', 1, 'Db'],
    ['D', 2, 'D'],
    ['D#', 3, 'D#'],
    ['Eb', 3, 'Eb'],
    ['E', 4, 'E'],
    ['Fb', 4, 'Fb'],
    ['E#', 5, 'E#'],
    ['F', 5, 'F'],
    ['F#', 6, 'F#'],
    ['Gb', 6, 'Gb'],
    ['G', 7, 'G'],
    ['G#', 8, 'G#'],
    ['Ab', 8, 'Ab'],
    ['A', 9, 'A'],
    ['A#', 10, 'A#'],
    ['Bb', 10, 'Bb'],
    ['B', 11, 'B'],
    ['Cb', 11, 'Cb'],
    ['B#', 0, 'B#'],
  ])('root %s -> %i', (text, root, rootName) => {
    const c = parseChordSymbol(text);
    expect(c).toEqual({ text, root, rootName, quality: 'maj', bass: null });
  });

  it.each([
    ['C', 'maj'],
    ['Cm', 'min'],
    ['C7', '7'],
    ['Cmaj7', 'maj7'],
    ['CM7', 'maj7'],
    ['Cm7', 'min7'],
    ['Cdim', 'dim'],
    ['Caug', 'aug'],
    ['Csus4', 'sus4'],
  ])('quality %s -> %s', (text, quality) => {
    expect(parseChordSymbol(text).quality).toBe(quality);
  });

  it('parses accidentals together with qualities', () => {
    expect(parseChordSymbol('Dbm7')).toMatchObject({
      root: 1,
      rootName: 'Db',
      quality: 'min7',
    });
    expect(parseChordSymbol('F#dim')).toMatchObject({ root: 6, quality: 'dim' });
    expect(parseChordSymbol('Bbmaj7')).toMatchObject({ root: 10, quality: 'maj7' });
    expect(parseChordSymbol('Am')).toMatchObject({ root: 9, quality: 'min' });
    expect(parseChordSymbol('Bdim')).toMatchObject({ root: 11, quality: 'dim' });
  });

  it('parses slash chords', () => {
    expect(parseChordSymbol('C/E')).toEqual({
      text: 'C/E',
      root: 0,
      rootName: 'C',
      quality: 'maj',
      bass: 4,
    });
    expect(parseChordSymbol('Am7/G')).toMatchObject({ root: 9, quality: 'min7', bass: 7 });
    expect(parseChordSymbol('D/F#')).toMatchObject({ root: 2, bass: 6 });
    expect(parseChordSymbol('C/Bb')).toMatchObject({ bass: 10 });
    expect(parseChordSymbol('G7/B')).toMatchObject({ quality: '7', bass: 11 });
  });

  it.each([
    '',
    ' ',
    'H',
    'c',
    'cm',
    'Cm7-5',
    'Cdim9',
    'C9',
    'Cadd9',
    'C6',
    'Cm6',
    'Csus2',
    'Cmaj',
    'Cx',
    'C ',
    ' C',
    'C7 ',
    'C/',
    'C/H',
    'C/e',
    'C/E/G',
    'C/E7',
    'C##',
    'Cbb',
    'N.C.',
    'C(7)',
  ])('rejects %j', (text) => {
    expect(() => parseChordSymbol(text)).toThrow(Error);
  });

  it('reads m7b5 and dim7 (spike 2, T4)', () => {
    expect(parseChordSymbol('Bm7b5')).toEqual({ text: 'Bm7b5', root: 11, rootName: 'B', quality: 'm7b5', bass: null });
    expect(parseChordSymbol('Cdim7')).toEqual({ text: 'Cdim7', root: 0, rootName: 'C', quality: 'dim7', bass: null });
    expect(parseChordSymbol('F#m7b5/C').bass).toBe(0);
  });
});
