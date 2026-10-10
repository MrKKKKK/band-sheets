import { describe, expect, it } from 'vitest';
import {
  entryFromFile,
  filterSongs,
  formatModified,
  mergeIndex,
  songStatus,
  songSummary,
  sortSongs,
} from './songIndex';
import { parseSong } from './parseSong';
import type {
  BaseRecord,
  DraftRecord,
  DriveFileMeta,
  SongEntry,
  SongIndex,
} from './syncTypes';

const file = (
  id: string,
  over: Partial<DriveFileMeta> = {},
): DriveFileMeta => ({
  id,
  name: `曲${id}.bandsheet`,
  version: '5',
  modifiedTime: '2026-10-05T10:00:00Z',
  ...over,
});
const entry = (songId: string, over: Partial<SongEntry> = {}): SongEntry => ({
  songId,
  title: songId,
  summary: '',
  parts: '',
  ...over,
});
const baseOf = (text: string, over: Partial<BaseRecord> = {}): BaseRecord => ({
  fileId: 'f1',
  version: '5',
  modifiedTime: '2026-10-05T10:00:00Z',
  text,
  ...over,
});
const draftOf = (text: string, baseVersion: string | null): DraftRecord => ({
  v: 1,
  text,
  baseVersion,
  savedAt: '2026-10-06T00:00:00Z',
});
const empty: SongIndex = { v: 1, songs: [] };
const now = new Date(2026, 9, 6, 15, 0);

describe('songSummary', () => {
  it('summarizes meta and parts', () => {
    const song = parseSong(
      '{title: 春}\n{key: C}\n{tempo: 100}\n{time: 4/4}\n[C]あ\n',
    );
    expect(songSummary(song)).toEqual({
      title: '春',
      summary: 'C ・ ♩=100 ・ 4/4',
      parts: 'コード譜',
    });
  });
  it('lists melody and drum parts, omits missing meta', () => {
    const text = [
      '{title: T}',
      '{start_of_part: Vocal}',
      '\\staff {score} c4.4',
      '{end_of_part}',
      '{start_of_part: Drums}',
      '\\instrument percussion',
      '{end_of_part}',
    ].join('\n');
    const s = songSummary(parseSong(text));
    expect(s.summary).toBe('');
    expect(s.parts).toBe('メロディ・ドラム');
  });
  it('uses 無題の曲 when there is no title; lyrics without chords are not コード譜', () => {
    expect(songSummary(parseSong('あいう\n'))).toEqual({
      title: '無題の曲',
      summary: '',
      parts: '',
    });
  });
});

describe('entryFromFile', () => {
  it('uses appProperties.songId, device, and the file name as title', () => {
    const e = entryFromFile(
      file('f1', { appProperties: { songId: 'abc', device: 'iPad' } }),
      null,
    );
    expect(e).toEqual({
      songId: 'abc',
      fileId: 'f1',
      title: '曲f1',
      summary: '',
      parts: '',
      modifiedTime: '2026-10-05T10:00:00Z',
      version: '5',
      device: 'iPad',
    });
  });
  it('falls back to drive-<fileId> without a songId (or a blank one)', () => {
    expect(entryFromFile(file('f1'), null).songId).toBe('drive-f1');
    expect(
      entryFromFile(file('f2', { appProperties: { songId: ' ' } }), null)
        .songId,
    ).toBe('drive-f2');
  });
  it('strips only a trailing .bandsheet; empty name becomes 無題の曲', () => {
    expect(
      entryFromFile(file('f1', { name: 'a.bandsheet.txt' }), null).title,
    ).toBe('a.bandsheet.txt');
    expect(entryFromFile(file('f1', { name: '.bandsheet' }), null).title).toBe(
      '無題の曲',
    );
  });
  it('fills title/summary/parts from a matching base of the same version', () => {
    const base = baseOf('{title: 本当の曲名}\n{key: G}\n[G]あ\n');
    const e = entryFromFile(file('f1'), base);
    expect(e.title).toBe('本当の曲名');
    expect(e.summary).toBe('G');
    expect(e.parts).toBe('コード譜');
  });
  it('keeps the file-name title when Drive moved past base, but still fills summary', () => {
    const base = baseOf('{title: 旧}\n{key: G}\n', { version: '4' });
    const e = entryFromFile(file('f1'), base);
    expect(e.title).toBe('曲f1');
    expect(e.summary).toBe('G');
  });
  it('ignores a base of another file', () => {
    const e = entryFromFile(file('f9'), baseOf('{title: x}\n{key: G}\n'));
    expect(e.title).toBe('曲f9');
    expect(e.summary).toBe('');
  });
});

