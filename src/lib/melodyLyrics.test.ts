import { describe, expect, it } from 'vitest';
import type { MelodyEvent } from './melody';
import {
  autoAssign,
  deleteNote,
  deleteRange,
  extend,
  insertNote,
  joinSyllables,
  lyricMismatch,
  merge,
  noLyric,
  refill,
  replaceNote,
  split,
  syllableCounts,
  syllableStream,
} from './melodyLyrics';
import { splitSyllables } from './syllables';

const n = (pitch: string, lyric?: string): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks: 16,
  ...(lyric !== undefined && { lyric }),
});
const r = (): MelodyEvent => ({ kind: 'rest', ticks: 16 });

/** Lyric per event ('' = none), for compact assertions. */
const lyrics = (events: MelodyEvent[]) => events.map((e) => e.lyric ?? '');

/** ラ ラ ソ ソ ファ: 「る」 should span both ソ. */
const hikaru = () => [n('A4'), n('A4'), n('G4'), n('G4'), n('F4')];
const HIKARUO = splitSyllables('ひかるお');

describe('syllableCounts / syllableStream', () => {
  it('counts syllables per event, rests and lyric-less notes 0', () => {
    const ev = [n('C4', 'きら'), r(), n('D4'), n('E4', 'がっ'), n('F4', ' ')];
    expect(syllableCounts(ev)).toEqual([2, 0, 0, 1, 0]);
    expect(syllableStream(ev)).toEqual(['き', 'ら', 'がっ']);
  });

  it('ignores a lyric on a rest', () => {
    expect(syllableCounts([{ kind: 'rest', ticks: 16, lyric: 'x' }])).toEqual([
      0,
    ]);
  });
});

describe('joinSyllables', () => {
  it('joins kana without spaces and Latin words with one', () => {
    expect(joinSyllables(['き', 'ら'])).toBe('きら');
    expect(joinSyllables(['my', 'love'])).toBe('my love');
    expect(joinSyllables(['hel-', 'lo'])).toBe('hel-lo');
    expect(joinSyllables(['A', 'き'])).toBe('Aき');
  });

  it('round-trips through splitSyllables', () => {
    for (const s of [
      ['きゃ', 'ら'],
      ['がっ', 'こ', 'う'],
      ['my', 'love'],
      ['hel-', 'lo', 'world'],
    ]) {
      expect(splitSyllables(joinSyllables(s))).toEqual(s);
    }
  });
});

describe('autoAssign', () => {
  it('puts one syllable per note, skipping rests', () => {
    const out = autoAssign(
      [n('C4'), r(), n('D4'), n('E4')],
      ['き', 'ら', 'き'],
    );
    expect(lyrics(out)).toEqual(['き', '', 'ら', 'き']);
  });

  it('leaves extra notes without lyric and drops extra syllables', () => {
    expect(lyrics(autoAssign([n('C4'), n('D4')], ['き']))).toEqual(['き', '']);
    const out = autoAssign([n('C4')], ['き', 'ら']);
    expect(lyrics(out)).toEqual(['き']);
    expect(lyricMismatch(out, ['き', 'ら'])).toEqual({
      placed: 1,
      expected: 2,
      firstMismatchNote: null,
    });
  });

  it('replaces existing lyrics and strips lyrics from rests', () => {
    const out = autoAssign(
      [n('C4', 'x'), { kind: 'rest', ticks: 16, lyric: 'y' }, n('D4', 'z')],
      ['き'],
    );
    expect(out).toEqual([n('C4', 'き'), r(), n('D4')]);
  });

  it('does not mutate its input', () => {
    const ev = [n('C4', 'x')];
    autoAssign(ev, ['き']);
    expect(ev).toEqual([n('C4', 'x')]);
  });
});

