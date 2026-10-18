import { describe, expect, it } from 'vitest';
import type { MelodyEvent } from './melody';
import {
  chartChords,
  chordSummary,
  clearChords,
  copyChordsFromChart,
  copyResultLines,
  removeChord,
  setChord,
  type ChartChords,
} from './melodyChords';
import { readSection } from './melodyPart';
import { parseSong } from './parseSong';
import { saintsSampleText } from './saintsSample';
import { chartSyllables } from './syllables';

const songWith = (lines: string, label = 'A') =>
  parseSong(
    `{title: t}\n{start_of_verse: ${label}}\n${lines}\n{end_of_verse}\n`,
  );

const n = (lyric?: string, chord?: string): MelodyEvent => ({
  kind: 'note',
  pitch: 'C4',
  ticks: 16,
  ...(lyric !== undefined && { lyric }),
  ...(chord !== undefined && { chord }),
});
const r = (chord?: string): MelodyEvent => ({
  kind: 'rest',
  ticks: 16,
  ...(chord !== undefined && { chord }),
});

describe('chartChords', () => {
  it('maps each chord to the syllable it is placed on', () => {
    const c = chartChords(
      songWith('Oh when the [C]saints go march-[G7]ing in'),
      'A',
    );
    expect(c.syllables).toEqual([
      'Oh',
      'when',
      'the',
      'saints',
      'go',
      'march-',
      'ing',
      'in',
    ]);
    expect(c.chords).toEqual([
      { chord: 'C', syllable: 3 },
      { chord: 'G7', syllable: 6 },
    ]);
  });

  it('gives the same syllables as chartSyllables (sample song)', () => {
    const song = parseSong(saintsSampleText);
    for (const label of ['A', 'B']) {
      expect(chartChords(song, label).syllables).toEqual(
        chartSyllables(song, label),
      );
    }
    expect(chartChords(song, 'A').chords).toHaveLength(8);
    expect(
      chartChords(song, 'A').chords.every((c) => c.syllable !== null),
    ).toBe(true);
  });

  it('a chord on whitespace goes to the next syllable of the same line', () => {
    const c = chartChords(songWith('the[C] saints'), 'A');
    expect(c.chords).toEqual([{ chord: 'C', syllable: 1 }]);
  });

  it('a chord at the end of a line, or on a chord-only line, has no syllable', () => {
    const c = chartChords(songWith('あい[G7]\n[Am] [D]\nうえ'), 'A');
    expect(c.syllables).toEqual(['あ', 'い', 'う', 'え']);
    expect(c.chords).toEqual([
      { chord: 'G7', syllable: null },
      { chord: 'Am', syllable: null },
      { chord: 'D', syllable: null },
    ]);
  });

  it('Japanese: one syllable per kana, small kana and leading symbols included', () => {
    const c = chartChords(songWith('[C]きゃら[G]きら\n[F]「ほし」'), 'A');
    // 「 at a line start attaches to the previous line (chartSyllables'
    // rule), but a chord on it still means this line's first syllable.
    expect(c.syllables).toEqual(['きゃ', 'ら', 'き', 'ら「', 'ほ', 'し」']);
    expect(c.chords.map((x) => x.syllable)).toEqual([0, 2, 4]);
  });

  it('a chord on a small kana belongs to its syllable', () => {
    const c = chartChords(songWith('き[D]ゃら'), 'A');
    expect(c.chords).toEqual([{ chord: 'D', syllable: 0 }]);
  });

  it('two chords on one syllable both point at it', () => {
    const c = chartChords(songWith('[C]sa[G]ints'), 'A');
    expect(c.chords).toEqual([
      { chord: 'C', syllable: 0 },
      { chord: 'G', syllable: 0 },
    ]);
  });

  it('no section with that label → nothing', () => {
    expect(chartChords(songWith('[C]あ'), 'B')).toEqual({
      syllables: [],
      chords: [],
    });
  });
});

const chart = (
  syllables: string[],
  chords: [string, number | null][],
): ChartChords => ({
  syllables,
  chords: chords.map(([chord, syllable]) => ({ chord, syllable })),
});

