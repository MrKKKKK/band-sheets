/**
 * One song in the editor (docs/m7-plan.md, T15, decisions 3–4): how to open
 * it (`decideOpen`: A drive / B askResume / C driveNewer / draftOnly /
 * unavailable, with the OpenDraftDialog answers), the header's SaveState,
 * saving (`saveSong`) with the conflict dialog and its 3 choices, and
 * keeping `base` / drafts / the index in step on success.
 *
 * Also `useSongView`: one song in the viewer opened from the list (never
 * writes a draft; shows unsaved changes when there are any; checks Drive
 * once on open and swaps in a newer version).
 *
 * Usage (EditorScreen):
 *   <App key={doc.editorKey} songId initialText={doc.initialText}
 *        baseVersion={doc.baseVersion} onTextChange={doc.onTextChange} … />
 * `editorKey` changes when the text was replaced from Drive (conflict
 * "reload"), so App must be re-created with the new `initialText`.
 * `save`, `recreate`, `reconnect`, `answerOpen` and `resolveConflict` call
 * `session.ensureToken()` synchronously first: call them straight from the
 * click / keydown handler.
 *
 * Review fixes (docs/m7-review.md): `unconfirmed` + `reconnect` (R2: the
 * cached copy was opened without checking Drive), `missing` + `recreate`
 * (R14: never recreate a vanished file without asking), drafts of other
 * tabs are never rebased by a save (R4), the copy of 「別の曲として残す」 is
 * made once per text even across retries (R7), and a resumed draft keeps
 * the Drive version it was written on (R3/R6: `baseForDraft`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { decideOpen, isDirty, saveStateOf, withTitle } from '../lib/draftState';
import {
  baseFromRemote,
  createSongFile,
  ensureFolder,
  loadRemote,
  resolveConflict as resolveOnDrive,
  saveSong,
} from '../lib/drive/songSync';
import { isDriveError } from '../lib/drive/driveClient';
import { localCopyTitle } from '../lib/fileName';
import { newSongText } from '../lib/serializeSong';
import {
  loadBase,
  loadDraftRecord,
  loadIndex,
  removeDraft,
  saveBase,
  saveDraftRecord,
  type KeyValueStorage,
} from '../lib/storage';
import type {
  BaseRecord,
  ConflictChoice,
  DraftRecord,
  DriveFileMeta,
  OpenDecision,
  SaveState,
} from '../lib/syncTypes';
import {
  failReason,
  type DriveSession,
  type FailReason,
} from './useDriveSession';
import {
  entryFor,
  findEntry,
  textFields,
  updateIndex,
  upsertEntry,
} from './useSongLibrary';

/** Same values as OpenDraftDialog's OpenDraftChoice. */
export type OpenChoice = 'resumeDraft' | 'openDrive' | 'keepDraftCopy';

/** Props for OpenDraftDialog (kind B = 'draftNewer', C = 'driveNewer'). */
export interface OpenAsk {
  kind: 'draftNewer' | 'driveNewer';
  songTitle: string;
  draft: { savedAt: string; device?: string };
  drive: { modifiedTime: string; device?: string };
}

/** Props for ConflictDialog. */
export interface ConflictInfo {
  songTitle: string;
  drive: { modifiedTime: string; device?: string };
  local: { editedAt: string; device: string; baseModifiedTime?: string };
  changedLines: number;
}

export type DocPhase = 'loading' | 'ask' | 'ready' | 'unavailable';
/**
 * 'reloaded': a conflict was resolved by re-opening Drive's version.
 * 'missing': the song's Drive file is gone; `missing` is set (ask the user,
 * then `recreate()`).
 */
export type SaveOutcome =
  'saved' | 'reloaded' | 'conflict' | 'missing' | 'failed' | 'skipped';