describe('the m4-decisions example (ラ ラ ソ ソ ファ, 「る」 over two notes)', () => {
  it('auto-assign misplaces 「お」; のばす at 「る」 fixes it', () => {
    const auto = autoAssign(hikaru(), HIKARUO);
    expect(lyrics(auto)).toEqual(['ひ', 'か', 'る', 'お', '']);

    const fixed = extend(auto, 2, HIKARUO);
    expect(lyrics(fixed)).toEqual(['ひ', 'か', 'る', '', 'お']);
    expect(lyricMismatch(fixed, HIKARUO)).toEqual({
      placed: 4,
      expected: 4,
      firstMismatchNote: null,
    });
  });

  it('with one note too few, 「お」 falls off: shortage reported', () => {
    const ev = [n('A4'), n('A4'), n('G4'), n('G4')];
    const auto = autoAssign(ev, HIKARUO);
    expect(lyrics(auto)).toEqual(['ひ', 'か', 'る', 'お']);
    const extended = extend(auto, 2);
    expect(lyrics(extended)).toEqual(['ひ', 'か', 'る', '']);
    expect(lyricMismatch(extended, HIKARUO)).toEqual({
      placed: 3,
      expected: 4,
      firstMismatchNote: 3,
    });
  });
});

describe('extend (のばす)', () => {
  it('inserts an empty note after the index; the rest shifts right', () => {
    const ev = autoAssign(
      [n('C4'), n('D4'), n('E4'), n('F4')],
      ['a', 'b', 'c'],
    );
    expect(lyrics(extend(ev, 0))).toEqual(['a', '', 'b', 'c']);
  });

  it('skips rests when shifting (event indexes)', () => {
    const ev = autoAssign([n('C4'), r(), n('D4'), n('E4')], ['a', 'b']);
    expect(lyrics(extend(ev, 0))).toEqual(['a', '', '', 'b']);
  });

  it('drops the tail without a chart, refills it with one', () => {
    const chart = ['a', 'b', 'c', 'd'];
    const ev = autoAssign([n('C4'), n('D4'), n('E4')], chart);
    expect(lyrics(extend(ev, 0))).toEqual(['a', '', 'b']);
    // The tail note ('' after b) is not empty, so refill has nothing to fill.
    const ev2 = autoAssign([n('C4'), n('D4'), n('E4'), n('F4')], chart);
    expect(lyrics(extend(ev2, 0, chart))).toEqual(['a', '', 'b', 'c']);
  });

  it('on the last lyric note, refill does not undo the melisma', () => {
    const chart = ['a', 'b', 'c'];
    const ev = autoAssign([n('C4'), n('D4'), n('E4')], chart);
    expect(lyrics(extend(ev, 1, chart))).toEqual(['a', 'b', '']);
  });

  it('is a no-op on a rest, the last event or an invalid index', () => {
    const ev = autoAssign([n('C4'), r(), n('D4')], ['a', 'b']);
    expect(extend(ev, 1)).toBe(ev);
    expect(extend(ev, 2)).toBe(ev);
    expect(extend(ev, 9)).toBe(ev);
    expect(extend(ev, -1)).toBe(ev);
  });
});

describe('noLyric (歌詞なし)', () => {
  it('empties the note and moves its syllable(s) to the next note', () => {
    const ev = autoAssign(
      [n('C4'), n('D4'), n('E4'), n('F4')],
      ['a', 'b', 'c'],
    );
    expect(lyrics(noLyric(ev, 0))).toEqual(['', 'a', 'b', 'c']);
    expect(lyrics(noLyric(ev, 1))).toEqual(['a', '', 'b', 'c']);
  });

  it('moves a merged pair as a whole', () => {
    const ev = [n('C4', 'きら'), n('D4', 'き'), n('E4')];
    expect(lyrics(noLyric(ev, 0))).toEqual(['', 'きら', 'き']);
  });

  it('is a no-op on a rest or an already empty note', () => {
    const ev = [n('C4', 'a'), r(), n('D4')];
    expect(noLyric(ev, 1)).toBe(ev);
    expect(noLyric(ev, 2)).toBe(ev);
  });

  it('with a chart, refill does not put the syllable back on the same note', () => {
    const ev = autoAssign([n('C4'), n('D4')], ['a', 'b']);
    expect(lyrics(noLyric(ev, 1, ['a', 'b']))).toEqual(['a', '']);
  });
});

