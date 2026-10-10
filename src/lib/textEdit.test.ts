import { describe, expect, it } from 'vitest';
import { insertAt, insertSection } from './textEdit';

describe('insertAt', () => {
  it('inserts at the caret and places the caret after the text', () => {
    // Collapsed selection: a pure insertion, so `insertedAt` is set too.
    expect(insertAt('abcd', 2, 2, '[C]')).toEqual({
      text: 'ab[C]cd',
      caret: 5,
      insertedAt: 2,
    });
  });

  it('replaces the selection (in either direction)', () => {
    // A real selection is deleted in the default mode: not a pure
    // insertion, so `insertedAt` is left unset.
    expect(insertAt('abcd', 1, 3, 'X')).toEqual({ text: 'aXd', caret: 2 });
    expect(insertAt('abcd', 3, 1, 'X')).toEqual({ text: 'aXd', caret: 2 });
  });

  it('clamps out-of-range positions', () => {
    // Both ends clamp to the same spot, so this is a pure insertion too.
    expect(insertAt('ab', 5, 9, 'X')).toEqual({
      text: 'abX',
      caret: 3,
      insertedAt: 2,
    });
  });

  it("mode: 'insert' keeps the selection instead of deleting it (R10)", () => {
    // Collapsed selection: same as the default, just inserts at the caret.
    expect(insertAt('abcd', 2, 2, '[C]', { mode: 'insert' })).toEqual({
      text: 'ab[C]cd',
      caret: 5,
      insertedAt: 2,
    });
    // Real selection: `s` lands before it, selection text is preserved
    // verbatim (either selection direction), caret right after `s` — and
    // it's still a pure insertion, so `insertedAt` is set.
    expect(insertAt('abcd', 1, 3, '[C]', { mode: 'insert' })).toEqual({
      text: 'a[C]bcd',
      caret: 4,
      insertedAt: 1,
    });
    expect(insertAt('abcd', 3, 1, '[C]', { mode: 'insert' })).toEqual({
      text: 'a[C]bcd',
      caret: 4,
      insertedAt: 1,
    });
  });
});