describe('copyChordsFromChart', () => {
  it('puts each chord on the note carrying its syllable (rests skipped)', () => {
    const ev = [r(), n('あ'), n('い'), r(), n('う')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い', 'う'],
        [
          ['C', 0],
          ['G7', 2],
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual([
      undefined,
      'C',
      undefined,
      undefined,
      'G7',
    ]);
    expect(out).toMatchObject({ copied: 2, skipped: 0, kept: 0 });
    // other fields kept, input untouched
    expect(out.events[1]).toEqual({ ...ev[1], chord: 'C' });
    expect(ev[1].chord).toBeUndefined();
  });

  it('a melisma takes the chord on its first note only', () => {
    const ev = [n('あ'), n(), n(), n('い')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い'],
        [
          ['C', 0],
          ['F', 1],
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual([
      'C',
      undefined,
      undefined,
      'F',
    ]);
  });

  it('counts chords with no syllable or no matching note as skipped', () => {
    const ev = [n('あ'), n('い')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い', 'う'],
        [
          ['C', 0],
          ['Am', null],
          ['G', 2], // 「う」 is not on any note
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual(['C', undefined]);
    expect(out).toMatchObject({ copied: 1, skipped: 2 });
  });

  it('aligns syllables even when the melody lyrics differ in places', () => {
    // An extra 「x」 inserted and 「い」 missing on the melody side.
    const ev = [n('あ'), n('x'), n('う'), n('え')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い', 'う', 'え'],
        [
          ['C', 0],
          ['D', 1],
          ['E', 2],
          ['F', 3],
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual(['C', undefined, 'E', 'F']);
    expect(out).toMatchObject({ copied: 3, skipped: 1 });
  });

  it('repeated syllables are matched in order', () => {
    const ev = [n('ら'), n('ら'), n('ら')];
    const out = copyChordsFromChart(
      ev,
      chart(['ら', 'ら', 'ら'], [['G', 2]]),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual([undefined, undefined, 'G']);
  });

  it('only one chord per note: the first wins, later ones are skipped', () => {
    // two chords on one syllable; two syllables merged onto one note
    const ev = [n('あ'), n('いう')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い', 'う'],
        [
          ['C', 0],
          ['C7', 0],
          ['F', 1],
          ['G', 2],
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual(['C', 'F']);
    expect(out).toMatchObject({ copied: 2, skipped: 2 });
  });

  it('overwrite: replaces every chord of the section, rests included', () => {
    const ev = [r('N.C.'), n('あ', 'Dm'), n('い', 'E')];
    const out = copyChordsFromChart(
      ev,
      chart(['あ', 'い'], [['C', 0]]),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual([undefined, 'C', undefined]);
    expect('chord' in out.events[0]).toBe(false);
    expect(out).toMatchObject({ copied: 1, skipped: 0, kept: 0 });
  });

  it('fillEmpty: keeps existing chords and fills only chordless notes', () => {
    const ev = [r('N.C.'), n('あ', 'Dm'), n('い')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い'],
        [
          ['C', 0],
          ['G', 1],
        ],
      ),
      'fillEmpty',
    );
    expect(out.events.map((e) => e.chord)).toEqual(['N.C.', 'Dm', 'G']);
    expect(out).toMatchObject({ copied: 1, skipped: 0, kept: 1 });
  });

  it('copies chord text as-is except characters alphaTex cannot hold', () => {
    const ev = [n('あ'), n('い')];
    const out = copyChordsFromChart(
      ev,
      chart(
        ['あ', 'い'],
        [
          ['C7(9,13)', 0],
          ['"Bm7(b5)"', 1],
        ],
      ),
      'overwrite',
    );
    expect(out.events.map((e) => e.chord)).toEqual(['C7(9,13)', 'Bm7(b5)']);
  });

  it('nothing changes → the same array', () => {
    const ev = [n('あ', 'C'), n('い')];
    const out = copyChordsFromChart(
      ev,
      chart(['あ', 'い'], [['C', 0]]),
      'overwrite',
    );
    expect(out.events).toBe(ev);
    expect(out.copied).toBe(1);
    const none = copyChordsFromChart(ev, chart([], []), 'fillEmpty');
    expect(none.events).toBe(ev);
  });

  it('sample song: every chord of section A lands on its note', () => {
    const song = parseSong(saintsSampleText);
    const read = readSection(song.parts[0].body, 'A', { num: 4, den: 4 });
    if (read.status !== 'ok') throw new Error(read.status);
    const out = copyChordsFromChart(
      read.events,
      chartChords(song, 'A'),
      'overwrite',
    );
    expect(out).toMatchObject({ copied: 8, skipped: 0, kept: 0 });
    const placed = out.events.flatMap((e) =>
      e.chord ? [`${e.lyric}:${e.chord}`] : [],
    );
    expect(placed).toEqual([
      'saints:C',
      'in:G7',
      'want:C',
      'be:C7',
      'num-:F',
      'saints:C',
      'ing:G7',
      'in:C',
    ]);
  });

  it('no lyrics on the melody → every chord skipped', () => {
    const ev = [n(), n()];
    const out = copyChordsFromChart(ev, chart(['あ'], [['C', 0]]), 'overwrite');
    expect(out).toMatchObject({ copied: 0, skipped: 1 });
    expect(out.events).toBe(ev);
  });
});

describe('setChord / removeChord / clearChords', () => {
  const ev = [n('あ', 'C'), r(), n('い')];

  it('setChord sets (trimmed) on a note or a rest', () => {
    expect(setChord(ev, 2, ' G7 ')[2]).toEqual({ ...ev[2], chord: 'G7' });
    expect(setChord(ev, 1, 'N.C.')[1].chord).toBe('N.C.');
    expect(setChord(ev, 0, 'Am')[0].chord).toBe('Am');
  });

  it('setChord: invalid text, a bad index or the same chord → the same array', () => {
    expect(setChord(ev, 2, '')).toBe(ev);
    expect(setChord(ev, 2, 'C G')).toBe(ev);
    expect(setChord(ev, 2, '[C]')).toBe(ev);
    expect(setChord(ev, 2, '"')).toBe(ev);
    expect(setChord(ev, 3, 'C')).toBe(ev);
    expect(setChord(ev, -1, 'C')).toBe(ev);
    expect(setChord(ev, 0, 'C')).toBe(ev);
  });

  it('removeChord drops the field; none there → the same array', () => {
    const out = removeChord(ev, 0);
    expect('chord' in out[0]).toBe(false);
    expect(out[0]).toEqual(n('あ'));
    expect(removeChord(ev, 2)).toBe(ev);
    expect(removeChord(ev, 9)).toBe(ev);
  });

  it('clearChords removes every chord; none → the same array', () => {
    const out = clearChords([r('N.C.'), ...ev]);
    expect(out.some((e) => 'chord' in e)).toBe(false);
    const plain = [n('あ'), r()];
    expect(clearChords(plain)).toBe(plain);
  });
});

describe('chordSummary', () => {
  it('counts chords in order of first appearance, and notes with a chord', () => {
    const s = chordSummary([
      r('N.C.'),
      n('あ', 'C'),
      n('い', 'G7'),
      n('う', 'C'),
      n('え'),
      n('お', 'C'),
    ]);
    expect(s.chords).toEqual([
      { chord: 'N.C.', count: 1 },
      { chord: 'C', count: 3 },
      { chord: 'G7', count: 1 },
    ]);
    expect(s.notesWithChord).toBe(4);
    expect(s.noteCount).toBe(5);
    expect(s.total).toBe(5);
  });

  it('empty', () => {
    expect(chordSummary([])).toEqual({
      chords: [],
      notesWithChord: 0,
      noteCount: 0,
      total: 0,
    });
  });
});

describe('copyResultLines', () => {
  it('copied, kept and skipped lines', () => {
    expect(copyResultLines({ copied: 6, skipped: 0, kept: 0 })).toEqual([
      'コードを 6 個、音符に写しました',
    ]);
    expect(copyResultLines({ copied: 2, skipped: 1, kept: 3 })).toEqual([
      'コードを 2 個、音符に写しました',
      'コードが付いていた音符 3 個はそのままにしました',
      'コード譜の 1 個は、合う音符が無く写せませんでした',
    ]);
    expect(copyResultLines({ copied: 0, skipped: 2, kept: 0 })).toEqual([
      '写せるコードがありませんでした',
      'コード譜の 2 個は、合う音符が無く写せませんでした',
    ]);
  });
});

describe('dash lines', () => {
  const song = songWith(
    '|[C]--------|[C]----[F]----|\n[C]きら[G]きら\n| [C][G] |',
  );
  it('contribute no syllables and their chords map to no syllable', () => {
    const cc = chartChords(song, 'A');
    expect(cc.syllables).toEqual(['き', 'ら', 'き', 'ら']);
    expect(cc.syllables).toEqual(chartSyllables(song, 'A'));
    expect(cc.chords.map((c) => [c.chord, c.syllable])).toEqual([
      ['C', null],
      ['C', null],
      ['F', null],
      ['C', 0],
      ['G', 2],
      ['C', null],
      ['G', null],
    ]);
  });
  it('are not copied onto the melody', () => {
    const events = [n('き'), n('ら'), n('き'), n('ら')];
    const res = copyChordsFromChart(
      events,
      chartChords(song, 'A'),
      'overwrite',
    );
    expect(res.events.map((e) => ('chord' in e ? e.chord : undefined))).toEqual(
      ['C', undefined, 'G', undefined],
    );
  });
});
