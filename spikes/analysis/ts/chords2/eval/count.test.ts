/**
 * The count tool (spike 8 decision 5): counts only. Fixtures are made up here (synthetic only); nothing of the
 * hold-out is read by these tests. Dev scores (committed) are only checked to be countable, never printed.
 */
import { describe, expect, it } from 'vitest';
import { allC2Variants } from '../../../render/chords2/variants';
import { DEV, DEV_DIR, readScore, scoreOf } from '../recScores';
import { addFile, BASS_LETTERS, BASS_SCORES, countRun, countTable, emptyCounts, GROUPS, KINDS, recipeChords, scoreSegments, type CountReaders } from './count';

// A made-up score with a tempo, a key and a progression that must never come out.
const SCORE = `{title: Secret Song}
{key: G#m}
{tempo: 173}
{time: 4/4}
|[G#m7]----[C#7/F]----|[F#maj7]--------|[D#m7b5]----[G#m]----|[Bm6/G#]--------|
`;
const fixture = readScore(SCORE);
const reversed = { ...fixture, bars: [...fixture.bars].reverse().map((b) => [...b].reverse()) };
const fakeReaders = (calls: string[]): CountReaders => ({
  devScores: () => (calls.push('dev'), [fixture]),
  heldOutScores: () => (calls.push('heldOut'), [fixture, reversed]),
  synthetic: (split) => (calls.push(split), [[{ root: 0, quality: '7', bass: null }]]),
});

describe('counting', () => {
  it('counts segments per kind; a bass-only chord goes to its own row', () => {
    const c = addFile(emptyCounts(), scoreSegments(fixture));
    expect(c).toMatchObject({ files: 1, segments: 6, bassOnly: 1 });
    expect(c.byKind).toMatchObject({ min7: 1, '7': 1, maj7: 1, m7b5: 1, min: 1, m6: 0 }); // Bm6/G#: the 6th only in the bass
    expect(Object.values(c.byKind).reduce((a, b) => a + b, 0) + c.bassOnly).toBe(c.segments);
  });
  it('throws on a kind outside the vocabulary without naming the chord', () => {
    expect(() => addFile(emptyCounts(), [{ root: 0, quality: '13', bass: null }])).toThrow(/^a chord kind outside/);
    let msg = '';
    try {
      scoreSegments({ ...fixture, bars: [[{ text: 'G#m13', start: 0, length: 16 }]] });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('a score chord outside the chords2 vocabulary');
  });
  it('a synthetic file is counted from its recipe (tuning variant here; no file is read)', () => {
    const v = allC2Variants().find((x) => x.name === 'c2-t-b-clean-s1')!;
    const chords = recipeChords(v);
    expect(chords.length).toBeGreaterThan(10);
    expect(chords.every((c) => KINDS.includes(c.quality))).toBe(true);
  });
  it('the committed dev scores are countable (a-f, g-j)', () => {
    const c = [...BASS_LETTERS.map((l) => scoreOf(BASS_SCORES, l)), ...DEV.map((l) => scoreOf(DEV_DIR, l))].reduce((a, s) => addFile(a, scoreSegments(s)), emptyCounts());
    expect(c.files).toBe(10);
    expect(c.segments).toBeGreaterThan(0);
  });
});

describe('the output is counts only', () => {
  const calls: string[] = [];
  const text = countRun(() => calls.push('begin'), fakeReaders(calls));
  it('never contains the progression, chord names, key, tempo or title', () => {
    for (const leak of ['G#', 'C#', 'F#', 'D#', 'Bm', '/F', '173', 'Secret', 'm7b5]', 'maj7]']) expect(text).not.toContain(leak);
    expect(text).not.toMatch(/\b[A-G][#b]?(m|maj|7|\/)/);
  });
  it('every line is a header or a fixed label followed by integers', () => {
    const labels = new Set([...KINDS.map((k) => `\`${k}\``), ...Object.keys(GROUPS).map((g) => `**${g}**`), 'ベースにだけある音', '区間の合計', 'ファイル（録音は楽譜）']);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\| 種類 \| 録音 開発用 a〜j \| 録音 ホールドアウト k〜n（jp・cp で 1 組） \| 合成 調整用 \| 合成 開発用 \| 合成 ホールドアウト \|$/);
    expect(lines[1]).toBe('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const l of lines.slice(2)) {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      expect(labels.has(cells[0])).toBe(true);
      for (const c of cells.slice(1)) expect(c).toMatch(/^\d+$/);
    }
    expect(lines).toHaveLength(2 + KINDS.length + Object.keys(GROUPS).length + 3);
  });
  it('does not depend on the order of the chords (a progression cannot be read back)', () => {
    const a = countTable([['x', addFile(emptyCounts(), scoreSegments(fixture))]]);
    const b = countTable([['x', addFile(emptyCounts(), scoreSegments(reversed))]]);
    expect(a).toBe(b);
    expect(text).toContain('| **E1 7 度の仲間（7・min7・maj7・m7b5）** | 4 | 8 | 1 | 1 | 1 |');
  });
  it('logs the count line before reading anything; a refused count reads nothing', () => {
    expect(calls).toEqual(['begin', 'dev', 'heldOut', 'tuning', 'dev', 'heldOut']);
    const none: string[] = [];
    expect(() =>
      countRun(() => {
        throw new Error('the hold-out was already counted');
      }, fakeReaders(none)),
    ).toThrow(/already counted/);
    expect(none).toEqual([]);
  });
});