export interface SongDocument {
  phase: DocPhase;
  /** The OpenDecision that was taken (null while loading). */
  decision: OpenDecision | null;
  /** Show OpenDraftDialog while set (phase 'ask'). */
  ask: OpenAsk | null;
  /** answerOpen is running (dialog `busy`). */
  opening: boolean;
  /** Why the last answerOpen failed (the dialog stays). */
  openError: FailReason | null;
  answerOpen(choice: OpenChoice): Promise<void>;
  /** App `key`: changes whenever `initialText` was replaced. */
  editorKey: string;
  initialText: string;
  /** Drive version the editor's text is based on (App's `baseVersion`). */
  baseVersion: string | null;
  /** The editor's current text. */
  text: string;
  /** App's onTextChange. */
  onTextChange(text: string): void;
  saveState: SaveState;
  /** Unsaved changes (text differs from Drive's version / not on Drive). */
  dirty: boolean;
  save(): Promise<SaveOutcome>;
  /** Show ConflictDialog while set. */
  conflict: ConflictInfo | null;
  /** resolveConflict is running (dialog `busy`). */
  resolving: boolean;
  resolveConflict(choice: ConflictChoice): Promise<SaveOutcome>;
  /** No-op while `resolving` (m7-review.md R5). */
  cancelConflict(): void;
  /**
   * The song's Drive file was not found when saving (R14): ask
   * 「新しく保存しますか？」 while set. The draft stays either way.
   */
  missing: boolean;
  /** 「新しく保存する」: creates a new file for this song. */
  recreate(): Promise<SaveOutcome>;
  cancelMissing(): void;
  /**
   * The text is this device's cached copy and Drive was not checked (sign-in
   * expired, or offline) — 「前回読み込んだ版です」 (R2).
   */
  unconfirmed: boolean;
  /** 「Drive に再接続」: token (popup) → check Drive → newer: A/B/C again. */
  reconnect(): Promise<void>;
  reconnecting: boolean;
  /** Why the last reconnect failed. */
  reconnectError: FailReason | null;
  /**
   * Why `phase` is 'unavailable': 'network' (Drive not reachable / sign-in
   * expired and nothing cached; offer `reconnect` while `unconfirmed`) or
   * 'notFound' (the Drive file is gone or the app lost access, R19).
   */
  unavailable: 'network' | 'notFound' | null;
}

interface DocState {
  songId: string;
  phase: DocPhase;
  decision: OpenDecision | null;
  ask: OpenAsk | null;
  /** Drive's meta seen when opening (null: offline / not on Drive / gone). */
  remote: DriveFileMeta | null;
  online: boolean;
  base: BaseRecord | null;
  text: string;
  initialText: string;
  /** Time of the draft (null = no draft for this song). */
  draftAt: string | null;
  editorKey: number;
  saving: boolean;
  failed: SaveState | null;
  conflict: ConflictInfo | null;
  resolving: boolean;
  opening: boolean;
  openError: FailReason | null;
  missing: boolean;
  unconfirmed: boolean;
  reconnecting: boolean;
  reconnectError: FailReason | null;
  unavailable: 'network' | 'notFound' | null;
}

function emptyState(songId: string): DocState {
  return {
    songId,
    phase: 'loading',
    decision: null,
    ask: null,
    remote: null,
    online: false,
    base: null,
    text: '',
    initialText: '',
    draftAt: null,
    editorKey: 0,
    saving: false,
    failed: null,
    conflict: null,
    resolving: false,
    opening: false,
    openError: null,
    missing: false,
    unconfirmed: false,
    reconnecting: false,
    reconnectError: null,
    unavailable: null,
  };
}

/** The song is (or was) on Drive. A device-only index entry wins over a stale base. */
function hasFileFor(
  storage: KeyValueStorage | null,
  songId: string,
  base: BaseRecord | null,
) {
  const entry = findEntry(storage, songId);
  return entry ? Boolean(entry.fileId) : base !== null;
}

/**
 * The base to edit (and later save) a draft against. A draft written on an
 * older Drive version than the cached base (the base moved underneath it),
 * or a Drive song whose text this device never downloaded, gets a stand-in
 * with the draft's own version and unknown text, so saving always compares
 * the texts instead of silently overwriting (m7-review.md R3 / R6).
 */
export function baseForDraft(
  storage: KeyValueStorage | null,
  songId: string,
  draft: DraftRecord | null,
  base: BaseRecord | null,
): BaseRecord | null {
  if (!draft) return base;
  if (base) {
    if (draft.baseVersion === null || draft.baseVersion === base.version)
      return base;
    return {
      fileId: base.fileId,
      version: draft.baseVersion,
      modifiedTime: '',
      text: '',
    };
  }
  const fileId = findEntry(storage, songId)?.fileId;
  if (!fileId) return null;
  return {
    fileId,
    version: draft.baseVersion ?? '',
    modifiedTime: '',
    text: '',
  };
}