describe('merge (つめる) / split (分ける)', () => {
  it('merge takes the next syllable; the rest shifts left', () => {
    const ev = autoAssign(
      [n('C4'), n('D4'), n('E4'), n('F4')],
      ['き', 'ら', 'き', 'ら'],
    );
    expect(lyrics(merge(ev, 0))).toEqual(['きら', 'き', 'ら', '']);
  });

  it('merge then split round-trips (with a chart, the tail comes back)', () => {
    const chart = splitSyllables('きらきらひ');
    const ev = autoAssign([n('C4'), n('D4'), n('E4'), n('F4')], chart);
    const merged = merge(ev, 1, chart);
    expect(lyrics(merged)).toEqual(['き', 'らき', 'ら', 'ひ']);
    expect(split(merged, 1, chart)).toEqual(ev);
  });

  it('split gives the last syllable to the next note; the rest shifts right', () => {
    const ev = [n('C4', 'きゃっ'), n('D4', 'がっこ'), n('E4', 'う'), n('F4')];
    // 'きゃっ' is one syllable → split is a no-op.
    expect(split(ev, 0)).toBe(ev);
    expect(lyrics(split(ev, 1))).toEqual(['きゃっ', 'がっ', 'こ', 'う']);
  });

  it('split is a no-op unless the note has 2+ syllables', () => {
    const ev = [n('C4', 'a'), n('D4'), r()];
    expect(split(ev, 0)).toBe(ev);
    expect(split(ev, 1)).toBe(ev);
    expect(split(ev, 2)).toBe(ev);
  });

  it('merge on a rest, past the stream end, or with nothing left is a no-op', () => {
    const ev = [n('C4', 'a'), r(), n('D4')];
    expect(merge(ev, 1)).toBe(ev);
    expect(merge(ev, 0)).toBe(ev); // no syllable after 'a'
  });

  it('merge on an empty note takes the next syllable (undoes noLyric)', () => {
    const ev = autoAssign([n('C4'), n('D4'), n('E4')], ['a', 'b']);
    const emptied = noLyric(ev, 0);
    expect(lyrics(emptied)).toEqual(['', 'a', 'b']);
    expect(lyrics(merge(emptied, 0))).toEqual(['a', 'b', '']);
  });

  it('works with English words', () => {
    const chart = splitSyllables('hel-lo my love');
    expect(chart).toEqual(['hel-', 'lo', 'my', 'love']);
    const ev = autoAssign([n('C4'), n('D4'), n('E4'), n('F4')], chart);
    const merged = merge(merge(ev, 0), 1);
    expect(lyrics(merged)).toEqual(['hel-lo', 'my love', '', '']);
    expect(syllableStream(merged)).toEqual(chart);
    expect(lyricMismatch(merged, chart).firstMismatchNote).toBeNull();
  });
});

