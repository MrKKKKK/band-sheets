import { describe, expect, it } from 'vitest';
import { clearStaleMetaLines, metaSummary, validateMeta } from './meta';
import { parseSong } from './parseSong';
import { serializeSong } from './serializeSong';
import type { Song } from './song';

const ok = { title: 'きらきら星', key: 'C', tempo: '100', time: '4/4' };

describe('validateMeta', () => {
  it('accepts valid input and converts tempo to a number', () => {
    expect(validateMeta(ok)).toEqual({
      ok: true,
      meta: { title: 'きらきら星', key: 'C', tempo: 100, time: '4/4' },
    });
  });

  it('trims every field', () => {
    expect(
      validateMeta({
        title: ' 曲 ',
        key: ' F#m ',
        tempo: ' 90 ',
        time: ' 6/8 ',
      }),
    ).toEqual({
      ok: true,
      meta: { title: '曲', key: 'F#m', tempo: 90, time: '6/8' },
    });
  });

  it('omits empty optional fields', () => {
    const r = validateMeta({ title: 'x', key: '', tempo: ' ', time: '' });
    expect(r).toEqual({ ok: true, meta: { title: 'x' } });
    if (r.ok) expect(Object.keys(r.meta)).toEqual(['title']);
  });

  it('requires a non-empty title', () => {
    expect(validateMeta({ ...ok, title: '  ' })).toEqual({
      ok: false,
      errors: { title: '曲名を入力してください' },
    });
  });

  it.each(['H', 'c', 'C#maj', 'Cb m', 'Am7'])('rejects key %j', (key) => {
    const r = validateMeta({ ...ok, key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['key']);
  });

  it.each(['Bb', 'Ebm', 'G'])('accepts key %j', (key) => {
    expect(validateMeta({ ...ok, key }).ok).toBe(true);
  });

  it.each(['0', '401', '-5', '100bpm', 'abc', '1e2'])(
    'rejects tempo %j',
    (tempo) => {
      const r = validateMeta({ ...ok, tempo });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['tempo']);
    },
  );

  it.each([
    ['1', 1],
    ['400', 400],
    ['060', 60],
    ['120.5', 120.5],
    ['1.25', 1.25],
  ])('accepts tempo %j', (tempo, n) => {
    const r = validateMeta({ ...ok, tempo });
    expect(r.ok && r.meta.tempo).toBe(n);
  });

  it.each(['0.5', '400.5', '.5', '1.'])(
    'rejects decimal tempo %j (out of range or malformed)',
    (tempo) => {
      const r = validateMeta({ ...ok, tempo });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['tempo']);
    },
  );

  it('accepts a tempo loaded from a file like 120.5 (R15), not just integers', () => {
    // Regression: a file with {tempo: 120.5} previously failed validateMeta
    // entirely, blocking the user from saving ANY other field in the form.
    const r = validateMeta({ ...ok, tempo: '120.5' });
    expect(r).toEqual({
      ok: true,
      meta: { title: 'きらきら星', key: 'C', tempo: 120.5, time: '4/4' },
    });
  });

  it.each(['4/3', '4/0', '0/4', '4', '4/4/4', '3 / 4', 'a/4', '4/64'])(
    'rejects time %j',
    (time) => {
      const r = validateMeta({ ...ok, time });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['time']);
    },
  );

  it.each(['3/4', '6/8', '2/2', '7/16', '5/1', '12/32'])(
    'accepts time %j',
    (time) => {
      expect(validateMeta({ ...ok, time }).ok).toBe(true);
    },
  );

  describe('original (unchanged fields skip validation) (N8)', () => {
    it('accepts an out-of-range tempo loaded from a file (0 or 500) when left unchanged', () => {
      for (const tempo of ['0', '500']) {
        const original = { ...ok, tempo };
        const r = validateMeta(original, original);
        expect(r).toEqual({
          ok: true,
          meta: {
            title: 'きらきら星',
            key: 'C',
            tempo: Number(tempo),
            time: '4/4',
          },
        });
      }
    });

    it('lets the user save OTHER fields while an out-of-range tempo stays untouched', () => {
      const original = { ...ok, tempo: '0' };
      const edited = { ...original, title: '別の曲' };
      const r = validateMeta(edited, original);
      expect(r).toEqual({
        ok: true,
        meta: { title: '別の曲', key: 'C', tempo: 0, time: '4/4' },
      });
    });

    it('still rejects tempo when the user changes it away from an out-of-range original', () => {
      const original = { ...ok, tempo: '0' };
      const edited = { ...original, tempo: '-5' };
      const r = validateMeta(edited, original);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['tempo']);
    });

    it('still applies the strict check when no original is given (out-of-range tempo)', () => {
      expect(validateMeta({ ...ok, tempo: '0' }).ok).toBe(false);
    });

    it('accepts an unchanged, otherwise-invalid key loaded from a file', () => {
      const original = { ...ok, key: 'Zz' };
      const r = validateMeta(original, original);
      expect(r.ok && r.meta.key).toBe('Zz');
    });

    it('still rejects key when the user changes it away from an invalid original', () => {
      const original = { ...ok, key: 'Zz' };
      const edited = { ...original, key: 'also bad' };
      const r = validateMeta(edited, original);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['key']);
    });

    it('accepts an unchanged, otherwise-invalid time loaded from a file', () => {
      const original = { ...ok, time: '4/3' };
      const r = validateMeta(original, original);
      expect(r.ok && r.meta.time).toBe('4/3');
    });

    it('still rejects time when the user changes it away from an invalid original', () => {
      const original = { ...ok, time: '4/3' };
      const edited = { ...original, time: '4/5' };
      const r = validateMeta(edited, original);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['time']);
    });
  });

  it('reports every invalid field at once', () => {
    const r = validateMeta({ title: '', key: 'X', tempo: '0', time: '4' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ['key', 'tempo', 'time', 'title'].sort(),
      );
      for (const msg of Object.values(r.errors)) expect(msg).toBeTruthy();
    }
  });
});