describe('insertSection', () => {
  const block = (label: string) =>
    `{start_of_verse: ${label}}\n\n{end_of_verse}\n`;

  it('inserts at the caret when it is at a line start', () => {
    const text = 'a\nb\n';
    const r = insertSection(text, 2, 'B');
    expect(r.text).toBe(`a\n${block('B')}b\n`);
    expect(r.caret).toBe(2 + '{start_of_verse: B}\n'.length);
  });

  it('inserts after the current line when the caret is mid-line', () => {
    const r = insertSection('abc\ndef', 1, 'A');
    expect(r.text).toBe(`abc\n${block('A')}def`);
    expect(r.text.slice(r.caret, r.caret + 1)).toBe('\n');
    expect(r.text.slice(0, r.caret).endsWith('{start_of_verse: A}\n')).toBe(
      true,
    );
  });

  it('adds a newline first when the last line is unterminated', () => {
    const r = insertSection('abc', 3, 'A');
    expect(r.text).toBe(`abc\n${block('A')}`);
    expect(r.caret).toBe('abc\n{start_of_verse: A}\n'.length);
  });

  it('works on empty text and with an empty label', () => {
    expect(insertSection('', 0, 'A')).toEqual({
      text: block('A'),
      caret: '{start_of_verse: A}\n'.length,
      insertedAt: 0,
    });
    expect(insertSection('', 0, '').text).toBe(
      '{start_of_verse}\n\n{end_of_verse}\n',
    );
  });

  it('keeps the rest of the text verbatim (CRLF included)', () => {
    const text = 'x  [C]y\r\nz\r\n';
    const r = insertSection(text, 0, 'A');
    expect(r.text).toBe(block('A') + text);
    const r2 = insertSection(text, 3, 'A');
    expect(r2.text).toBe(`x  [C]y\r\n${block('A')}z\r\n`);
  });

  // R5: a caret inside an existing section/part block must not split it —
  // the new block lands right after the enclosing block's end directive.

  it('inserts after the block when the caret is inside an open verse', () => {
    const text = '{start_of_verse}\nLyrics\n{end_of_verse}\nmore\n';
    const caret = text.indexOf('Lyrics') + 3;
    const end = '{end_of_verse}\n';
    const afterEnd = text.indexOf(end) + end.length;
    const r = insertSection(text, caret, 'B');
    expect(r.text).toBe(text.slice(0, afterEnd) + block('B') + 'more\n');
    expect(r.caret).toBe(afterEnd + '{start_of_verse: B}\n'.length);
  });

  it('inserts after the block when inside a {soc}/{eoc} short-form chorus', () => {
    const text = '{soc}\nLa la\n{eoc}\nnext\n';
    const caret = text.indexOf('La la') + 2;
    const end = '{eoc}\n';
    const afterEnd = text.indexOf(end) + end.length;
    const r = insertSection(text, caret, 'C');
    expect(r.text).toBe(text.slice(0, afterEnd) + block('C') + 'next\n');
  });

  it('inserts after the block when the caret is inside a part block', () => {
    const text = '{start_of_part: Vocal}\nNotes\n{end_of_part}\ntail\n';
    const caret = text.indexOf('Notes') + 2;
    const end = '{end_of_part}\n';
    const afterEnd = text.indexOf(end) + end.length;
    const r = insertSection(text, caret, 'D');
    expect(r.text).toBe(text.slice(0, afterEnd) + block('D') + 'tail\n');
  });

  it('still inserts after the block when the caret is at the very start of the document (N3)', () => {
    // Caret 0 is on the block's own start-directive line (its first
    // character) — this used to be (wrongly) treated as "outside", so the
    // new block landed BEFORE the existing one instead of after it.
    const text = '{start_of_verse}\nLyrics\n{end_of_verse}\n';
    const r = insertSection(text, 0, 'E');
    expect(r.text).toBe(text + block('E'));
  });

  it('uses the normal line-start behavior when the caret is genuinely outside any block', () => {
    // A blank line before the block: caret 0 is on THAT line, not on the
    // block's start-directive line, so the block does not enclose it.
    const text = '\n{start_of_verse}\nLyrics\n{end_of_verse}\n';
    const r = insertSection(text, 0, 'E');
    expect(r.text).toBe(block('E') + text);
  });

  // N3: a caret anywhere on a block's own start-directive line — beginning,
  // middle, or end of that line — must be treated the same as being inside
  // the block (insert after its end directive), not as "outside" (which
  // used to insert the new block right after the start line, leaving the
  // original block's label-only body empty and its end directive dangling
  // past the newly-inserted block).
  describe('caret on the block start line itself (N3)', () => {
    const text = '{start_of_verse: A}\nla\n{end_of_verse}';
    // 0 = first character of the start line; 5 = middle of it;
    // 19 = right after the closing '}' (end of the start line's content).
    it.each([0, 5, 19])(
      'inserts after the end directive (caret %i)',
      (caret) => {
        const r = insertSection(text, caret, 'B');
        expect(r.text).toBe(`${text}\n${block('B')}`);
      },
    );

    it('also applies to the {sov}/{eov} short forms', () => {
      const shortText = '{sov: A}\nla\n{eov}';
      const r = insertSection(shortText, 4, 'B'); // middle of "{sov: A}"
      expect(r.text).toBe(`${shortText}\n${block('B')}`);
    });

    it('also applies to a {start_of_part}/{end_of_part} block', () => {
      const partText = '{start_of_part: P}\nNotes\n{end_of_part}';
      const r = insertSection(partText, 10, 'B'); // middle of the start line
      expect(r.text).toBe(`${partText}\n${block('B')}`);
    });
  });

  it("adds a newline first when the block's end line has no trailing newline", () => {
    const text = '{start_of_verse}\nLyrics\n{end_of_verse}';
    const caret = text.indexOf('Lyrics') + 2;
    const r = insertSection(text, caret, 'F');
    expect(r.text).toBe(`${text}\n${block('F')}`);
    expect(r.caret).toBe(`${text}\n{start_of_verse: F}\n`.length);
  });
});
