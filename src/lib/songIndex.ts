import { melodyParts } from './melodyPart';
import { parseSong } from './parseSong';
import { isDrumPart, isRawLine, type Song } from './song';
import type {
  BaseRecord,
  DraftRecord,
  DriveFileMeta,
  SongEntry,
  SongIndex,
  SongStatus,
  SortOrder,
} from './syncTypes';

const FILE_EXT = '.bandsheet';
const UNTITLED = '無題の曲';

/** Title / "C ・ ♩=100 ・ 4/4" / "コード譜・メロディ・ドラム" of a parsed song. */
export function songSummary(song: Song): {
  title: string;
  summary: string;
  parts: string;
} {
  const { key, tempo, time } = song.meta;
  const summary: string[] = [];
  if (key) summary.push(key);
  if (tempo !== undefined) summary.push(`♩=${tempo}`);
  if (time) summary.push(time);

  const parts: string[] = [];
  const hasChords = song.chart.some((s) =>
    s.lines.some(
      (l) => !isRawLine(l) && l.segments.some((seg) => seg.chord !== undefined),
    ),
  );
  if (hasChords) parts.push('コード譜');
  if (melodyParts(song).length > 0) parts.push('メロディ');
  if (song.parts.some(isDrumPart)) parts.push('ドラム');

  return {
    title: song.meta.title.trim() || UNTITLED,
    summary: summary.join(' ・ '),
    parts: parts.join('・'),
  };
}

function titleFromFileName(name: string): string {
  const stem = name.toLowerCase().endsWith(FILE_EXT)
    ? name.slice(0, -FILE_EXT.length)
    : name;
  return stem.trim() || UNTITLED;
}

/**
 * One Drive file → index entry. songId = appProperties.songId, else
 * `drive-<fileId>`. (Two files sharing a songId are resolved in
 * `mergeIndex`, which knows about all files.) Title / summary / parts come
 * from `base` when it belongs to this file; the title always follows the
 * file name when Drive's version has moved past `base` (file name tracks
 * the title).
 */
export function entryFromFile(
  f: DriveFileMeta,
  base: BaseRecord | null,
): SongEntry {
  const songId = f.appProperties?.songId?.trim() || `drive-${f.id}`;
  const entry: SongEntry = {
    songId,
    fileId: f.id,
    title: titleFromFileName(f.name),
    summary: '',
    parts: '',
    modifiedTime: f.modifiedTime,
    version: f.version,
  };
  const device = f.appProperties?.device;
  if (device) entry.device = device;
  if (base && base.fileId === f.id) {
    const s = songSummary(parseSong(base.text));
    entry.summary = s.summary;
    entry.parts = s.parts;
    if (base.version === f.version) entry.title = s.title;
  }
  return entry;
}

/**
 * Cached index + fresh Drive listing + this device's local-only songs →
 * new index (files in listing order, then local-only songs).
 * - Files sharing a songId: one keeps it (the cached owner, else the
 *   smallest file id); the others fall back to `drive-<fileId>`.
 * - Details the listing lacks (summary / parts, and the title while the
 *   version is unchanged) are carried over from the cached entry of the
 *   same file.
 * - Cached Drive entries whose file vanished are dropped, unless the song is
 *   in `localOnly` (a draft remains) — then it stays as a local-only song.
 * - `localOnly` entries whose songId now has a Drive file are dropped
 *   (Drive's entry wins); the rest never carry fileId/version.
 */
