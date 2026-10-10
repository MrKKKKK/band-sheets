/**
 * The song list (docs/m7-plan.md, T15): offline first — the cached index
 * (`band-sheets:index`) is shown at once, then (when signed in) the Drive
 * folder is listed, merged (`mergeIndex`) and the songs whose text this
 * device doesn't have yet (or has an older version of) are downloaded one by
 * one into `base`, so they can be opened offline and show key/tempo/parts.
 * Also the list actions: new song id, rename, duplicate, delete.
 *
 * The index in storage is the single source: every write here (and in
 * `useSongDocument`) is load → modify → save → `notifyIndexChanged`, and a
 * mounted library re-reads it on that notification. Drafts written by the
 * editor's autosave do NOT notify — call `reload()` when the list is shown.
 *
 * Actions that need Drive call `session.ensureToken()` synchronously first,
 * so call them directly from the click / submit handler.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDirty, withTitle } from '../lib/draftState';
import {
  duplicateSong,
  ensureFolder,
  fetchList,
  loadRemote,
  renameSong,
  trashSong,
  baseFromRemote,
} from '../lib/drive/songSync';
import { copyTitle } from '../lib/fileName';
import { parseSong } from '../lib/parseSong';
import {
  baseKey,
  loadBase,
  loadDraftRecord,
  loadIndex,
  removeDraft,
  removeSongData,
  saveBase,
  saveDraftRecord,
  saveIndex,
  type KeyValueStorage,
} from '../lib/storage';
import {
  entryFromFile,
  mergeIndex,
  songStatus,
  songSummary,
} from '../lib/songIndex';
import type { SongEntry, SongIndex, SongStatus } from '../lib/syncTypes';
import {
  failReason,
  type DriveSession,
  type FailReason,
} from './useDriveSession';

// --- Index helpers shared with useSongDocument / useDriveSession -----------

const NO_STORAGE = {};
const listeners = new WeakMap<object, Set<() => void>>();

/** Called by a library to hear about index writes made elsewhere. */
export function subscribeIndex(
  storage: KeyValueStorage | null,
  fn: () => void,
): () => void {
  const key = storage ?? NO_STORAGE;
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

export function notifyIndexChanged(storage: KeyValueStorage | null): void {
  for (const fn of [...(listeners.get(storage ?? NO_STORAGE) ?? [])]) fn();
}

/** load → fn → save → notify. Returns the saved index. */
export function updateIndex(
  storage: KeyValueStorage | null,
  fn: (idx: SongIndex) => SongIndex,
): SongIndex {
  const next = fn(loadIndex(storage));
  saveIndex(storage, next);
  notifyIndexChanged(storage);
  return next;
}

/** Title / summary / parts of a song text. */
export function textFields(
  text: string,
): Pick<SongEntry, 'title' | 'summary' | 'parts'> {
  return songSummary(parseSong(text));
}

/** Replaces the entry with the same songId (or appends it). */
export function upsertEntry(
  storage: KeyValueStorage | null,
  entry: SongEntry,
): void {
  updateIndex(storage, (idx) => {
    const songs = idx.songs.some((e) => e.songId === entry.songId)
      ? idx.songs.map((e) => (e.songId === entry.songId ? entry : e))
      : [...idx.songs, entry];
    return { ...idx, songs };
  });
}

/**
 * A new device-only song: its draft (no Drive version yet) plus its list
 * entry, the state a 「新しい曲」 reaches after its first edit. Used by the
 * local 「複製」 and by 「サンプル曲を追加」; saving it to Drive works like
 * any new song.
 */
export function addLocalSong(
  storage: KeyValueStorage | null,
  songId: string,
  text: string,
  at: Date,
): void {
  const savedAt = at.toISOString();
  saveDraftRecord(storage, songId, { v: 1, text, baseVersion: null, savedAt });
  upsertEntry(storage, { songId, ...textFields(text), modifiedTime: savedAt });
}

export function findEntry(
  storage: KeyValueStorage | null,
  songId: string,
): SongEntry | undefined {
  return loadIndex(storage).songs.find((e) => e.songId === songId);
}

function removeItem(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Sign-out: forget the Drive list and texts (folder id, listing time, Drive
 * entries, their `base`). Songs with unsaved changes keep their entry, base
 * and draft (the work on this device is never lost, and the base keeps the
 * conflict check working after the next sign-in). Device-only songs stay.
 */
export function clearDriveCache(storage: KeyValueStorage | null): void {
  updateIndex(storage, (idx) => {
    const songs = idx.songs.filter((e) => {
      if (!e.fileId) return true;
      const draft = loadDraftRecord(storage, e.songId);
      const base = loadBase(storage, e.songId);
      if (isDirty(draft, base)) return true;
      if (draft) removeDraft(storage, e.songId);
      removeItem(storage, baseKey(e.songId));
      return false;
    });
    return { v: 1, songs };
  });
}

/**
 * Device-only entries refreshed from their drafts (title / parts / time);
 * those without a draft any more are dropped (e.g. a new song never edited).
 */
function refreshLocalEntries(
  storage: KeyValueStorage | null,
  idx: SongIndex,
): SongIndex {
  let changed = false;
  const songs: SongEntry[] = [];
  for (const e of idx.songs) {
    if (e.fileId) {
      songs.push(e);
      continue;
    }
    const draft = loadDraftRecord(storage, e.songId);
    if (!draft) {
      changed = true;
      continue;
    }
    const next: SongEntry = {
      ...e,
      ...textFields(draft.text),
      ...(draft.savedAt ? { modifiedTime: draft.savedAt } : {}),
    };
    if (
      next.title !== e.title ||
      next.summary !== e.summary ||
      next.parts !== e.parts ||
      next.modifiedTime !== e.modifiedTime
    ) {
      changed = true;
    }
    songs.push(next);
  }
  return changed ? { ...idx, songs } : idx;
}

// --- The hook ---------------------------------------------------------------

export type LibraryBanner = 'offline' | 'reconnect' | 'unconfigured';

export type ActionResult =
  | { ok: true; songId?: string }
  | {
      ok: false;
      /**
       * notAllowed: rename of a song with unsaved changes / not on Drive, or
       * an unknown song. conflict: Drive changed while renaming (base was
       * refreshed; try again).
       */
      reason: FailReason | 'notAllowed' | 'conflict';
    };

export interface SongLibrary {
  songs: SongEntry[];
  statuses: Readonly<Record<string, SongStatus>>;
  /** Songs whose text is on this device (`base`, or a device-only draft). */
  cachedIds: ReadonlySet<string>;
  listedAt?: string;
  /** Which ConnectionBanner to show (null = none). */
  banner: LibraryBanner | null;
  refreshing: boolean;
  /** The last refresh's failure (null after a success). */
  refreshError: FailReason | null;
  /** Song with a running rename / duplicate / delete. */
  busyId: string | null;
  /** 「最新の状態に更新」/「もう一度つなぐ」: call from the click handler. */
  refresh(): Promise<boolean>;
  /** Re-read the index, drafts and bases from storage (no network). */
  reload(): void;
  /** Id for 「新しい曲」 (nothing is stored until the editor writes a draft). */
  newSongId(): string;
  /** Rename only songs that are on Drive without unsaved changes. */
  canRename(songId: string): boolean;
  rename(songId: string, title: string): Promise<ActionResult>;
  /** Drive song + signed in → copy on Drive; otherwise a device-only copy. */
  duplicate(songId: string): Promise<ActionResult>;
  /** Drive song → trash; device-only → drop the draft. Local data is removed. */
  remove(songId: string): Promise<ActionResult>;
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

export function useSongLibrary(
  session: DriveSession,
  opts: { now?: () => Date; newId?: () => string } = {},
): SongLibrary {
  const { storage, client, status } = session;
  const nowRef = useRef(opts.now ?? (() => new Date()));
  const newIdRef = useRef(opts.newId ?? defaultNewId);
  useEffect(() => {
    nowRef.current = opts.now ?? (() => new Date());
    newIdRef.current = opts.newId ?? defaultNewId;
  });

  const read = useCallback(() => {
    const idx = loadIndex(storage);
    const fresh = refreshLocalEntries(storage, idx);
    if (fresh !== idx) saveIndex(storage, fresh);
    return fresh;
  }, [storage]);

  const [index, setIndex] = useState<SongIndex>(read);
  // Bumped on reload so statuses re-read drafts / bases.
  const [rev, setRev] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<FailReason | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    if (!alive.current) return;
    setIndex(read());
    setRev((r) => r + 1);
  }, [read]);

  useEffect(() => subscribeIndex(storage, reload), [storage, reload]);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  });

  // --- refresh ------------------------------------------------------------

  const inflight = useRef<Promise<boolean> | null>(null);

  /** List + merge + backfill. Token must already be available. */
  const runFetch = useCallback(async (): Promise<boolean> => {
    try {
      const folderId = await ensureFolder(client, loadIndex(storage).folderId);
      const files = await fetchList(client, folderId);
      const merged = updateIndex(storage, (cur) => {
        const localOnly = cur.songs.filter(
          (e) => !e.fileId || loadDraftRecord(storage, e.songId) !== null,
        );
        const next = mergeIndex(
          cur,
          files,
          localOnly,
          folderId,
          nowRef.current(),
        );
        // Drive entries that vanished (no draft): forget their text too.
        const kept = new Set(next.songs.map((e) => e.songId));
        for (const e of cur.songs) {
          if (e.fileId && !kept.has(e.songId))
            removeItem(storage, baseKey(e.songId));
        }
        return next;
      });
      if (alive.current) setRefreshError(null);
      await backfill(merged);
      return true;
    } catch (e) {
      if (alive.current) setRefreshError(failReason(e));
      return false;
    }

    async function backfill(idx: SongIndex): Promise<void> {
      for (const e of idx.songs) {
        if (!alive.current) return;
        if (!e.fileId || e.version === undefined) continue;
        const base = loadBase(storage, e.songId);
        if (base && base.fileId === e.fileId && base.version === e.version)
          continue;
        const draft = loadDraftRecord(storage, e.songId);
        // Never move the base under unsaved work: it is what the conflict
        // check compares against.
        if (isDirty(draft, base)) continue;
        let remote;
        try {
          remote = await loadRemote(client, e.fileId);
        } catch (err) {
          const r = failReason(err);
          if (r === 'auth' || r === 'network') throw err;
          continue; // notFound etc.: skip this song
        }
        // The download took time: the editor may have written a draft (or
        // another path moved the base) meanwhile. Re-check right before
        // touching anything; leave the song alone if anything changed.
        const draftNow = loadDraftRecord(storage, e.songId);
        const baseNow = loadBase(storage, e.songId);
        if (isDirty(draftNow, baseNow)) continue;
        if (
          (draftNow?.text ?? null) !== (draft?.text ?? null) ||
          (draftNow?.savedAt ?? null) !== (draft?.savedAt ?? null) ||
          (baseNow?.version ?? null) !== (base?.version ?? null) ||
          (baseNow?.fileId ?? null) !== (base?.fileId ?? null)
        )
          continue;
        const nb = baseFromRemote(remote.meta, remote.text);
        saveBase(storage, e.songId, nb);
        if (draftNow) removeDraft(storage, e.songId);
        upsertEntry(storage, {
          ...entryFromFile(remote.meta, nb),
          songId: e.songId,
        });
      }
    }
  }, [client, storage]);

  const startFetch = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    setRefreshing(true);
    const p = runFetch().finally(() => {
      inflight.current = null;
      if (alive.current) setRefreshing(false);
    });
    inflight.current = p;
    return p;
  }, [runFetch]);

  const refresh = useCallback((): Promise<boolean> => {
    const s = sessionRef.current;
    if (s.status === 'unconfigured') return Promise.resolve(false);
    // In the click handler, before any await (may open the GIS popup).
    const token = s.ensureToken();
    return token.then(
      () => startFetch(),
      (e: unknown) => {
        if (alive.current) setRefreshError(failReason(e));
        return false;
      },
    );
  }, [startFetch]);

  // Signed in (at startup, after sign-in or reconnect): fetch without popup.
  useEffect(() => {
    if (status !== 'signedIn') return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void startFetch();
    });
    return () => {
      cancelled = true;
    };
  }, [status, startFetch]);

  // Back online: retry (the listing may be stale, e.g. venue Wi-Fi).
  useEffect(() => {
    if (status !== 'signedIn' || typeof window === 'undefined') return;
    const onOnline = () => void startFetch();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [status, startFetch]);

  // --- derived ------------------------------------------------------------

  const statuses = useMemo(() => {
    void rev;
    const out: Record<string, SongStatus> = {};
    for (const e of index.songs) {
      out[e.songId] = songStatus(
        e,
        loadDraftRecord(storage, e.songId),
        loadBase(storage, e.songId),
      );
    }
    return out;
  }, [index, rev, storage]);

  const cachedIds = useMemo(() => {
    void rev;
    const ids = new Set<string>();
    for (const e of index.songs) {
      if (
        e.fileId
          ? loadBase(storage, e.songId)
          : loadDraftRecord(storage, e.songId)
      ) {
        ids.add(e.songId);
      }
    }
    return ids;
  }, [index, rev, storage]);

  const banner: LibraryBanner | null =
    status === 'unconfigured'
      ? 'unconfigured'
      : status === 'expired' || refreshError === 'auth'
        ? 'reconnect'
        : status === 'signedIn' && refreshError === 'network'
          ? 'offline'
          : null;

  // --- actions --------------------------------------------------------------

  const canRename = useCallback(
    (songId: string) => {
      const e = loadIndex(storage).songs.find((x) => x.songId === songId);
      if (!e?.fileId) return false;
      return !isDirty(
        loadDraftRecord(storage, songId),
        loadBase(storage, songId),
      );
    },
    [storage],
  );

  const run = useCallback(
    async (
      songId: string,
      token: Promise<string> | null,
      fn: () => Promise<ActionResult>,
    ) => {
      setBusyId(songId);
      try {
        if (token) await token;
        return await fn();
      } catch (e) {
        return { ok: false, reason: failReason(e) } as const;
      } finally {
        if (alive.current) setBusyId(null);
      }
    },
    [],
  );

  /** Folder id (cached in the index). */
  const folder = useCallback(async () => {
    const cached = loadIndex(storage).folderId;
    const id = await ensureFolder(client, cached);
    if (id !== cached)
      updateIndex(storage, (idx) => ({ ...idx, folderId: id }));
    return id;
  }, [client, storage]);

  /** The song's current Drive text as base (downloads when missing / stale). */
  const freshBase = useCallback(
    async (e: SongEntry) => {
      const base = loadBase(storage, e.songId);
      if (
        base &&
        base.fileId === e.fileId &&
        (e.version === undefined || base.version === e.version)
      ) {
        return base;
      }
      const remote = await loadRemote(client, e.fileId!);
      const nb = baseFromRemote(remote.meta, remote.text);
      saveBase(storage, e.songId, nb);
      return nb;
    },
    [client, storage],
  );

  const rename = useCallback(
    (songId: string, title: string): Promise<ActionResult> => {
      const e = findEntry(storage, songId);
      if (!e?.fileId || !canRename(songId) || title.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'notAllowed' });
      }
      const s = sessionRef.current;
      const token = s.ensureToken();
      return run(songId, token, async () => {
        const folderId = await folder();
        const base = await freshBase(e);
        const r = await renameSong(client, {
          songId,
          folderId,
          base,
          title: title.trim(),
          device: s.device,
        });
        if (r.kind === 'conflict') {
          saveBase(storage, songId, baseFromRemote(r.remote, r.remoteText));
          upsertEntry(storage, {
            ...entryFromFile(r.remote, null),
            ...textFields(r.remoteText),
            songId,
          });
          return { ok: false, reason: 'conflict' };
        }
        saveBase(storage, songId, r.base);
        removeDraft(storage, songId);
        upsertEntry(storage, entryFor(songId, r.base));
        return { ok: true, songId };
      });
    },
    [storage, canRename, run, folder, freshBase, client],
  );

  const duplicate = useCallback(
    (songId: string): Promise<ActionResult> => {
      const e = findEntry(storage, songId);
      if (!e) return Promise.resolve({ ok: false, reason: 'notAllowed' });
      const s = sessionRef.current;
      const draft = loadDraftRecord(storage, songId);
      const base = loadBase(storage, songId);
      const newId = newIdRef.current();
      const onDrive = Boolean(e.fileId) && s.connected;
      if (!onDrive) {
        const text = draft?.text ?? base?.text;
        if (text === undefined)
          return Promise.resolve({ ok: false, reason: 'notAllowed' });
        const copy = withTitle(text, copyTitle(textFields(text).title));
        addLocalSong(storage, newId, copy, nowRef.current());
        return Promise.resolve({ ok: true, songId: newId });
      }
      const token = s.ensureToken();
      return run(songId, token, async () => {
        const folderId = await folder();
        // Copy what the user sees: unsaved changes included.
        const text = isDirty(draft, base)
          ? draft!.text
          : (await freshBase(e)).text;
        const nb = await duplicateSong(client, {
          folderId,
          text,
          device: s.device,
          newId,
        });
        saveBase(storage, newId, nb);
        upsertEntry(storage, entryFor(newId, nb));
        return { ok: true, songId: newId };
      });
    },
    [storage, run, folder, freshBase, client],
  );

  const remove = useCallback(
    (songId: string): Promise<ActionResult> => {
      const e = findEntry(storage, songId);
      const drop = () => {
        removeSongData(storage, songId);
        updateIndex(storage, (idx) => ({
          ...idx,
          songs: idx.songs.filter((x) => x.songId !== songId),
        }));
      };
      if (!e?.fileId) {
        drop();
        return Promise.resolve({ ok: true });
      }
      const fileId = e.fileId;
      const token = sessionRef.current.ensureToken();
      return run(songId, token, async () => {
        await trashSong(client, fileId);
        drop();
        return { ok: true };
      });
    },
    [storage, run, client],
  );

  const newSongId = useCallback(() => newIdRef.current(), []);

  return {
    songs: index.songs,
    statuses,
    cachedIds,
    ...(index.listedAt ? { listedAt: index.listedAt } : {}),
    banner,
    refreshing,
    refreshError,
    busyId,
    refresh,
    reload,
    newSongId,
    canRename,
    rename,
    duplicate,
    remove,
  };
}

/** Index entry for a song just written to Drive (base = what was written). */
export function entryFor(
  songId: string,
  base: {
    fileId: string;
    version: string;
    modifiedTime: string;
    device?: string;
    text: string;
  },
): SongEntry {
  return {
    songId,
    fileId: base.fileId,
    ...textFields(base.text),
    modifiedTime: base.modifiedTime,
    version: base.version,
    ...(base.device ? { device: base.device } : {}),
  };
}
