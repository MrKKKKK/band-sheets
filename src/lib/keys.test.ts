import { describe, expect, it } from 'vitest';
import { diatonicChords, parseKey } from './keys';

describe('parseKey', () => {
  it('parses tonic, accidental and minor', () => {
    expect(parseKey('C')).toEqual({ tonic: 'C', accidental: '', minor: false });
    expect(parseKey('F#m')).toEqual({
      tonic: 'F',
      accidental: '#',
      minor: true,
    });
    expect(parseKey('Bb')).toEqual({
      tonic: 'B',
      accidental: 'b',
      minor: false,
    });
  });

  it.each(['', 'H', 'Cmaj', 'c', 'C#b', 'Am7', ' C', 'Cm '])(
    'rejects %j',
    (key) => {
      expect(parseKey(key)).toBeNull();
    },
  );
});

describe('diatonicChords', () => {
  it.each([
    ['C', 'C Dm Em F G Am Bdim'],
    ['G', 'G Am Bm C D Em F#dim'],
    ['F', 'F Gm Am Bb C Dm Edim'],
    ['Bb', 'Bb Cm Dm Eb F Gm Adim'],
    ['Eb', 'Eb Fm Gm Ab Bb Cm Ddim'],
    ['D', 'D Em F#m G A Bm C#dim'],
    ['Am', 'Am Bdim C Dm Em F G E'],
    ['F#m', 'F#m G#dim A Bm C#m D E C#'],
    ['Em', 'Em F#dim G Am Bm C D B'],
    ['Cm', 'Cm Ddim Eb Fm Gm Ab Bb G'],
    ['Dm', 'Dm Edim F Gm Am Bb C A'],
  ])('%s → %s', (key, chords) => {
    expect(diatonicChords(key)).toEqual(chords.split(' '));
  });

  it.each(['H', 'Cmaj', ''])('returns [] for invalid key %j', (key) => {
    expect(diatonicChords(key)).toEqual([]);
  });
});
