import { describe, expect, it } from 'vitest';
import { sampleSong, sampleSongText } from './fixtures/sampleSong';
import { parseSong } from './parseSong';

describe('parseSong', () => {
  it('parses the sample song', () => {
    expect(parseSong(sampleSongText)).toEqual(sampleSong);
  });

  describe('meta', () => {
    it('reads title/key/tempo/time', () => {
      const song = parseSong(
        '{title: X}\n{key: Am}\n{tempo: 120}\n{time: 3/4}',
      );
      expect(song.meta).toEqual({
        title: 'X',
        key: 'Am',
        tempo: 120,
        time: '3/4',
      });
    });

    it('accepts short forms, any case and no space after the colon', () => {
      const song = parseSong('{T:Song}\n{K:D}\n{TEMPO:90}');
      expect(song.meta).toEqual({ title: 'Song', key: 'D', tempo: 90 });
    });

    it('defaults title to empty string', () => {
      expect(parseSong('').meta).toEqual({ title: '' });
    });

    it('keeps a non-numeric tempo as a raw line', () => {
      const song = parseSong('{tempo: fast}');
      expect(song.meta.tempo).toBeUndefined();
      expect(song.chart).toEqual([
        { kind: '', label: '', lines: [{ raw: '{tempo: fast}' }] },
      ]);
    });

    it('treats an empty value as "not seen", so a later directive for the same field is applied (R13)', () => {
      // Generalizes the pre-existing {x_palette:} "not seen" rule to every
      // meta field, so e.g. a stray {title:} before the real {title: ...}
      // does not swallow it (and serializing twice stays stable).
      const song = parseSong('{title:}\n{title: Real}');
      expect(song.meta.title).toBe('Real');
      expect(song.chart).toEqual([
        { kind: '', label: '', lines: [{ raw: '{title:}' }] },
      ]);
    });

    it('treats an empty key/tempo/time directive as not seen too (R13)', () => {
      expect(parseSong('{key:}\n{key: C}').meta.key).toBe('C');
      expect(parseSong('{tempo:}\n{tempo: 100}').meta.tempo).toBe(100);
      expect(parseSong('{time:}\n{time: 4/4}').meta.time).toBe('4/4');
    });

    it('keeps a repeated meta directive as a raw line', () => {
      const song = parseSong('{key: C}\n{key: D}');
      expect(song.meta.key).toBe('C');
      expect(song.chart).toEqual([
        { kind: '', label: '', lines: [{ raw: '{key: D}' }] },
      ]);
    });

    describe('x_palette', () => {
      it('reads the first top-level x_palette split on whitespace', () => {
        const song = parseSong('{x_palette:  C7(9,13)   Fmaj7\tN.C. }');
        expect(song.meta.palette).toEqual(['C7(9,13)', 'Fmaj7', 'N.C.']);
        expect(song.chart).toEqual([]);
      });

      it('accepts any case of the directive name', () => {
        expect(parseSong('{X_Palette: Am}').meta.palette).toEqual(['Am']);
      });

      it('keeps a later x_palette as a raw line', () => {
        const song = parseSong('{x_palette: C}\n{x_palette: D}');
        expect(song.meta.palette).toEqual(['C']);
        expect(song.chart).toEqual([
          { kind: '', label: '', lines: [{ raw: '{x_palette: D}' }] },
        ]);
      });

      it('keeps an x_palette inside a section as a raw line', () => {
        const song = parseSong('{sov: A}\n{x_palette: C}\n{eov}');
        expect(song.meta.palette).toBeUndefined();
        expect(song.chart[0].lines).toEqual([{ raw: '{x_palette: C}' }]);
      });

      it('keeps an empty x_palette as a raw line', () => {
        const song = parseSong('{x_palette: }\n{x_palette}');
        expect(song.meta.palette).toBeUndefined();
        expect(song.chart[0].lines).toEqual([
          { raw: '{x_palette: }' },
          { raw: '{x_palette}' },
        ]);
      });
    });
  });

  describe('chart sections', () => {
    it('parses kind and label', () => {
      const song = parseSong('{start_of_chorus: サビ}\n[C]la\n{end_of_chorus}');
      expect(song.chart).toEqual([
        {
          kind: 'chorus',
          label: 'サビ',
          lines: [{ segments: [{ chord: 'C', lyrics: 'la' }] }],
        },
      ]);
    });

    it('uses an empty label when none is given', () => {
      const song = parseSong('{start_of_bridge}\nla\n{end_of_bridge}');
      expect(song.chart[0]).toMatchObject({ kind: 'bridge', label: '' });
    });

    it('accepts sov/soc/sob short forms', () => {
      const song = parseSong(
        '{sov: A}\na\n{eov}\n{soc: B}\nb\n{eoc}\n{sob: C}\nc\n{eob}',
      );
      expect(song.chart.map((s) => [s.kind, s.label])).toEqual([
        ['verse', 'A'],
        ['chorus', 'B'],
        ['bridge', 'C'],
      ]);
    });

    it('accepts any kind word', () => {
      const song = parseSong('{start_of_intro: Intro}\n[C]\n{end_of_intro}');
      expect(song.chart[0]).toMatchObject({ kind: 'intro', label: 'Intro' });
    });

    it('keeps blank lines inside a section as empty lines', () => {
      const song = parseSong('{sov: A}\na\n\nb\n{eov}');
      expect(song.chart[0].lines).toEqual([
        { segments: [{ lyrics: 'a' }] },
        { segments: [] },
        { segments: [{ lyrics: 'b' }] },
      ]);
    });

    it('collects lines outside sections into implicit sections split by blank lines', () => {
      const song = parseSong('[C]a\nb\n\n# note\n{sov: A}\nx\n{eov}\n[G]c');
      expect(song.chart).toEqual([
        {
          kind: '',
          label: '',
          lines: [
            { segments: [{ chord: 'C', lyrics: 'a' }] },
            { segments: [{ lyrics: 'b' }] },
          ],
        },
        { kind: '', label: '', lines: [{ raw: '# note' }] },
        { kind: 'verse', label: 'A', lines: [{ segments: [{ lyrics: 'x' }] }] },
        {
          kind: '',
          label: '',
          lines: [{ segments: [{ chord: 'G', lyrics: 'c' }] }],
        },
      ]);
    });
  });

  describe('chord lines', () => {
    const segs = (line: string) => {
      const l = parseSong(`{sov}\n${line}\n{eov}`).chart[0].lines[0];
      return 'segments' in l ? l.segments : l;
    };

    it('splits at chord markers; leading lyrics have no chord key', () => {
      const result = segs('ah [C]きら[F]ひか');
      expect(result).toEqual([
        { lyrics: 'ah ' },
        { chord: 'C', lyrics: 'きら' },
        { chord: 'F', lyrics: 'ひか' },
      ]);
      expect(Object.keys((result as object[])[0])).toEqual(['lyrics']);
    });

    it('keeps chord text opaque', () => {
      expect(segs('[C7(9,13)]a[N.C.][(C)] [(E)] [(G)]')).toEqual([
        { chord: 'C7(9,13)', lyrics: 'a' },
        { chord: 'N.C.', lyrics: '' },
        { chord: '(C)', lyrics: ' ' },
        { chord: '(E)', lyrics: ' ' },
        { chord: '(G)', lyrics: '' },
      ]);
    });

    it('treats an unclosed bracket as lyrics', () => {
      expect(segs('[C]a[b')).toEqual([{ chord: 'C', lyrics: 'a[b' }]);
    });

    it('keeps comments and unknown directives as raw lines', () => {
      const song = parseSong('{sov: A}\n# memo\n{comment: x}\n{key: D}\n{eov}');
      expect(song.chart[0].lines).toEqual([
        { raw: '# memo' },
        { raw: '{comment: x}' },
        { raw: '{key: D}' },
      ]);
      expect(song.meta.key).toBeUndefined();
    });
  });

  describe('parts', () => {
    it('keeps the body verbatim', () => {
      const body =
        '\\section "A"\n  :4 C4 {h} |\n\n# not a comment here\n{sov}';
      const song = parseSong(`{start_of_part: Bass}\n${body}\n{end_of_part}`);
      expect(song.parts).toEqual([{ name: 'Bass', body }]);
      expect(song.chart).toEqual([]);
    });

    it('allows an empty body and empty name', () => {
      const song = parseSong('{start_of_part}\n{end_of_part}');
      expect(song.parts).toEqual([{ name: '', body: '' }]);
    });
  });

  describe('robustness', () => {
    it('handles CRLF line endings and a BOM', () => {
      const crlf = '﻿' + sampleSongText.replace(/\n/g, '\r\n');
      expect(parseSong(crlf)).toEqual(sampleSong);
    });

    it('closes an unclosed section at EOF', () => {
      const song = parseSong('{sov: A}\n[C]a');
      expect(song.chart).toEqual([
        {
          kind: 'verse',
          label: 'A',
          lines: [{ segments: [{ chord: 'C', lyrics: 'a' }] }],
        },
      ]);
    });

    it('closes an unclosed section when another one starts', () => {
      const song = parseSong('{sov: A}\na\n{soc: B}\nb\n{eoc}');
      expect(song.chart.map((s) => s.label)).toEqual(['A', 'B']);
    });

    it('closes a section on a mismatched end directive', () => {
      const song = parseSong('{sov: A}\na\n{end_of_chorus}\nb');
      expect(song.chart).toEqual([
        { kind: 'verse', label: 'A', lines: [{ segments: [{ lyrics: 'a' }] }] },
        { kind: '', label: '', lines: [{ segments: [{ lyrics: 'b' }] }] },
      ]);
    });

    it('keeps a stray end directive as a raw line', () => {
      expect(parseSong('{eov}').chart).toEqual([
        { kind: '', label: '', lines: [{ raw: '{eov}' }] },
      ]);
    });

    it('closes an unclosed part at EOF, keeping the body exactly', () => {
      const song = parseSong('{start_of_part: Drums}\nHH |\n');
      expect(song.parts).toEqual([{ name: 'Drums', body: 'HH |' }]);
    });

    it('closes an unclosed part when another part starts', () => {
      const song = parseSong(
        '{start_of_part: A}\na\n{start_of_part: B}\nb\n{end_of_part}',
      );
      expect(song.parts).toEqual([
        { name: 'A', body: 'a' },
        { name: 'B', body: 'b' },
      ]);
    });

    it('starts a part inside an unclosed section', () => {
      const song = parseSong(
        '{sov: A}\na\n{start_of_part: P}\nx\n{end_of_part}',
      );
      expect(song.chart).toHaveLength(1);
      expect(song.parts).toEqual([{ name: 'P', body: 'x' }]);
    });

    it('returns an empty song for empty or blank input', () => {
      const empty = { meta: { title: '' }, chart: [], parts: [] };
      expect(parseSong('')).toEqual(empty);
      expect(parseSong('\n\n  \r\n')).toEqual(empty);
    });
  });
});
