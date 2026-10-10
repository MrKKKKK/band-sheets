import { describe, expect, it } from 'vitest';
import {
  graphemes,
  lineLyrics,
  setChordAt,
  updateChord,
  updateLyricLine,
} from './chartEdit';
import type { LyricLine, Song } from './song';

/** NFD 'が': base 'か' + combining dakuten U+3099 (two code points, one grapheme). */
const GA_NFD = 'が';
/** 👍🏽: thumbs-up + skin-tone modifier (two code points, one grapheme). */
const THUMBS_UP_MEDIUM = '👍\u{1F3FD}';
/** 👨‍👩‍👧: family ZWJ sequence (five code points, one grapheme). */
const FAMILY = '👨‍👩‍👧';

const line = (...segments: LyricLine['segments']): LyricLine => ({ segments });

describe('lineLyrics', () => {
  it('concatenates segment lyrics', () => {
    expect(
      lineLyrics(line({ lyrics: 'ab' }, { chord: 'C', lyrics: 'cd' })),
    ).toBe('abcd');
    expect(lineLyrics(line())).toBe('');
  });
});

describe('graphemes', () => {
  it('keeps a combining-mark dakuten attached to its base character (R8)', () => {
    expect(graphemes(GA_NFD)).toEqual([GA_NFD]);
  });

  it('keeps an emoji skin-tone modifier attached to its base emoji (R8)', () => {
    expect(graphemes(THUMBS_UP_MEDIUM)).toEqual([THUMBS_UP_MEDIUM]);
  });

  it('keeps a ZWJ emoji sequence together (R8)', () => {
    expect(graphemes(FAMILY)).toEqual([FAMILY]);
  });

  it('still splits a surrogate-pair code point as one grapheme', () => {
    expect(graphemes('𠮷野家')).toEqual(['𠮷', '野', '家']);
  });
});

describe('setChordAt', () => {
  it('does not split a grapheme cluster: NFD dakuten (R8)', () => {
    // GA_NFD ('か' + combining U+3099) is two code points but one grapheme;
    // charIndex 1 is the boundary right after it, not inside it. The old
    // code-point-based implementation split 'か' from the combining mark.
    expect(setChordAt(line({ lyrics: GA_NFD + 'x' }), 1, 'C')).toEqual(
      line({ lyrics: GA_NFD }, { chord: 'C', lyrics: 'x' }),
    );
  });

  it('does not split a grapheme cluster: emoji skin tone (R8)', () => {
    expect(
      setChordAt(line({ lyrics: THUMBS_UP_MEDIUM + 'x' }), 1, 'C'),
    ).toEqual(line({ lyrics: THUMBS_UP_MEDIUM }, { chord: 'C', lyrics: 'x' }));
  });

  it('does not split a grapheme cluster: ZWJ family emoji (R8)', () => {
    expect(setChordAt(line({ lyrics: FAMILY + 'x' }), 1, 'C')).toEqual(
      line({ lyrics: FAMILY }, { chord: 'C', lyrics: 'x' }),
    );
  });

  it('counts a mix of combining marks and emoji sequences as one grapheme each (R8)', () => {
    const text = GA_NFD + THUMBS_UP_MEDIUM + FAMILY;
    expect(setChordAt(line({ lyrics: text }), 2, 'C')).toEqual(
      line(
        { lyrics: GA_NFD + THUMBS_UP_MEDIUM },
        { chord: 'C', lyrics: FAMILY },
      ),
    );
    // 3 graphemes total: index 3 is end-of-line, giving a trailing
    // empty-lyrics chord segment (not splitting FAMILY).
    expect(setChordAt(line({ lyrics: text }), 3, 'C')).toEqual(
      line({ lyrics: text }, { chord: 'C', lyrics: '' }),
    );
  });

  it('splits a chordless line', () => {
    expect(setChordAt(line({ lyrics: 'きらきら' }), 2, 'C')).toEqual(
      line({ lyrics: 'きら' }, { chord: 'C', lyrics: 'きら' }),
    );
  });

  it('places a chord at index 0 of a chordless line without a leading segment', () => {
    expect(setChordAt(line({ lyrics: 'abc' }), 0, 'C')).toEqual(
      line({ chord: 'C', lyrics: 'abc' }),
    );
  });

  it('keeps the leading segment chordless when splitting it', () => {
    const r = setChordAt(
      line({ lyrics: 'abcd' }, { chord: 'G', lyrics: 'ef' }),
      1,
      'C',
    );
    expect(r).toEqual(
      line(
        { lyrics: 'a' },
        { chord: 'C', lyrics: 'bcd' },
        { chord: 'G', lyrics: 'ef' },
      ),
    );
    expect('chord' in r.segments[0]).toBe(false);
  });

  it('splits a chorded segment, keeping its chord on the first half', () => {
    expect(setChordAt(line({ chord: 'C', lyrics: 'abcd' }), 2, 'G')).toEqual(
      line({ chord: 'C', lyrics: 'ab' }, { chord: 'G', lyrics: 'cd' }),
    );
  });

  it('overwrites a chord that already starts at the index', () => {
    expect(
      setChordAt(line({ lyrics: 'ab' }, { chord: 'C', lyrics: 'cd' }), 2, 'Am'),
    ).toEqual(line({ lyrics: 'ab' }, { chord: 'Am', lyrics: 'cd' }));
  });

  it('counts code points (surrogate pairs)', () => {
    // 𠮷 is one code point but two UTF-16 units.
    expect(setChordAt(line({ lyrics: '𠮷野家' }), 1, 'C')).toEqual(
      line({ lyrics: '𠮷' }, { chord: 'C', lyrics: '野家' }),
    );
    expect(
      setChordAt(
        line({ chord: 'G', lyrics: '𠮷𠮷' }, { chord: 'C', lyrics: 'x' }),
        2,
        'D',
      ),
    ).toEqual(
      line({ chord: 'G', lyrics: '𠮷𠮷' }, { chord: 'D', lyrics: 'x' }),
    );
  });

  it('appends a chord with empty lyrics at the end of the line', () => {
    expect(setChordAt(line({ chord: 'C', lyrics: 'ab' }), 2, 'G')).toEqual(
      line({ chord: 'C', lyrics: 'ab' }, { chord: 'G', lyrics: '' }),
    );
    expect(setChordAt(line({ lyrics: '𠮷' }), 1, 'G')).toEqual(
      line({ lyrics: '𠮷' }, { chord: 'G', lyrics: '' }),
    );
  });

  it('overwrites an existing end-of-line chord', () => {
    expect(
      setChordAt(
        line({ chord: 'C', lyrics: 'ab' }, { chord: 'G', lyrics: '' }),
        2,
        'F',
      ),
    ).toEqual(line({ chord: 'C', lyrics: 'ab' }, { chord: 'F', lyrics: '' }));
  });

  it('places a chord on an empty line', () => {
    expect(setChordAt(line(), 0, 'C')).toEqual(
      line({ chord: 'C', lyrics: '' }),
    );
  });

  it('clamps out-of-range indexes', () => {
    expect(setChordAt(line({ lyrics: 'ab' }), 9, 'C')).toEqual(
      line({ lyrics: 'ab' }, { chord: 'C', lyrics: '' }),
    );
    expect(setChordAt(line({ lyrics: 'ab' }), -1, 'C')).toEqual(
      line({ chord: 'C', lyrics: 'ab' }),
    );
  });

  it('does not mutate the input', () => {
    const l = line({ chord: 'C', lyrics: 'abcd' });
    setChordAt(l, 2, 'G');
    expect(l).toEqual(line({ chord: 'C', lyrics: 'abcd' }));
  });
});