function ready(
  s: DocState,
  text: string,
  base: BaseRecord | null,
  draftAt: string | null,
): DocState {
  return {
    ...s,
    phase: 'ready',
    ask: null,
    base,
    text,
    initialText: text,
    draftAt,
    opening: false,
    openError: null,
  };
}

/**
 * Applies a decision that needs no network (everything except A with a
 * newer remote). Returns null when Drive's text must be downloaded first.
 */
function applyDecision(
  s: DocState,
  storage: KeyValueStorage | null,
  device: string,
  decision: OpenDecision,
  draft: DraftRecord | null,
  base: BaseRecord | null,
  remote: DriveFileMeta | null,
): DocState | null {
  const st: DocState = { ...s, decision, remote };
  switch (decision.kind) {
    case 'draftOnly':
      return ready(
        st,
        draft?.text ?? newSongText(),
        baseForDraft(storage, s.songId, draft, base),
        draft ? draft.savedAt : null,
      );
    case 'unavailable':
      return {
        ...st,
        phase: 'unavailable',
        unavailable: st.online ? 'notFound' : 'network',
      };
    case 'drive':
      if (remote && (!base || base.version !== remote.version)) return null;
      if (!base) return { ...st, phase: 'unavailable', unavailable: 'network' };
      if (draft) removeDraft(storage, s.songId); // same text as base
      return ready(st, base.text, base, null);
    case 'askResume':
    case 'driveNewer': {
      const d = draft!;
      return {
        ...st,
        phase: 'ask',
        ask: {
          kind: decision.kind === 'askResume' ? 'draftNewer' : 'driveNewer',
          songTitle: textFields(d.text).title,
          draft: { savedAt: d.savedAt, device },
          drive: {
            modifiedTime: remote?.modifiedTime ?? base?.modifiedTime ?? '',
            ...((remote?.appProperties?.device ?? base?.device)
              ? { device: remote?.appProperties?.device ?? base?.device }
              : {}),
          },
        },
      };
    }
  }
}

/**
 * Opening without network (not signed in, or the song isn't on Drive).
 * `connected` (sign-in expired): a Drive song opened from the cache is
 * `unconfirmed`.
 */
function openOffline(
  s: DocState,
  storage: KeyValueStorage | null,
  device: string,
  connected: boolean,
): DocState {
  const draft = loadDraftRecord(storage, s.songId);
  const base = loadBase(storage, s.songId);
  const hasFile = hasFileFor(storage, s.songId, base);
  const decision = decideOpen({
    draft,
    base,
    remote: null,
    online: false,
    hasFile,
  });
  const next = applyDecision(s, storage, device, decision, draft, base, null)!;
  return { ...next, unconfirmed: connected && hasFile };
}

function storeRemote(
  storage: KeyValueStorage | null,
  songId: string,
  meta: DriveFileMeta,
  text: string,
) {
  const base = baseFromRemote(meta, text);
  saveBase(storage, songId, base);
  upsertEntry(storage, entryFor(songId, base));
  return base;
}

/**
 * After a successful write of `savedText`: base, draft, index. `ownText`
 * tells whether a draft text was typed in THIS editor (after the save
 * started): only such a draft is rebased onto the new version. Any other
 * draft (another tab's unsaved work, m7-review.md R4) keeps its old version,
 * so opening it later asks (C) instead of overwriting silently.
 */
function storeSaved(
  storage: KeyValueStorage | null,
  songId: string,
  base: BaseRecord,
  savedText: string,
  ownText: (text: string) => boolean,
) {
  saveBase(storage, songId, base);
  const d = loadDraftRecord(storage, songId);
  if (d && d.text === savedText) removeDraft(storage, songId);
  // Typed while saving: keep that draft, now based on the new version.
  else if (d && ownText(d.text))
    saveDraftRecord(storage, songId, { ...d, baseVersion: base.version });
  upsertEntry(storage, entryFor(songId, base));
}