export function mergeIndex(
  cached: SongIndex,
  files: DriveFileMeta[],
  localOnly: SongEntry[],
  folderId: string,
  now: Date,
): SongIndex {
  const counts = new Map<string, number>();
  for (const f of files) {
    const id = f.appProperties?.songId?.trim();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const cachedByFile = new Map<string, SongEntry>();
  for (const e of cached.songs) if (e.fileId) cachedByFile.set(e.fileId, e);
  // Among files sharing a songId exactly one keeps it (stable across
  // saves): the file the cache already maps to it, else the smallest file
  // id. The others become `drive-<fileId>`; saving one of those writes that
  // id, which leaves every id unique and unchanged afterwards.
  const keeper = new Map<string, string>();
  for (const f of files) {
    const id = f.appProperties?.songId?.trim();
    if (!id || (counts.get(id) ?? 0) < 2) continue;
    const cur = keeper.get(id);
    const cachedHere = cachedByFile.get(f.id)?.songId === id;
    const cachedCur = cur !== undefined && cachedByFile.get(cur)?.songId === id;
    if (
      cur === undefined ||
      (cachedHere && !cachedCur) ||
      (cachedHere === cachedCur && f.id < cur)
    )
      keeper.set(id, f.id);
  }

  const songs: SongEntry[] = files.map((f) => {
    const id = f.appProperties?.songId?.trim();
    const dup =
      id !== undefined &&
      id !== '' &&
      (counts.get(id) ?? 0) > 1 &&
      keeper.get(id) !== f.id;
    const { songId: _drop, ...rest } = f.appProperties ?? {};
    void _drop;
    const entry = entryFromFile(dup ? { ...f, appProperties: rest } : f, null);
    const old = cachedByFile.get(f.id);
    if (old) {
      entry.summary = old.summary;
      entry.parts = old.parts;
      if (old.version === f.version && old.title) entry.title = old.title;
    }
    return entry;
  });

  const driveIds = new Set(songs.map((e) => e.songId));
  for (const e of localOnly) {
    if (driveIds.has(e.songId)) continue;
    const { fileId: _f, version: _v, ...local } = e;
    void _f;
    void _v;
    songs.push(local);
    driveIds.add(e.songId);
  }

  return { v: 1, folderId, listedAt: now.toISOString(), songs };
}

/**
 * - no fileId → 'localOnly'
 * - a draft whose text differs from base (or no base) is unsaved work:
 *   'driveNewer' when Drive's version is not the one it was started from,
 *   else 'dirty'
 * - otherwise 'synced'
 */
export function songStatus(
  e: SongEntry,
  draft: DraftRecord | null,
  base: BaseRecord | null,
): SongStatus {
  if (!e.fileId) return 'localOnly';
  if (!draft || (base && draft.text === base.text)) return 'synced';
  if (
    draft.baseVersion !== null &&
    e.version !== undefined &&
    draft.baseVersion !== e.version
  ) {
    return 'driveNewer';
  }
  return 'dirty';
}

const collator = new Intl.Collator('ja', {
  numeric: true,
  sensitivity: 'base',
});

function time(e: SongEntry): number {
  const t = e.modifiedTime ? Date.parse(e.modifiedTime) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function byTitle(a: SongEntry, b: SongEntry): number {
  return collator.compare(a.title, b.title);
}

/** 'modified' = newest first (ties: title); 'title' = Japanese collation (ties: newest first). */
export function sortSongs(
  songs: readonly SongEntry[],
  order: SortOrder,
): SongEntry[] {
  const newestFirst = (a: SongEntry, b: SongEntry) => {
    const ta = time(a);
    const tb = time(b);
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  };
  const cmp =
    order === 'modified'
      ? (a: SongEntry, b: SongEntry) => newestFirst(a, b) || byTitle(a, b)
      : (a: SongEntry, b: SongEntry) => byTitle(a, b) || newestFirst(a, b);
  return [...songs].sort(
    (a, b) =>
      cmp(a, b) || (a.songId < b.songId ? -1 : a.songId > b.songId ? 1 : 0),
  );
}

/** NFKC (full/half width), lower case, katakana → hiragana. */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Title match; whitespace-separated terms must all appear. Empty query = all. */
export function filterSongs(
  songs: readonly SongEntry[],
  query: string,
): SongEntry[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...songs];
  return songs.filter((e) => {
    const t = fold(e.title);
    return terms.every((q) => t.includes(q));
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 「今日 14:32」「昨日 21:05」「10/3 18:20」(this year) 「2025/12/1」(other years); '' if unparsable. Local time. */
export function formatModified(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((dayStart(now) - dayStart(d)) / dayMs);
  if (diff === 0) return `今日 ${hm}`;
  if (diff === 1) return `昨日 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
