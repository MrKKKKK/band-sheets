import { describe, expect, it } from 'vitest';
import { applyLyrics, lyricsText, nextSectionLabel } from './lyrics';
import { parseSong } from './parseSong';
import { serializeSong } from './serializeSong';

const SONG = `{title: t}
{key: C}

# top comment

{start_of_verse: A}
[C]きらきら[F]ひかる
{comment: x2}
[G]おそらの[C]ほしよ

[C][G]
{end_of_verse}

{start_of_chorus: サビ}
[F]まばたき[C]しては
[G]みんなを[C]みてる
{end_of_chorus}

{start_of_part: Drums}
\\instrument percussion
{end_of_part}
`;

const song = parseSong(SONG);
const text = lyricsText(song);

/** apply → serialize, for readable expectations. */
const apply = (t: string) => serializeSong(applyLyrics(song, t));

describe('nextSectionLabel', () => {
  it('returns the first unused uppercase letter', () => {
    expect(nextSectionLabel([])).toBe('A');
    expect(nextSectionLabel(['A', 'B', 'サビ'])).toBe('C');
    expect(nextSectionLabel(new Set(['B']))).toBe('A');
  });

  it('continues with two letters after Z', () => {
    const az = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(nextSectionLabel(az)).toBe('AA');
  });
});

describe('lyricsText', () => {
  it('lists lyric lines per section, skipping raw, blank and chord-only lines', () => {
    expect(text).toBe(
      'きらきらひかる\nおそらのほしよ\n\nまばたきしては\nみんなをみてる',
    );
  });

  it('includes the implicit section and is empty for a song without lyrics', () => {
    expect(
      lyricsText(parseSong('[C]a\nb\n\n{start_of_verse}\nc\n{end_of_verse}\n')),
    ).toBe('a\nb\n\nc');
    expect(lyricsText(parseSong('{title: x}\n[C][G]\n'))).toBe('');
  });
});

