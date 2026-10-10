import { describe, expect, it } from 'vitest';
import { isValidChordText, usedChords } from './chordText';
import { parseSong } from './parseSong';

describe('isValidChordText', () => {
  it.each(['C', '(C)', 'N.C.', 'C7(9,13)', 'Bm7(b5)', 'F#m', ' Am '])(
    'accepts %j',
    (s) => {
      expect(isValidChordText(s)).toBe(true);
    },
  );

  it.each(['', '   ', 'C G', 'C\tG', '[C]', 'C]', '{C}', 'C}', 'a[b'])(
    'rejects %j',
    (s) => {
      expect(isValidChordText(s)).toBe(false);
    },
  );
});

describe('usedChords', () => {
  it('lists chart chords uniquely in order of first appearance', () => {
    const song = parseSong(
      [
        '{key: C}',
        '[G]intro',
        '{sov: A}',
        '[C]a[Am]b[C]c',
        '{comment: [X]}',
        '{eov}',
        '{soc: B}',
        '[F]d[G]e',
        '{eoc}',
        '{start_of_part: Bass}',
        '[Z] not a chord',
        '{end_of_part}',
      ].join('\n'),
    );
    expect(usedChords(song)).toEqual(['G', 'C', 'Am', 'F']);
  });

  it('returns [] for a song without chords', () => {
    expect(usedChords(parseSong('just lyrics'))).toEqual([]);
  });
});
