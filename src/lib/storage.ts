/**
 * localStorage helpers (docs/m3-plan.md, decision 9). Every access is wrapped
 * in try/catch: storage may be missing or throw (private mode, blocked site
 * data, quota). Failures are silent — the draft is a convenience, not the
 * saved file (Drive saving is M7).
 */

import { NOTE_NAME_MODES, type NoteNameMode } from './noteNames';
import type { BaseRecord, DraftRecord, SongIndex } from './syncTypes';
import type { ViewerSettings } from './viewerSettings';

/** The subset of the Web Storage API these helpers use. */
export type KeyValueStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

/** The M3-M6 single song id; kept only for migrateLegacyLocal. */
export const LOCAL_SONG_ID = 'local';

const PREFIX = 'band-sheets:';

export function draftKey(songId: string): string {
  return `${PREFIX}draft:${songId}`;
}

/** `window.localStorage`, or null when it is unavailable / throws. */
export function getLocalStorage(): KeyValueStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: KeyValueStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the write failed. */
function write(
  storage: KeyValueStorage | null,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Failures are swallowed (storage may throw). */
function remove(storage: KeyValueStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

function readJson(storage: KeyValueStorage | null, key: string): unknown {
  const text = read(storage, key);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A JSON DraftRecord, or a legacy raw-text draft (baseVersion null). */
export function loadDraftRecord(
  storage: KeyValueStorage | null,
  songId: string,
): DraftRecord | null {
  const raw = read(storage, draftKey(songId));
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isRecord(v) &&
      v.v === 1 &&
      typeof v.text === 'string' &&
      (v.baseVersion === null || typeof v.baseVersion === 'string') &&
      typeof v.savedAt === 'string'
    ) {
      return {
        v: 1,
        text: v.text,
        baseVersion: v.baseVersion,
        savedAt: v.savedAt,
      };
    }
  } catch {
    // not JSON: legacy raw text
  }
  return { v: 1, text: raw, baseVersion: null, savedAt: '' };
}

export function saveDraftRecord(
  storage: KeyValueStorage | null,
  songId: string,
  d: DraftRecord,
): boolean {
  return write(storage, draftKey(songId), JSON.stringify(d));
}

export function removeDraft(
  storage: KeyValueStorage | null,
  songId: string,
): void {
  remove(storage, draftKey(songId));
}

export function baseKey(songId: string): string {
  return `${PREFIX}base:${songId}`;
}

export function loadBase(
  storage: KeyValueStorage | null,
  songId: string,
): BaseRecord | null {
  const v = readJson(storage, baseKey(songId));
  if (
    !isRecord(v) ||
    typeof v.fileId !== 'string' ||
    typeof v.version !== 'string' ||
    typeof v.modifiedTime !== 'string' ||
    typeof v.text !== 'string'
  ) {
    return null;
  }
  const b: BaseRecord = {
    fileId: v.fileId,
    version: v.version,
    modifiedTime: v.modifiedTime,
    text: v.text,
  };
  if (typeof v.device === 'string') b.device = v.device;
  return b;
}

export function saveBase(
  storage: KeyValueStorage | null,
  songId: string,
  b: BaseRecord,
): boolean {
  return write(storage, baseKey(songId), JSON.stringify(b));
}

/** Removes draft, base and viewer settings of a song. */
export function removeSongData(
  storage: KeyValueStorage | null,
  songId: string,
): void {
  remove(storage, draftKey(songId));
  remove(storage, baseKey(songId));
  remove(storage, viewerSettingsKey(songId));
}

export const INDEX_KEY = `${PREFIX}index`;

/** Cached song list; an empty index when missing or broken. */
export function loadIndex(storage: KeyValueStorage | null): SongIndex {
  const v = readJson(storage, INDEX_KEY);
  if (!isRecord(v) || v.v !== 1 || !Array.isArray(v.songs)) {
    return { v: 1, songs: [] };
  }
  const songs = v.songs.filter(
    (e): e is SongIndex['songs'][number] =>
      isRecord(e) &&
      typeof e.songId === 'string' &&
      typeof e.title === 'string',
  );
  const idx: SongIndex = { v: 1, songs };
  if (typeof v.folderId === 'string') idx.folderId = v.folderId;
  if (typeof v.listedAt === 'string') idx.listedAt = v.listedAt;
  return idx;
}

export function saveIndex(
  storage: KeyValueStorage | null,
  idx: SongIndex,
): boolean {
  return write(storage, INDEX_KEY, JSON.stringify(idx));
}

export interface AuthRecord {
  accessToken: string;
  expiresAt: number;
}

export const AUTH_KEY = `${PREFIX}auth`;

export function loadAuth(storage: KeyValueStorage | null): AuthRecord | null {
  const v = readJson(storage, AUTH_KEY);
  if (
    !isRecord(v) ||
    typeof v.accessToken !== 'string' ||
    typeof v.expiresAt !== 'number' ||
    !Number.isFinite(v.expiresAt)
  ) {
    return null;
  }
  return { accessToken: v.accessToken, expiresAt: v.expiresAt };
}

/** null removes the stored auth. */
export function saveAuth(
  storage: KeyValueStorage | null,
  a: AuthRecord | null,
): void {
  if (a === null) remove(storage, AUTH_KEY);
  else write(storage, AUTH_KEY, JSON.stringify(a));
}

export const DEVICE_KEY = `${PREFIX}device`;

/** The device name, detected on first use and then fixed. */
export function loadDeviceName(
  storage: KeyValueStorage | null,
  detect: () => string,
): string {
  const saved = read(storage, DEVICE_KEY);
  if (saved) return saved;
  const name = detect();
  write(storage, DEVICE_KEY, name);
  return name;
}

/**
 * Moves the M3-M6 `local` draft (raw text) and its viewer settings to a new
 * song id, registers it in the index as a device-only song and removes the
 * old keys. Returns the new song id, or null when there was nothing to move
 * (so a second call is a no-op) or a write failed (old keys are kept).
 */
export function migrateLegacyLocal(
  storage: KeyValueStorage | null,
  newId: () => string,
  now: Date,
): string | null {
  const legacy = loadDraftRecord(storage, LOCAL_SONG_ID);
  if (!legacy) return null;
  const id = newId();
  const savedAt = legacy.savedAt || now.toISOString();
  const title = /^\{title:\s*(.*?)\s*\}\s*$/m.exec(legacy.text)?.[1] ?? '';
  const viewerText = read(storage, viewerSettingsKey(LOCAL_SONG_ID));
  let viewerOk = false;
  if (viewerText !== null) {
    try {
      JSON.parse(viewerText);
      viewerOk = true;
    } catch {
      // broken settings are dropped
    }
  }
  const idx = loadIndex(storage);
  const ok =
    saveDraftRecord(storage, id, { ...legacy, baseVersion: null, savedAt }) &&
    (!viewerOk ||
      write(storage, viewerSettingsKey(id), viewerText as string)) &&
    saveIndex(storage, {
      ...idx,
      songs: [
        ...idx.songs,
        {
          songId: id,
          title: title || '無題の曲',
          summary: '',
          parts: '',
          modifiedTime: savedAt,
        },
      ],
    });
  if (!ok) {
    removeDraft(storage, id);
    remove(storage, viewerSettingsKey(id));
    return null;
  }
  remove(storage, draftKey(LOCAL_SONG_ID));
  remove(storage, viewerSettingsKey(LOCAL_SONG_ID));
  return id;
}

/** Chord-chart input mode (per-viewer convenience). */
export type EditorMode = 'easy' | 'text';

export const EDITOR_MODE_KEY = `${PREFIX}editor-mode`;

export function loadEditorMode(storage: KeyValueStorage | null): EditorMode {
  return read(storage, EDITOR_MODE_KEY) === 'text' ? 'text' : 'easy';
}

export function saveEditorMode(
  storage: KeyValueStorage | null,
  mode: EditorMode,
): boolean {
  return write(storage, EDITOR_MODE_KEY, mode);
}

/**
 * Note names under the notes on the humming review screen S4 (per device; later moves to a settings file on
 * Drive, plan §4 「D2 で決めたこと」).
 */
export const NOTE_NAMES_KEY = `${PREFIX}note-names`;

export function loadNoteNameMode(
  storage: KeyValueStorage | null,
): NoteNameMode {
  const v = read(storage, NOTE_NAMES_KEY);
  return NOTE_NAME_MODES.find((m) => m.value === v)?.value ?? 'doremi';
}

export function saveNoteNameMode(
  storage: KeyValueStorage | null,
  mode: NoteNameMode,
): boolean {
  return write(storage, NOTE_NAMES_KEY, mode);
}

export function viewerSettingsKey(songId: string): string {
  return `${PREFIX}viewer:${songId}`;
}

/** Parsed JSON of the stored viewer settings; undefined when missing / broken. */
export function loadViewerSettings(
  storage: KeyValueStorage | null,
  songId: string,
): unknown {
  const text = read(storage, viewerSettingsKey(songId));
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function saveViewerSettings(
  storage: KeyValueStorage | null,
  songId: string,
  s: ViewerSettings,
): boolean {
  return write(storage, viewerSettingsKey(songId), JSON.stringify(s));
}

/** In-memory storage for tests and stories. */
export function createMemoryStorage(
  initial: Record<string, string> = {},
): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