describe('mergeIndex', () => {
  it('builds entries, folderId and listedAt', () => {
    const r = mergeIndex(empty, [file('f1')], [], 'fold', now);
    expect(r.v).toBe(1);
    expect(r.folderId).toBe('fold');
    expect(r.listedAt).toBe(now.toISOString());
    expect(r.songs.map((s) => s.songId)).toEqual(['drive-f1']);
  });
  it('files sharing a songId: smallest file id keeps it, the rest get drive-<fileId>', () => {
    const ap = { songId: 'same' };
    const r = mergeIndex(
      empty,
      [file('f2', { appProperties: ap }), file('f1', { appProperties: ap })],
      [],
      'fold',
      now,
    );
    expect(r.songs.map((s) => s.songId)).toEqual(['drive-f2', 'same']);
  });
  it('R12: the cached owner keeps the songId; ids stay stable after saving the other file', () => {
    const ap = { songId: 'same' };
    const cached: SongIndex = {
      v: 1,
      songs: [
        entry('same', { fileId: 'f2' }),
        entry('drive-f1', { fileId: 'f1' }),
      ],
    };
    const files = [
      file('f1', { appProperties: ap }),
      file('f2', { appProperties: ap }),
    ];
    const r1 = mergeIndex(cached, files, [], 'fold', now);
    expect(r1.songs.map((s) => s.songId)).toEqual(['drive-f1', 'same']);
    // saving f1 writes appProperties.songId = 'drive-f1': no duplicate left
    const saved = [
      file('f1', { appProperties: { songId: 'drive-f1' } }),
      file('f2', { appProperties: ap }),
    ];
    const r2 = mergeIndex(r1, saved, [], 'fold', now);
    expect(r2.songs.map((s) => s.songId)).toEqual(['drive-f1', 'same']);
    // saving the owner (f2) writes 'same' again: still the same ids
    const r3 = mergeIndex(r1, files, [], 'fold', now);
    expect(r3.songs.map((s) => s.songId)).toEqual(['drive-f1', 'same']);
  });
  it('keeps unique songIds', () => {
    const r = mergeIndex(
      empty,
      [
        file('f1', { appProperties: { songId: 'a' } }),
        file('f2', { appProperties: { songId: 'b' } }),
      ],
      [],
      'fold',
      now,
    );
    expect(r.songs.map((s) => s.songId)).toEqual(['a', 'b']);
  });
  it('carries summary/parts (and title when version is unchanged) from the cache', () => {
    const cached: SongIndex = {
      v: 1,
      songs: [
        entry('drive-f1', {
          fileId: 'f1',
          title: '読んだ曲名',
          summary: 'G',
          parts: 'コード譜',
          version: '5',
        }),
        entry('drive-f2', {
          fileId: 'f2',
          title: '旧',
          summary: 'D',
          parts: 'ドラム',
          version: '1',
        }),
      ],
    };
    const r = mergeIndex(cached, [file('f1'), file('f2')], [], 'fold', now);
    expect(r.songs[0]).toMatchObject({ title: '読んだ曲名', summary: 'G' });
    expect(r.songs[1]).toMatchObject({
      title: '曲f2',
      summary: 'D',
      parts: 'ドラム',
    });
  });
  it('drops cached Drive songs whose file vanished', () => {
    const cached: SongIndex = {
      v: 1,
      songs: [
        entry('gone', { fileId: 'fx' }),
        entry('drive-f1', { fileId: 'f1' }),
      ],
    };
    const r = mergeIndex(cached, [file('f1')], [], 'fold', now);
    expect(r.songs.map((s) => s.songId)).toEqual(['drive-f1']);
  });
  it('keeps a vanished song as local-only when a draft remains (it is in localOnly)', () => {
    const cached: SongIndex = {
      v: 1,
      songs: [entry('gone', { fileId: 'fx', version: '3' })],
    };
    const r = mergeIndex(
      cached,
      [],
      [entry('gone', { fileId: 'fx', version: '3', title: 'もと' })],
      'fold',
      now,
    );
    expect(r.songs).toEqual([entry('gone', { title: 'もと' })]);
  });
  it('appends local-only songs, dropping ones now on Drive', () => {
    const r = mergeIndex(
      empty,
      [file('f1', { appProperties: { songId: 'a' } })],
      [entry('a'), entry('loc', { modifiedTime: '2026-10-06T00:00:00Z' })],
      'fold',
      now,
    );
    expect(r.songs.map((s) => [s.songId, s.fileId])).toEqual([
      ['a', 'f1'],
      ['loc', undefined],
    ]);
  });
  it('does not keep cached local-only songs absent from localOnly', () => {
    const r = mergeIndex({ v: 1, songs: [entry('old')] }, [], [], 'fold', now);
    expect(r.songs).toEqual([]);
  });
});

describe('songStatus', () => {
  const e = entry('a', { fileId: 'f1', version: '5' });
  const base = baseOf('A');
  it('localOnly without a fileId', () => {
    expect(songStatus(entry('x'), null, null)).toBe('localOnly');
    expect(songStatus(entry('x'), draftOf('A', null), null)).toBe('localOnly');
  });
  it('synced without a draft or with a draft equal to base', () => {
    expect(songStatus(e, null, base)).toBe('synced');
    expect(songStatus(e, draftOf('A', '5'), base)).toBe('synced');
  });
  it('dirty when the draft differs and Drive is still at its base version', () => {
    expect(songStatus(e, draftOf('B', '5'), base)).toBe('dirty');
  });
  it('driveNewer when Drive moved past the draft base version', () => {
    expect(songStatus(e, draftOf('B', '4'), base)).toBe('driveNewer');
  });
  it('a draft without base is dirty (or driveNewer by version)', () => {
    expect(songStatus(e, draftOf('B', '5'), null)).toBe('dirty');
    expect(songStatus(e, draftOf('B', '3'), null)).toBe('driveNewer');
    expect(songStatus(e, draftOf('B', null), null)).toBe('dirty');
  });
  it('an unchanged draft stays synced even if Drive moved on', () => {
    expect(songStatus(e, draftOf('A', '4'), base)).toBe('synced');
  });
});