describe('insertNote / deleteNote', () => {
  it('an inserted note takes the next syllable; the rest shifts right', () => {
    const chart = ['a', 'b', 'c'];
    const ev = autoAssign([n('C4'), n('D4'), n('E4')], chart);
    const out = insertNote(ev, 1, n('G4', 'ignored'));
    expect(out.map((e) => e.pitch)).toEqual(['C4', 'G4', 'D4', 'E4']);
    expect(lyrics(out)).toEqual(['a', 'b', 'c', '']);
  });

  it('keeps melisma structure when shifting', () => {
    const ev = [n('C4', 'a'), n('D4'), n('E4', 'b'), n('F4')];
    expect(lyrics(insertNote(ev, 0, n('G4')))).toEqual(['a', 'b', '', '', '']);
  });

  it('inserting a rest shifts nothing and carries no lyric', () => {
    const ev = [n('C4', 'a'), n('D4', 'b')];
    const out = insertNote(ev, 1, { kind: 'rest', ticks: 16, lyric: 'x' });
    expect(out).toEqual([n('C4', 'a'), r(), n('D4', 'b')]);
  });

  it('inserting at the end appends', () => {
    const ev = [n('C4', 'a')];
    expect(insertNote(ev, 1, n('D4')).length).toBe(2);
  });

  it('deleting a note returns its syllables to the stream (shift left)', () => {
    const ev = [n('C4', 'あ'), n('D4', 'いう'), n('E4', 'え'), n('F4', 'お')];
    const out = deleteNote(ev, 0);
    expect(lyrics(out)).toEqual(['あい', 'う', 'え']);
    expect(syllableStream(out)).toEqual(['あ', 'い', 'う', 'え']);
  });

  it('deleting a note with a chart refills the tail', () => {
    const chart = ['a', 'b', 'c', 'd'];
    const ev = autoAssign([n('C4'), n('D4'), n('E4'), n('F4'), n('G4')], chart);
    expect(lyrics(deleteNote(ev, 1, chart))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deleting a rest shifts nothing; bad index is a no-op', () => {
    const ev = [n('C4', 'a'), r(), n('D4', 'b')];
    expect(deleteNote(ev, 1)).toEqual([n('C4', 'a'), n('D4', 'b')]);
    expect(deleteNote(ev, 3)).toBe(ev);
    expect(insertNote(ev, 9, n('E4'))).toBe(ev);
  });
});

describe('refill', () => {
  it('fills trailing empty notes from the rest of the chart', () => {
    const ev = [n('C4', 'a'), n('D4'), n('E4', 'b'), n('F4'), r(), n('G4')];
    expect(lyrics(refill(ev, ['a', 'b', 'c', 'd', 'e']))).toEqual([
      'a',
      '',
      'b',
      'c',
      '',
      'd',
    ]);
  });

  it('does nothing when the stream is not a prefix of the chart', () => {
    const ev = [n('C4', 'x'), n('D4')];
    expect(refill(ev, ['a', 'b'])).toBe(ev);
  });

  it('does nothing when the chart is used up or there is no empty tail', () => {
    const ev = [n('C4', 'a'), n('D4')];
    expect(refill(ev, ['a'])).toBe(ev);
    const ev2 = [n('C4', 'a'), n('D4', 'b')];
    expect(refill(ev2, ['a', 'b', 'c'])).toBe(ev2);
  });

  it('fills from the start when nothing is placed', () => {
    expect(lyrics(refill([n('C4'), n('D4')], ['a']))).toEqual(['a', '']);
  });
});

describe('lyricMismatch', () => {
  it('reports the first note whose syllable differs', () => {
    const ev = [n('C4', 'き'), r(), n('D4', 'らき'), n('E4', 'x')];
    expect(lyricMismatch(ev, splitSyllables('きらきら'))).toEqual({
      placed: 4,
      expected: 4,
      firstMismatchNote: 3,
    });
  });

  it('flags a merged note when one of its syllables differs', () => {
    const ev = [n('C4', 'きx')];
    expect(lyricMismatch(ev, ['き', 'ら']).firstMismatchNote).toBe(0);
  });

  it('shorter stream: the first note after the last lyric note', () => {
    const ev = [n('C4', 'き'), n('D4'), r(), n('E4', 'ら'), r(), n('F4')];
    expect(lyricMismatch(ev, ['き', 'ら', 'き'])).toEqual({
      placed: 2,
      expected: 3,
      firstMismatchNote: 5,
    });
  });

  it('longer stream: the note carrying the first extra syllable', () => {
    const ev = [n('C4', 'き'), n('D4', 'ら')];
    expect(lyricMismatch(ev, ['き'])).toEqual({
      placed: 2,
      expected: 1,
      firstMismatchNote: 1,
    });
  });

  it('exact match (trailing lyric-less notes allowed) → null', () => {
    const ev = [n('C4', 'き'), n('D4', 'ら'), n('E4')];
    expect(lyricMismatch(ev, ['き', 'ら']).firstMismatchNote).toBeNull();
    expect(lyricMismatch([], []).firstMismatchNote).toBeNull();
  });
});

describe('tuplet slots (M5)', () => {
  const t = (e: MelodyEvent, slot: number, count = 3): MelodyEvent => ({
    ...e,
    ticks: 8,
    tuplet: { n: count, slot },
  });
  const marks = (events: MelodyEvent[]) =>
    events.map((e) => (e.tuplet ? `${e.tuplet.slot}` : '-'));

  it('autoAssign flows over tuplet notes and keeps the marks', () => {
    const ev = [n('C4'), t(n('D4'), 0), t(r(), 1), t(n('E4'), 2), n('F4')];
    const out = autoAssign(ev, ['a', 'b', 'c', 'd']);
    expect(lyrics(out)).toEqual(['a', 'b', '', 'c', 'd']);
    expect(marks(out)).toEqual(['-', '0', '1', '2', '-']);
  });

  it('replaceNote: a rest slot turned into a note takes the next syllable', () => {
    const ev = [n('C4', 'a'), t(r(), 0), t(r(), 1), t(r(), 2), n('D4', 'b')];
    const out = replaceNote(ev, 1, t(n('E4'), 0));
    expect(lyrics(out)).toEqual(['a', 'b', '', '', '']);
    expect(out[1]).toEqual(t(n('E4', 'b'), 0));
  });

  it('replaceNote: a note slot turned into a rest drops its lyric (shift left)', () => {
    const ev = [t(n('C4', 'a'), 0), t(n('D4', 'b'), 1), t(n('E4', 'c'), 2)];
    const out = replaceNote(ev, 1, t(r(), 1));
    expect(lyrics(out)).toEqual(['a', '', 'b']);
    expect(marks(out)).toEqual(['0', '1', '2']);
    expect(out[1].kind).toBe('rest');
  });

  it('replaceNote with a chart refills the tail like delete + insert', () => {
    const chart = ['a', 'b', 'c', 'd'];
    const ev = autoAssign(
      [t(n('C4'), 0), t(n('D4'), 1), t(n('E4'), 2), n('F4')],
      chart,
    );
    const out = replaceNote(ev, 0, t(r(), 0), chart);
    expect(lyrics(out)).toEqual(['', 'a', 'b', 'c']);
  });

  it('replaceNote: note → note keeps the old lyric; nothing shifts', () => {
    const ev = [t(n('C4', 'a'), 0), t(n('D4', 'b'), 1), t(n('E4', 'c'), 2)];
    const out = replaceNote(ev, 1, t(n('G4', 'ignored'), 1));
    expect(out[1]).toEqual(t(n('G4', 'b'), 1));
    expect(lyrics(out)).toEqual(['a', 'b', 'c']);
  });

  it('replaceNote with a bad index is a no-op', () => {
    const ev = [n('C4', 'a')];
    expect(replaceNote(ev, 1, n('D4'))).toBe(ev);
    expect(replaceNote(ev, -1, n('D4'))).toBe(ev);
  });

  it('deleteRange removes a whole group; its syllables go back to the stream', () => {
    const ev = [
      n('C4', 'a'),
      t(n('D4', 'b'), 0),
      t(r(), 1),
      t(n('E4', 'c'), 2),
      n('F4', 'd'),
      n('G4'),
    ];
    const out = deleteRange(ev, 1, 4);
    expect(out.map((e) => e.pitch)).toEqual(['C4', 'F4', 'G4']);
    // Like deleteNote: syllables that no longer fit are dropped.
    expect(lyrics(out)).toEqual(['a', 'b', '']);
  });

  it('deleteRange of rests only shifts nothing; with a chart refills', () => {
    const ev = [n('C4', 'a'), t(r(), 0), t(r(), 1), t(r(), 2), n('D4', 'b')];
    expect(deleteRange(ev, 1, 4)).toEqual([n('C4', 'a'), n('D4', 'b')]);
    const chart = ['a', 'b', 'c'];
    const ev2 = autoAssign(
      [t(n('C4'), 0), t(n('D4'), 1), t(n('E4'), 2)],
      ['a', 'b', 'c'],
    );
    expect(lyrics(deleteRange([...ev2, n('F4')], 0, 3, chart))).toEqual(['a']);
  });

  it('deleteRange with an empty or bad range is a no-op', () => {
    const ev = [n('C4', 'a'), n('D4', 'b')];
    expect(deleteRange(ev, 1, 1)).toBe(ev);
    expect(deleteRange(ev, 1, 3)).toBe(ev);
    expect(deleteRange(ev, -1, 1)).toBe(ev);
    expect(deleteRange(ev, 2, 1)).toBe(ev);
  });
});