function folderOf(session: DriveSession): Promise<string> {
  const { storage, client } = session;
  const cached = loadIndex(storage).folderId;
  return ensureFolder(client, cached).then((id) => {
    if (id !== cached)
      updateIndex(storage, (idx) => ({ ...idx, folderId: id }));
    return id;
  });
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

export function useSongDocument(
  session: DriveSession,
  songId: string,
  opts: { now?: () => Date; newId?: () => string } = {},
): SongDocument {
  const { storage, client, device } = session;
  const nowRef = useRef(opts.now ?? (() => new Date()));
  const newIdRef = useRef(opts.newId ?? defaultNewId);
  const sessionRef = useRef(session);
  useEffect(() => {
    nowRef.current = opts.now ?? (() => new Date());
    newIdRef.current = opts.newId ?? defaultNewId;
    sessionRef.current = session;
  });

  const needsNetwork = () =>
    session.status === 'signedIn' &&
    hasFileFor(storage, songId, loadBase(storage, songId));

  const [st, setSt] = useState<DocState>(() =>
    needsNetwork()
      ? emptyState(songId)
      : openOffline(emptyState(songId), storage, device, session.connected),
  );
  // A different song: start over (prefer key={songId} on the screen).
  if (st.songId !== songId) {
    setSt(
      needsNetwork()
        ? emptyState(songId)
        : openOffline(emptyState(songId), storage, device, session.connected),
    );
  }
  const stRef = useRef(st);
  useEffect(() => {
    stRef.current = st;
  });

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** setState guarded against unmount and against a song switch. */
  const update = useCallback(
    (fn: (s: DocState) => DocState) => {
      if (!alive.current) return;
      setSt((s) => (s.songId === songId ? fn(s) : s));
    },
    [songId],
  );

  // --- open (network) -------------------------------------------------------

  useEffect(() => {
    if (st.phase !== 'loading' || st.songId !== songId) return;
    let cancelled = false;
    const run = async () => {
      const draft = loadDraftRecord(storage, songId);
      const base = loadBase(storage, songId);
      const fileId = findEntry(storage, songId)?.fileId ?? base?.fileId;
      let remote: DriveFileMeta | null = null;
      let online = true;
      try {
        if (!fileId) throw new Error('no file');
        remote = await client.getMeta(fileId);
      } catch (e) {
        if (isDriveError(e) && e.kind === 'notFound') remote = null;
        else online = false;
      }
      if (cancelled) return;
      const decision = decideOpen({
        draft,
        base,
        remote,
        online,
        hasFile: true,
      });
      const s0: DocState = { ...stRef.current, online, unconfirmed: !online };
      let next = applyDecision(
        s0,
        storage,
        device,
        decision,
        draft,
        base,
        remote,
      );
      if (next === null) {
        // A: Drive has a version this device hasn't got yet.
        try {
          const r = await loadRemote(client, fileId!);
          if (cancelled) return;
          if (draft) removeDraft(storage, songId);
          const nb = storeRemote(storage, songId, r.meta, r.text);
          next = ready({ ...s0, decision, remote: r.meta }, r.text, nb, null);
        } catch {
          if (cancelled) return;
          next = base
            ? ready(
                { ...s0, decision, remote, online: false, unconfirmed: true },
                base.text,
                base,
                null,
              )
            : {
                ...s0,
                decision,
                remote,
                online: false,
                unconfirmed: true,
                phase: 'unavailable',
                unavailable: 'network',
              };
        }
      }
      const result = next;
      update(() => result);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [st.phase, st.songId, songId, storage, client, device, update]);

  // --- open dialog answers -----------------------------------------------------

  /** Copy made by 「下書きも別の曲として残す」 for this draft text (R7). */
  const openCopy = useRef<{ songId: string; text: string } | null>(null);

  const answerOpen = useCallback(
    async (choice: OpenChoice): Promise<void> => {
      const s = stRef.current;
      if (s.phase !== 'ask' || s.opening) return;
      const sess = sessionRef.current;
      const needNet = s.online && s.remote !== null && choice !== 'resumeDraft';
      // Before any await: may open the GIS popup (user gesture).
      const token = needNet ? sess.ensureToken() : null;
      const draft = loadDraftRecord(storage, songId);
      const base = loadBase(storage, songId);
      if (choice === 'resumeDraft') {
        update((x) =>
          ready(
            x,
            draft?.text ?? x.text,
            baseForDraft(storage, songId, draft, base),
            draft?.savedAt ?? null,
          ),
        );
        return;
      }
      update((x) => ({ ...x, opening: true, openError: null }));
      try {
        if (token) await token;
        // R7: a retry after a failed reload must not make a second copy.
        const madeCopy = openCopy.current;
        if (
          choice === 'keepDraftCopy' &&
          draft &&
          !(madeCopy?.songId === songId && madeCopy.text === draft.text)
        ) {
          const folderId = await folderOf(sess);
          const copyId = newIdRef.current();
          const at = Number.isNaN(Date.parse(draft.savedAt))
            ? nowRef.current()
            : new Date(draft.savedAt);
          const text = withTitle(
            draft.text,
            localCopyTitle(textFields(draft.text).title, at),
          );
          const copyBase = await createSongFile(client, {
            songId: copyId,
            folderId,
            text,
            device: sess.device,
          });
          saveBase(storage, copyId, copyBase);
          upsertEntry(storage, entryFor(copyId, copyBase));
          openCopy.current = { songId, text: draft.text };
        }
        if (needNet) {
          const r = await loadRemote(client, s.remote!.id);
          removeDraft(storage, songId);
          const nb = storeRemote(storage, songId, r.meta, r.text);
          update((x) =>
            ready(
              { ...x, remote: r.meta, unconfirmed: false },
              r.text,
              nb,
              null,
            ),
          );
        } else if (base) {
          removeDraft(storage, songId);
          update((x) => ready(x, base.text, base, null));
        } else {
          update((x) => ({ ...x, opening: false, openError: 'network' }));
        }
      } catch (e) {
        update((x) => ({ ...x, opening: false, openError: failReason(e) }));
      }
    },
    [storage, songId, client, update],
  );

  // --- editing / saving -------------------------------------------------------

  /** Texts typed in this editor since the running save started (R4). */
  const typedWhileSaving = useRef<Set<string> | null>(null);

  const onTextChange = useCallback(
    (text: string) => {
      const at = nowRef.current().toISOString();
      // Synchronously, so a save() right after (Ctrl+S) sees this text
      // (stRef is otherwise only refreshed after the next render).
      if (stRef.current.songId === songId)
        stRef.current = { ...stRef.current, text, draftAt: at };
      typedWhileSaving.current?.add(text);
      update((x) => ({ ...x, text, draftAt: at }));
    },
    [update, songId],
  );

  // Drop a draft the old editor flushed on unmount after a "reload" choice
  // (passive unmount cleanups run before this effect).
  const discardAfterReload = useRef(false);
  useEffect(() => {
    if (!discardAfterReload.current) return;
    discardAfterReload.current = false;
    removeDraft(storage, songId);
  }, [st.editorKey, storage, songId]);

  const applySaved = useCallback(
    (base: BaseRecord, savedText: string) => {
      const typed = typedWhileSaving.current;
      typedWhileSaving.current = null;
      const current = stRef.current.text;
      storeSaved(
        storage,
        songId,
        base,
        savedText,
        (t) => t === current || (typed?.has(t) ?? false),
      );
      update((x) => ({
        ...x,
        base,
        saving: false,
        resolving: false,
        conflict: null,
        failed: null,
        missing: false,
        unconfirmed: false,
        draftAt: x.text === savedText ? null : x.draftAt,
      }));
    },
    [storage, songId, update],
  );

  const fail = useCallback(
    (e: unknown) => {
      update((x) => ({
        ...x,
        saving: false,
        resolving: false,
        conflict: null,
        failed: { kind: 'failed', reason: failReason(e) },
      }));
    },
    [update],
  );

  const runSave = useCallback(
    (recreate: boolean): Promise<SaveOutcome> => {
      const s = stRef.current;
      const sess = sessionRef.current;
      if (s.phase !== 'ready' || s.saving || s.resolving || s.conflict) {
        return Promise.resolve('skipped');
      }
      if (s.missing && !recreate) return Promise.resolve('skipped');
      if (sess.status === 'unconfigured') return Promise.resolve('skipped');
      if (!recreate && s.base && s.text === s.base.text && !s.failed)
        return Promise.resolve('skipped');
      // Before any await: may open the GIS popup (Ctrl+S / click).
      const token = sess.ensureToken();
      const text = s.text;
      const base = s.base;
      typedWhileSaving.current = new Set();
      update((x) => ({ ...x, saving: true, failed: null, missing: false }));
      return (async (): Promise<SaveOutcome> => {
        try {
          await token;
          const folderId = await folderOf(sess);
          const r = await saveSong(client, {
            songId,
            folderId,
            text,
            base,
            device: sess.device,
            recreate,
          });
          if (r.kind === 'saved') {
            applySaved(r.base, text);
            return 'saved';
          }
          typedWhileSaving.current = null;
          if (r.kind === 'missing') {
            update((x) => ({ ...x, saving: false, missing: true }));
            return 'missing';
          }
          const conflict: ConflictInfo = {
            songTitle: textFields(text).title,
            drive: {
              modifiedTime: r.remote.modifiedTime,
              ...(r.remote.appProperties?.device
                ? { device: r.remote.appProperties.device }
                : {}),
            },
            local: {
              editedAt: stRef.current.draftAt ?? nowRef.current().toISOString(),
              device: sess.device,
              ...(base?.modifiedTime
                ? { baseModifiedTime: base.modifiedTime }
                : {}),
            },
            changedLines: r.changedLines,
          };
          update((x) => ({
            ...x,
            saving: false,
            conflict,
            unconfirmed: false,
          }));
          return 'conflict';
        } catch (e) {
          typedWhileSaving.current = null;
          fail(e);
          return 'failed';
        }
      })();
    },
    [client, songId, update, applySaved, fail],
  );
  const save = useCallback(() => runSave(false), [runSave]);
  const recreate = useCallback(() => runSave(true), [runSave]);
  const cancelMissing = useCallback(() => {
    update((x) => ({ ...x, missing: false }));
  }, [update]);

  const resolveConflict = useCallback(
    (choice: ConflictChoice): Promise<SaveOutcome> => {
      const s = stRef.current;
      if (!s.conflict || s.resolving || !s.base)
        return Promise.resolve('skipped');
      const sess = sessionRef.current;
      const token = sess.ensureToken(); // before any await
      const text = s.text;
      const base = s.base;
      typedWhileSaving.current = new Set();
      update((x) => ({ ...x, resolving: true }));
      const made = conflictCopy.current;
      const recordCopy = (copy: { songId: string; base: BaseRecord }) => {
        saveBase(storage, copy.songId, copy.base);
        upsertEntry(storage, entryFor(copy.songId, copy.base));
        conflictCopy.current = { songId, text, copy };
      };
      return (async (): Promise<SaveOutcome> => {
        try {
          await token;
          const folderId = await folderOf(sess);
          const r = await resolveOnDrive(client, {
            choice,
            songId,
            folderId,
            text,
            base,
            device: sess.device,
            newId: newIdRef.current(),
            now: nowRef.current(),
            // R7: the copy an earlier, failed attempt already made.
            ...(made?.songId === songId && made.text === text
              ? { copy: made.copy }
              : {}),
            onCopy: recordCopy,
          });
          if (r.kind === 'saved') {
            applySaved(r.base, text);
            return 'saved';
          }
          typedWhileSaving.current = null;
          if (r.copy) recordCopy(r.copy);
          saveBase(storage, songId, r.base);
          removeDraft(storage, songId);
          upsertEntry(storage, entryFor(songId, r.base));
          discardAfterReload.current = true;
          update((x) => ({
            ...ready(x, r.base.text, r.base, null),
            remote: null,
            editorKey: x.editorKey + 1,
            saving: false,
            resolving: false,
            conflict: null,
            failed: null,
          }));
          return 'reloaded';
        } catch (e) {
          typedWhileSaving.current = null;
          fail(e);
          return 'failed';
        }
      })();
    },
    [client, songId, storage, update, applySaved, fail],
  );

  /** Copy made by the conflict's 「別の曲として残す」 for this text (R7). */
  const conflictCopy = useRef<{
    songId: string;
    text: string;
    copy: { songId: string; base: BaseRecord };
  } | null>(null);

  const cancelConflict = useCallback(() => {
    // R5: not while a choice is running (it would re-create the editor
    // under whatever was typed after the cancel).
    update((x) => (x.resolving ? x : { ...x, conflict: null }));
  }, [update]);

  // --- reconnect (R2) -----------------------------------------------------------

  const checking = useRef(false);
  /**
   * Checks Drive for the opened (unconfirmed) song: same version → confirmed;
   * newer → open again (A/B/C; the editor unmounts first and flushes its
   * draft, so unsaved work is decided on like any other draft).
   */
  const recheck = useCallback(async () => {
    const s = stRef.current;
    // Nothing cached to open (R18): open again now that Drive is reachable.
    if (
      s.songId === songId &&
      s.phase === 'unavailable' &&
      s.unavailable === 'network' &&
      s.unconfirmed
    ) {
      update((x) => ({ ...emptyState(songId), editorKey: x.editorKey + 1 }));
      return;
    }
    if (
      !s.unconfirmed ||
      checking.current ||
      s.songId !== songId ||
      s.phase !== 'ready' ||
      s.saving ||
      s.resolving ||
      s.conflict
    )
      return;
    const fileId = s.base?.fileId ?? findEntry(storage, songId)?.fileId;
    if (!fileId) {
      update((x) => ({ ...x, unconfirmed: false }));
      return;
    }
    checking.current = true;
    try {
      let meta: DriveFileMeta;
      try {
        meta = await client.getMeta(fileId);
      } catch (e) {
        // Gone: saving will ask (R14). Otherwise stay unconfirmed.
        if (isDriveError(e) && e.kind === 'notFound')
          update((x) => ({ ...x, unconfirmed: false }));
        else update((x) => ({ ...x, reconnectError: failReason(e) }));
        return;
      }
      const cur = stRef.current;
      if (cur.phase !== 'ready' || cur.saving || cur.resolving || cur.conflict)
        return;
      if (cur.base && cur.base.version === meta.version) {
        update((x) => ({
          ...x,
          unconfirmed: false,
          online: true,
          remote: meta,
          reconnectError: null,
        }));
        return;
      }
      update((x) => ({ ...emptyState(songId), editorKey: x.editorKey + 1 }));
    } finally {
      checking.current = false;
    }
  }, [client, storage, songId, update]);

  const reconnect = useCallback((): Promise<void> => {
    // In the click handler: may open the GIS popup.
    const token = sessionRef.current.ensureToken();
    update((x) => ({ ...x, reconnecting: true, reconnectError: null }));
    return token.then(
      async () => {
        await recheck();
        update((x) => ({ ...x, reconnecting: false }));
      },
      (e: unknown) => {
        update((x) => ({
          ...x,
          reconnecting: false,
          reconnectError: failReason(e),
        }));
      },
    );
  }, [recheck, update]);

  // Signed in again some other way (the list's banner, a save): check too.
  const prevStatus = useRef(session.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = session.status;
    if (session.status === 'signedIn' && was !== 'signedIn') void recheck();
  }, [session.status, recheck]);

  // --- derived ----------------------------------------------------------------

  const dirtyDraft: DraftRecord | null =
    st.phase === 'ready' &&
    st.draftAt !== null &&
    (!st.base || st.text !== st.base.text)
      ? {
          v: 1,
          text: st.text,
          baseVersion: st.base?.version ?? null,
          savedAt: st.draftAt,
        }
      : null;
  const saveState = saveStateOf({
    signedIn: session.connected,
    hasFile: st.base !== null,
    draft: dirtyDraft,
    base: st.base,
    saving: st.saving || st.resolving,
    failed: st.failed,
    unconfirmed: st.unconfirmed,
  });

  return {
    phase: st.phase,
    decision: st.decision,
    ask: st.ask,
    opening: st.opening,
    openError: st.openError,
    answerOpen,
    editorKey: `${songId}:${st.editorKey}`,
    initialText: st.initialText,
    baseVersion: st.base?.version ?? null,
    text: st.text,
    onTextChange,
    saveState,
    dirty: isDirty(dirtyDraft, st.base),
    save,
    conflict: st.conflict,
    resolving: st.resolving,
    resolveConflict,
    cancelConflict,
    missing: st.missing,
    recreate,
    cancelMissing,
    unconfirmed:
      (st.phase === 'ready' || st.phase === 'unavailable') && st.unconfirmed,
    reconnect,
    reconnecting: st.reconnecting,
    reconnectError: st.reconnectError,
    unavailable: st.phase === 'unavailable' ? st.unavailable : null,
  };
}

// --- viewer -------------------------------------------------------------------

export interface SongView {
  phase: 'loading' | 'ready' | 'unavailable';
  text: string;
  /** Changes when `text` was replaced by Drive's newer version (Viewer key). */
  textKey: number;
  /**
   * 'draft': showing unsaved changes (「未保存の変更を含む表示です」);
   * 'updated': Drive had a newer version, now shown
   * (「Drive の新しい版を表示しています」).
   */
  notice: 'draft' | 'updated' | null;
  /**
   * Drive could not be checked (sign-in expired / offline): the text is the
   * copy this device read last time, or nothing could be opened
   * (m7-review.md R2). Offer `reconnect`.
   */
  unconfirmed: boolean;
  /** 「Drive に再接続」 — call in the click handler (may open the popup). */
  reconnect(): Promise<void>;
  reconnecting: boolean;
}

interface ViewState {
  phase: SongView['phase'];
  text: string;
  textKey: number;
  notice: SongView['notice'];
  /** fileId to check on Drive now (null: no check pending). */
  check: string | null;
  fileId: string | null;
  unconfirmed: boolean;
  reconnecting: boolean;
}

/**
 * The viewer opened from the list / a URL. Never writes a draft. Unsaved
 * changes → the draft (no Drive check). Otherwise the cached base at once,
 * then ONE Drive check (signed in): a newer version replaces it. No cached
 * text → download (signed in) or 'unavailable'. Signed in but expired, or
 * the check failed → `unconfirmed`; signing in again checks.
 */
export function useSongView(session: DriveSession, songId: string): SongView {
  const { storage, client } = session;
  const signedIn = session.status === 'signedIn';
  const init = (): ViewState => {
    const draft = loadDraftRecord(storage, songId);
    const base = loadBase(storage, songId);
    const entry = findEntry(storage, songId);
    const fileId = (entry ? entry.fileId : base?.fileId) ?? null;
    const none = {
      textKey: 0,
      notice: null,
      check: null,
      fileId,
      unconfirmed: false,
      reconnecting: false,
    };
    if (draft && isDirty(draft, base)) {
      return { ...none, phase: 'ready', text: draft.text, notice: 'draft' };
    }
    if (base) {
      return {
        ...none,
        phase: 'ready',
        text: base.text,
        check: signedIn && fileId ? fileId : null,
        unconfirmed: !signedIn && session.connected && fileId !== null,
      };
    }
    if (signedIn && fileId)
      return { ...none, phase: 'loading', text: '', check: fileId };
    return {
      ...none,
      phase: 'unavailable',
      text: '',
      unconfirmed: session.connected && fileId !== null,
    };
  };
  const [state, setState] = useState(init);

  const checkId = state.check;
  useEffect(() => {
    if (!checkId) return;
    let cancelled = false;
    const run = async () => {
      const base = loadBase(storage, songId);
      try {
        if (base) {
          const meta = await client.getMeta(checkId);
          if (cancelled || meta.version === base.version) {
            if (!cancelled)
              setState((s) => ({ ...s, check: null, unconfirmed: false }));
            return;
          }
        }
        const r = await loadRemote(client, checkId);
        if (cancelled) return;
        // Not dirty (checked when opening): a stale equal draft can go.
        const draft = loadDraftRecord(storage, songId);
        if (draft && !isDirty(draft, base)) removeDraft(storage, songId);
        storeRemote(storage, songId, r.meta, r.text);
        setState((s) => ({
          ...s,
          phase: 'ready',
          text: r.text,
          textKey: s.textKey + 1,
          notice: s.phase === 'ready' ? 'updated' : null,
          check: null,
          unconfirmed: false,
        }));
      } catch (e) {
        if (cancelled) return;
        const gone = isDriveError(e) && e.kind === 'notFound';
        setState((s) => ({
          ...s,
          phase: s.phase === 'loading' ? 'unavailable' : s.phase,
          check: null,
          unconfirmed: !gone,
        }));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [checkId, storage, songId, client]);

  /** Check Drive again (signed in now); not for the draft view. */
  const startCheck = useCallback(() => {
    setState((s) =>
      s.notice === 'draft' || !s.fileId || s.check
        ? s
        : {
            ...s,
            phase: s.phase === 'unavailable' ? 'loading' : s.phase,
            check: s.fileId,
          },
    );
  }, []);

  const reconnect = useCallback((): Promise<void> => {
    // In the click handler: may open the GIS popup.
    const token = session.ensureToken();
    setState((s) => ({ ...s, reconnecting: true }));
    return token.then(
      () => {
        setState((s) => ({ ...s, reconnecting: false }));
        startCheck();
      },
      () => setState((s) => ({ ...s, reconnecting: false })),
    );
  }, [session, startCheck]);

  // Signed in again some other way: check (once per sign-in).
  const prevStatus = useRef(session.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = session.status;
    if (
      session.status === 'signedIn' &&
      was !== 'signedIn' &&
      state.unconfirmed
    )
      startCheck();
  }, [session.status, state.unconfirmed, startCheck]);

  return {
    phase: state.phase,
    text: state.text,
    textKey: state.textKey,
    notice: state.notice,
    unconfirmed: state.unconfirmed,
    reconnect,
    reconnecting: state.reconnecting,
  };
}