describe('sortSongs', () => {
  const a = entry('a', { title: 'B曲', modifiedTime: '2026-10-01T00:00:00Z' });
  const b = entry('b', { title: 'A曲', modifiedTime: '2026-10-03T00:00:00Z' });
  const c = entry('c', { title: 'C曲' });
  it('modified: newest first, missing times last, ties by title', () => {
    const d = entry('d', {
      title: 'A曲',
      modifiedTime: '2026-10-01T00:00:00Z',
    });
    expect(sortSongs([c, a, b, d], 'modified').map((s) => s.songId)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
  it('compares instants, not strings (time zone offsets)', () => {
    const x = entry('x', { modifiedTime: '2026-10-01T10:00:00+09:00' });
    const y = entry('y', { modifiedTime: '2026-10-01T02:00:00Z' });
    expect(sortSongs([x, y], 'modified').map((s) => s.songId)).toEqual([
      'y',
      'x',
    ]);
  });
  it('title: Japanese order, kana types together, ties newest first', () => {
    const list = ['う', 'ア', 'い', 'Zebra', 'apple', 'お'].map((t) =>
      entry(t, { title: t }),
    );
    const r = sortSongs(list, 'title').map((s) => s.title);
    expect(r.indexOf('apple')).toBeLessThan(r.indexOf('Zebra'));
    expect(r.filter((t) => 'ア い う お'.includes(t))).toEqual([
      'ア',
      'い',
      'う',
      'お',
    ]);
    const t1 = entry('t1', {
      title: 'ひ',
      modifiedTime: '2026-10-01T00:00:00Z',
    });
    const t2 = entry('t2', {
      title: 'ヒ',
      modifiedTime: '2026-10-02T00:00:00Z',
    });
    expect(sortSongs([t1, t2], 'title').map((s) => s.songId)).toEqual([
      't2',
      't1',
    ]);
  });
  it('does not mutate the input', () => {
    const input = [a, b];
    sortSongs(input, 'title');
    expect(input).toEqual([a, b]);
  });
});

describe('filterSongs', () => {
  const list = [
    entry('1', { title: 'Sunrise ＡＢＣ' }),
    entry('2', { title: 'ひかり' }),
    entry('3', { title: 'ヒカリの道' }),
    entry('4', { title: '夜明け' }),
  ];
  const ids = (q: string) => filterSongs(list, q).map((s) => s.songId);
  it('empty / blank query returns all', () => {
    expect(ids('')).toEqual(['1', '2', '3', '4']);
    expect(ids('  ')).toEqual(['1', '2', '3', '4']);
  });
  it('ignores case and full/half width', () => {
    expect(ids('sunrise abc')).toEqual(['1']);
    expect(ids('ＳＵＮ')).toEqual(['1']);
    expect(ids('abc')).toEqual(['1']);
  });
  it('ignores hiragana/katakana', () => {
    expect(ids('ひかり')).toEqual(['2', '3']);
    expect(ids('ヒカリ')).toEqual(['2', '3']);
  });
  it('all whitespace-separated terms must match', () => {
    expect(ids('ひかり 道')).toEqual(['3']);
    expect(ids('夜明け 道')).toEqual([]);
  });
});

describe('formatModified', () => {
  it('today / yesterday / this year / other years', () => {
    const at = (y: number, m: number, d: number, h = 0, mi = 0) =>
      new Date(y, m - 1, d, h, mi).toISOString();
    expect(formatModified(at(2026, 10, 6, 14, 32), now)).toBe('今日 14:32');
    expect(formatModified(at(2026, 10, 5, 21, 5), now)).toBe('昨日 21:05');
    expect(formatModified(at(2026, 10, 3, 18, 20), now)).toBe('10/3 18:20');
    expect(formatModified(at(2025, 12, 1, 9, 0), now)).toBe('2025/12/1');
  });
  it('is by calendar day, not 24 hours', () => {
    const lateNow = new Date(2026, 9, 6, 0, 10);
    expect(
      formatModified(new Date(2026, 9, 5, 23, 50).toISOString(), lateNow),
    ).toBe('昨日 23:50');
  });
  it('crosses year boundary (昨日 on Jan 1) and handles bad input', () => {
    const jan1 = new Date(2026, 0, 1, 9, 0);
    expect(
      formatModified(new Date(2025, 11, 31, 22, 0).toISOString(), jan1),
    ).toBe('昨日 22:00');
    expect(formatModified('nope', now)).toBe('');
  });
});