describe('applyLyrics', () => {
  it('returns an equal song for unchanged text', () => {
    expect(applyLyrics(song, text)).toEqual(song);
    expect(applyLyrics(song, text + '\n')).toEqual(song);
  });

  it('keeps parts and meta untouched', () => {
    const r = applyLyrics(song, '');
    expect(r.meta).toBe(song.meta);
    expect(r.parts).toBe(song.parts);
  });

  it('drops chords only from an edited line', () => {
    expect(
      apply('きらきらひかる\nおそらのほしが\n\nまばたきしては\nみんなをみてる'),
    ).toBe(SONG.replace('[G]おそらの[C]ほしよ', 'おそらのほしが'));
  });

  it('inserts and deletes lines', () => {
    expect(apply('きらきらひかる\nNEW\nおそらのほしよ\n\nみんなをみてる')).toBe(
      SONG.replace('{comment: x2}', 'NEW\n{comment: x2}').replace(
        '[F]まばたき[C]しては\n',
        '',
      ),
    );
  });

  it('keeps a raw line before the next surviving line, else at the section end', () => {
    // "おそらのほしよ" deleted: {comment: x2}, blank and [C][G] go to the end.
    expect(apply('きらきらひかる\n\nまばたきしては\nみんなをみてる')).toContain(
      '{start_of_verse: A}\n[C]きらきら[F]ひかる\n{comment: x2}\n\n[C][G]\n{end_of_verse}',
    );
  });

  it('creates a verse with the next free label for an inserted block', () => {
    expect(
      apply(
        'きらきらひかる\nおそらのほしよ\n\nNEW1\nNEW2\n\nまばたきしては\nみんなをみてる',
      ),
    ).toContain(
      '{end_of_verse}\n\n{start_of_verse: B}\nNEW1\nNEW2\n{end_of_verse}\n\n{start_of_chorus: サビ}',
    );
  });

  it('lets a section be inherited only once when a block is split', () => {
    const r = applyLyrics(
      song,
      'きらきらひかる\n\nおそらのほしよ\n\nまばたきしては\nみんなをみてる',
    );
    expect(r.chart.map((s) => [s.kind, s.label])).toEqual([
      ['', ''],
      ['verse', 'A'],
      ['verse', 'B'],
      ['chorus', 'サビ'],
    ]);
    // Tie → the earlier block inherits; lines keep their chords in both and
    // the comment / trailing lines follow おそらのほしよ.
    expect(serializeSong(r)).toContain(
      '{start_of_verse: A}\n[C]きらきら[F]ひかる\n{end_of_verse}\n\n{start_of_verse: B}\n{comment: x2}\n[G]おそらの[C]ほしよ\n\n[C][G]\n{end_of_verse}',
    );
  });

  it('matches repeated identical lines in order', () => {
    const s = parseSong(
      '{start_of_chorus: S1}\n[C]la\n{end_of_chorus}\n\n{start_of_chorus: S2}\n[G]la\n{end_of_chorus}\n',
    );
    expect(lyricsText(s)).toBe('la\n\nla');
    expect(applyLyrics(s, 'la\n\nla')).toEqual(s);
    expect(serializeSong(applyLyrics(s, 'la\n\nla\n\nla'))).toBe(
      '{start_of_chorus: S1}\n[C]la\n{end_of_chorus}\n\n{start_of_chorus: S2}\n[G]la\n{end_of_chorus}\n\n{start_of_verse: A}\nla\n{end_of_verse}\n',
    );
    // Deleting the first block keeps S1 (first-come match), dropping S2.
    expect(serializeSong(applyLyrics(s, 'la'))).toBe(
      '{start_of_chorus: S1}\n[C]la\n{end_of_chorus}\n',
    );
  });

  it('keeps sections without lyric lines in place', () => {
    const s = parseSong(
      '{start_of_verse: Intro}\n[C][G]\n{end_of_verse}\n\n{start_of_verse: A}\n[C]a\n{end_of_verse}\n\n{start_of_bridge: Solo}\n[F][G]\n{end_of_bridge}\n\n{start_of_verse: B}\n[G]b\n{end_of_verse}\n',
    );
    expect(applyLyrics(s, 'a\n\nb')).toEqual(s);
    expect(serializeSong(applyLyrics(s, 'a\n\nX\n\nb'))).toBe(
      '{start_of_verse: Intro}\n[C][G]\n{end_of_verse}\n\n{start_of_verse: A}\n[C]a\n{end_of_verse}\n\n{start_of_bridge: Solo}\n[F][G]\n{end_of_bridge}\n\n{start_of_verse: C}\nX\n{end_of_verse}\n\n{start_of_verse: B}\n[G]b\n{end_of_verse}\n',
    );
  });

  it('moves non-lyric lines of a removed section to the next surviving line', () => {
    expect(apply('まばたきしては\nみんなをみてる')).toBe(
      `{title: t}
{key: C}

# top comment

{start_of_chorus: サビ}
{comment: x2}

[C][G]
[F]まばたき[C]しては
[G]みんなを[C]みてる
{end_of_chorus}

{start_of_part: Drums}
\\instrument percussion
{end_of_part}
`,
    );
  });

  it('keeps orphaned non-blank lines in an implicit section when nothing follows', () => {
    expect(serializeSong(applyLyrics(song, ''))).toBe(
      '{title: t}\n{key: C}\n\n# top comment\n\n{comment: x2}\n[C][G]\n\n{start_of_part: Drums}\n\\instrument percussion\n{end_of_part}\n',
    );
    expect(apply('きらきらひかる\nおそらのほしよ')).toContain(
      '[C][G]\n{end_of_verse}\n\n{start_of_part: Drums}',
    );
  });

  it('builds sections from scratch for an empty song', () => {
    const empty = parseSong('');
    expect(applyLyrics(empty, '\nfoo\nbar\n\n\nbaz\n')).toEqual({
      ...empty,
      chart: [
        {
          kind: 'verse',
          label: 'A',
          lines: [
            { segments: [{ lyrics: 'foo' }] },
            { segments: [{ lyrics: 'bar' }] },
          ],
        },
        {
          kind: 'verse',
          label: 'B',
          lines: [{ segments: [{ lyrics: 'baz' }] }],
        },
      ],
    });
  });

  it('keeps kind/label and chord-only lines when the only line is edited (R1)', () => {
    const s = parseSong(
      '{start_of_chorus: サビ}\n[G]bb\n[D][G]\n{end_of_chorus}\n',
    );
    expect(serializeSong(applyLyrics(s, 'bbX'))).toBe(
      '{start_of_chorus: サビ}\nbbX\n[D][G]\n{end_of_chorus}\n',
    );
  });

  it('inherits kind/label by block position when a block has no matched lines (R1)', () => {
    const s = parseSong(
      '{start_of_verse: A}\n[C]aa\n{end_of_verse}\n\n{start_of_chorus: サビ}\n[G]bb\n[D][G]\n{end_of_chorus}\n',
    );
    expect(serializeSong(applyLyrics(s, 'aa\n\nbbX'))).toBe(
      '{start_of_verse: A}\n[C]aa\n{end_of_verse}\n\n{start_of_chorus: サビ}\nbbX\n[D][G]\n{end_of_chorus}\n',
    );
  });

  it('keeps non-lyric lines of a section lost by merging blocks (R1)', () => {
    const s = parseSong(
      '{start_of_verse: A}\n[C]aa\n{end_of_verse}\n\n{start_of_chorus: サビ}\n[G][D]\n[G]bb\n[Am][F]\n{end_of_chorus}\n',
    );
    expect(serializeSong(applyLyrics(s, 'aa\nbb'))).toBe(
      '{start_of_verse: A}\n[C]aa\n[G][D]\n[G]bb\n[Am][F]\n{end_of_verse}\n',
    );
  });

  it('keeps trailing lines of merged sections in their old order (R1)', () => {
    const s = parseSong(
      '{start_of_verse: A}\n[C]aa\n[C][G]\n{end_of_verse}\n\n{start_of_chorus: サビ}\n[G][D]\n[G]bb\n{end_of_chorus}\n',
    );
    expect(serializeSong(applyLyrics(s, 'aa\nbb'))).toBe(
      '{start_of_verse: A}\n[C]aa\n[C][G]\n[G][D]\n[G]bb\n{end_of_verse}\n',
    );
  });

  it('keeps a comment with its line and gives the label to the larger part when a section is split (R11)', () => {
    const s = parseSong(
      '{start_of_verse: A}\na\nb\n{comment: before c}\nc\n{end_of_verse}\n',
    );
    expect(serializeSong(applyLyrics(s, 'a\n\nb\nc'))).toBe(
      '{start_of_verse: B}\na\n{end_of_verse}\n\n{start_of_verse: A}\nb\n{comment: before c}\nc\n{end_of_verse}\n',
    );
  });

  describe('positional inheritance around matched blocks (N2)', () => {
    const two = parseSong(
      '{start_of_chorus: サビ}\n# c1\n[C]aaa\n{end_of_chorus}\n\n{start_of_verse: A}\n[G]bbb\n{end_of_verse}\n',
    );
    const labels = (s: ReturnType<typeof parseSong>) =>
      s.chart.map((c) => [c.kind, c.label]);

    it('gives an inserted leading block a new label and the edited line its old section', () => {
      expect(serializeSong(applyLyrics(two, 'new\n\naaa2\n\nbbb'))).toBe(
        '{start_of_verse: B}\nnew\n{end_of_verse}\n\n{start_of_chorus: サビ}\n# c1\naaa2\n{end_of_chorus}\n\n{start_of_verse: A}\n[G]bbb\n{end_of_verse}\n',
      );
    });

    it('aligns a gap after the last matched block from that block', () => {
      const s = parseSong(
        '{start_of_verse: A}\n[C]aa\n{end_of_verse}\n\n{start_of_chorus: サビ}\n[G]bb\n{end_of_chorus}\n',
      );
      expect(labels(applyLyrics(s, 'aa\n\nbbX\n\nnew'))).toEqual([
        ['verse', 'A'],
        ['chorus', 'サビ'],
        ['verse', 'B'],
      ]);
    });

    it('aligns a gap between matched blocks to the following one', () => {
      const s = parseSong(
        '{start_of_verse: A}\n[C]aa\n{end_of_verse}\n\n{start_of_bridge: B}\n[F]bb\n{end_of_bridge}\n\n{start_of_chorus: サビ}\n[G]cc\n{end_of_chorus}\n',
      );
      expect(labels(applyLyrics(s, 'aa\n\nnew\n\nbbX\n\ncc'))).toEqual([
        ['verse', 'A'],
        ['verse', 'C'],
        ['bridge', 'B'],
        ['chorus', 'サビ'],
      ]);
      // A deleted section in the gap: the edited block takes the one next to
      // the following matched block.
      expect(labels(applyLyrics(s, 'aaX\n\ncc'))).toEqual([
        ['bridge', 'B'],
        ['chorus', 'サビ'],
      ]);
    });

    it('does not lose a label when sections are swapped and edited', () => {
      expect(serializeSong(applyLyrics(two, 'bbb\n\naaa2'))).toBe(
        '{start_of_verse: A}\n[G]bbb\n{end_of_verse}\n\n{start_of_chorus: サビ}\n# c1\naaa2\n{end_of_chorus}\n',
      );
      expect(labels(applyLyrics(two, 'bbb2\n\naaa2'))).toEqual([
        ['chorus', 'サビ'],
        ['verse', 'A'],
      ]);
    });
  });

  it('does not put blank lines into an implicit section', () => {
    const s = parseSong(
      'x\ny\nz\n\n{start_of_verse: A}\n[C]aa\n\n[G]bb\n{end_of_verse}\n',
    );
    const r = applyLyrics(s, 'x\ny\nz\naa\nbb');
    expect(serializeSong(r)).toBe('x\ny\nz\n[C]aa\n[G]bb\n');
    expect(parseSong(serializeSong(r))).toEqual(r);
  });

  it('accepts CRLF text', () => {
    expect(applyLyrics(song, text.replace(/\n/g, '\r\n'))).toEqual(song);
  });
});