describe('metaSummary', () => {
  it('joins key, tempo and time', () => {
    expect(metaSummary({ title: 'x', key: 'C', tempo: 100, time: '4/4' })).toBe(
      'キー C · ♩=100 · 4/4',
    );
  });

  it('omits missing parts', () => {
    expect(metaSummary({ title: 'x', tempo: 90 })).toBe('♩=90');
  });

  it('falls back to a call to action', () => {
    expect(metaSummary({ title: 'x', palette: ['C'] })).toBe('曲情報を設定');
  });
});

describe('clearStaleMetaLines', () => {
  // m3-review.md F1/N5: this is the one place a stale duplicate scalar
  // meta directive gets dropped, and it must only run for fields the
  // caller (App's song-info handler) says were actually cleared.
  it('drops a top-level RawLine that would re-parse into a cleared field', () => {
    const song = parseSong('{key: C}\n[Am]a\n\n{key: D}');
    const cleared = clearStaleMetaLines(song, ['key']);
    expect(serializeSong(cleared)).not.toContain('{key: D}');
  });

  it('leaves a field alone when it was not in the given list', () => {
    const song = parseSong('{key: C}\n[Am]a\n\n{key: D}');
    expect(clearStaleMetaLines(song, ['tempo'])).toBe(song);
  });

  it('never drops a value that could not actually be promoted (e.g. {tempo: fast})', () => {
    const song: Song = {
      meta: { title: '' },
      chart: [{ kind: '', label: '', lines: [{ raw: '{tempo: fast}' }] }],
      parts: [],
    };
    expect(clearStaleMetaLines(song, ['tempo'])).toEqual(song);
  });

  it('does not touch a directive inside an explicit section', () => {
    const song = parseSong(
      '{start_of_verse: A}\n{key: D}\n[C]a\n{end_of_verse}',
    );
    expect(clearStaleMetaLines(song, ['key'])).toBe(song);
  });

  it('is a no-op for an empty fields list', () => {
    const song = parseSong('{key: C}\n\n{key: D}');
    expect(clearStaleMetaLines(song, [])).toBe(song);
  });
});