describe('updateChord', () => {
  it('edits a chord', () => {
    expect(
      updateChord(line({ lyrics: 'a' }, { chord: 'C', lyrics: 'b' }), 1, 'C7'),
    ).toEqual(line({ lyrics: 'a' }, { chord: 'C7', lyrics: 'b' }));
  });

  it('deletes a chord by merging its lyrics into the previous segment', () => {
    expect(
      updateChord(
        line(
          { lyrics: 'a' },
          { chord: 'C', lyrics: 'b' },
          { chord: 'G', lyrics: 'c' },
        ),
        1,
        null,
      ),
    ).toEqual(line({ lyrics: 'ab' }, { chord: 'G', lyrics: 'c' }));
  });

  it('deleting the first chord leaves a chordless leading segment', () => {
    const r = updateChord(
      line({ chord: 'C', lyrics: 'ab' }, { chord: 'G', lyrics: 'c' }),
      0,
      null,
    );
    expect(r).toEqual(line({ lyrics: 'ab' }, { chord: 'G', lyrics: 'c' }));
    expect('chord' in r.segments[0]).toBe(false);
  });

  it('handles chord-only lines', () => {
    const l = line({ chord: 'C', lyrics: '' }, { chord: 'G', lyrics: '' });
    expect(updateChord(l, 0, null)).toEqual(line({ chord: 'G', lyrics: '' }));
    expect(updateChord(l, 1, null)).toEqual(line({ chord: 'C', lyrics: '' }));
    expect(updateChord(l, 1, 'Am')).toEqual(
      line({ chord: 'C', lyrics: '' }, { chord: 'Am', lyrics: '' }),
    );
    expect(updateChord(line({ chord: 'C', lyrics: '' }), 0, null)).toEqual(
      line(),
    );
  });

  it('ignores invalid indexes and chordless segments on delete', () => {
    const l = line({ lyrics: 'a' }, { chord: 'C', lyrics: 'b' });
    expect(updateChord(l, 5, 'G')).toEqual(l);
    expect(updateChord(l, 0, null)).toEqual(l);
  });
});

describe('updateLyricLine', () => {
  const song: Song = {
    meta: { title: 't' },
    chart: [
      {
        kind: 'verse',
        label: 'A',
        lines: [{ raw: '# c' }, line({ lyrics: 'ab' })],
      },
    ],
    parts: [],
  };

  it('replaces one lyric line without mutating the song', () => {
    const before = structuredClone(song);
    const r = updateLyricLine(song, 0, 1, (l) => setChordAt(l, 0, 'C'));
    expect(r.chart[0].lines[1]).toEqual(line({ chord: 'C', lyrics: 'ab' }));
    expect(r.chart[0].lines[0]).toBe(song.chart[0].lines[0]);
    expect(song).toEqual(before);
  });

  it('ignores raw lines and out-of-range targets', () => {
    const fn = () => line({ lyrics: 'x' });
    expect(updateLyricLine(song, 0, 0, fn)).toEqual(song);
    expect(updateLyricLine(song, 3, 0, fn)).toEqual(song);
    expect(updateLyricLine(song, 0, 9, fn)).toEqual(song);
  });
});
