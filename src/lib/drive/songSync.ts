/**
 * Song-level Drive operations (docs/m7-plan.md, decisions 2–4): the app
 * folder, listing, loading, and saving with conflict detection.
 *
 * Conflict detection is "check the version, then write" (Drive v3 has no
 * conditional update, docs/m7-drive-findings.md §3):
 *   1. `getMeta` (ALWAYS first: trashed files still answer `download` /
 *      `update`, only `getMeta` reports them as notFound);
 *   2. version === base.version → write;
 *   3. otherwise download the remote text; if it equals `base.text` (only the
 *      version moved: rename, metadata, identical save elsewhere) or already
 *      equals the text being saved → write;
 *   4. otherwise → `conflict` (the caller shows ConflictDialog).
 * ACCEPTED RACE: another device can write between step 1/3 and the write
 * (a few hundred ms). Single user, the tablet never edits — accepted, listed
 * for the T20 review.
 *
 * Step 3 downloads instead of comparing `md5Checksum` (available for
 * text/plain, findings §13): it only runs when the version moved, a song is a
 * few KB, `DriveFileMeta`/`getMeta` would need a new field (T2's files), and
 * we need the remote text anyway for the conflict dialog's changed-line count
 * and for "reload" — so the checksum would save almost nothing.
 *
 * Every function rejects with a `DriveError` only (non-Drive exceptions are
 * mapped: TypeError from fetch → network, anything else → other). A rejected
 * save never touches local storage — the caller keeps the draft.
 */

import { copyTitle, fileNameForTitle, localCopyTitle } from '../fileName';
import { parseSong } from '../parseSong';
import { withTitle } from '../draftState';
import type {
  BaseRecord,
  ConflictChoice,
  DriveErrorKind,
  DriveFileMeta,
} from '../syncTypes';
import { DriveError, isDriveError, type DriveClient } from './driveClient';

export const FOLDER_NAME = 'band-sheets';
const APP = 'band-sheets';
const FORMAT = '1';
const UNTITLED = '無題の曲';

/** The kind of any error thrown by a Drive call (for the UI's messages). */
export function driveErrorKind(e: unknown): DriveErrorKind {
  if (isDriveError(e)) return e.kind;
  // fetch() rejects with a TypeError when offline / the request can't be sent
  if (e instanceof TypeError) return 'network';
  return 'other';
}

function asDriveError(e: unknown): DriveError {
  if (isDriveError(e)) return e;
  return new DriveError(
    driveErrorKind(e),
    undefined,
    e instanceof Error ? e.message : String(e),
  );
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw asDriveError(e);
  }
}

const isNotFound = (e: unknown) => isDriveError(e) && e.kind === 'notFound';

/** `getMeta`, but a missing/trashed file is `null` instead of an error. */
async function metaOrNull(
  c: DriveClient,
  fileId: string,
): Promise<DriveFileMeta | null> {
  try {
    return await c.getMeta(fileId);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function titleOf(text: string): string {
  return parseSong(text).meta.title.trim();
}

function songProperties(songId: string, device: string) {
  return { app: APP, songId, device, format: FORMAT };
}

/** BaseRecord for a file just read from Drive (device = who saved it last). */
export function baseFromRemote(meta: DriveFileMeta, text: string): BaseRecord {
  const device = meta.appProperties?.device;
  return {
    fileId: meta.id,
    version: meta.version,
    modifiedTime: meta.modifiedTime,
    ...(device !== undefined ? { device } : {}),
    text,
  };
}

function baseFromWrite(
  meta: DriveFileMeta,
  text: string,
  device: string,
): BaseRecord {
  return {
    fileId: meta.id,
    version: meta.version,
    modifiedTime: meta.modifiedTime,
    device,
    text,
  };
}

/**
 * The app folder's id. A cached id is reused while `getMeta` still finds it
 * (missing or trashed → search again). Otherwise the oldest visible
 * "band-sheets" folder under My Drive, or a new one. After creating, search
 * once more so two devices that both created a folder converge on the oldest.
 */
export function ensureFolder(
  c: DriveClient,
  cachedId?: string,
): Promise<string> {
  return guard(async () => {
    if (cachedId) {
      const meta = await metaOrNull(c, cachedId);
      if (meta) return meta.id;
    }
    const found = await c.findFolder(FOLDER_NAME);
    if (found) return found.id;
    const created = await c.createFolder(FOLDER_NAME, {
      app: APP,
      role: 'root',
    });
    const oldest = await c.findFolder(FOLDER_NAME);
    return oldest?.id ?? created.id;
  });
}

/** Every song file in the folder (Drive order; sorting is the caller's). */
export function fetchList(
  c: DriveClient,
  folderId: string,
): Promise<DriveFileMeta[]> {
  return guard(() => c.listFiles(folderId));
}

/**
 * Current meta + text. Meta is read FIRST: if another device saves in
 * between, we end up with an older version label on newer text, which the
 * next save resolves harmlessly (version differs → download → equals base).
 * The other order could label older text with the newer version and let a
 * later save silently overwrite the other device's change.
 * A trashed or missing file rejects with notFound.
 */
export function loadRemote(
  c: DriveClient,
  fileId: string,
): Promise<{ meta: DriveFileMeta; text: string }> {
  return guard(async () => {
    const meta = await c.getMeta(fileId);
    const text = await c.download(fileId);
    return { meta, text };
  });
}

/** New file `<title>.bandsheet` (text/plain) with songId/device properties. */
export function createSongFile(
  c: DriveClient,
  a: { songId: string; folderId: string; text: string; device: string },
): Promise<BaseRecord> {
  return guard(async () => {
    const meta = await c.create({
      folderId: a.folderId,
      name: fileNameForTitle(titleOf(a.text)),
      text: a.text,
      appProperties: songProperties(a.songId, a.device),
    });
    return baseFromWrite(meta, a.text, a.device);
  });
}

export type SaveResult =
  | { kind: 'saved'; base: BaseRecord }
  /**
   * The base's file is gone (trashed, deleted, or no longer visible to the
   * app — e.g. its drive.file grant was removed). Nothing was written; ask
   * the user, then call again with `recreate` (m7-review.md R14).
   */
  | { kind: 'missing' }
  | {
      kind: 'conflict';
      remote: DriveFileMeta;
      remoteText: string;
      /** Lines that differ between Drive's text and ours (for the dialog). */
      changedLines: number;
    };

/**
 * Saves `text` (file name follows the title). No base → create. File gone or
 * trashed → `missing` (nothing written), or with `recreate` a new file for
 * the same songId. See the module comment for the conflict check; `force`
 * skips it (ConflictDialog's 上書きする).
 */
export function saveSong(
  c: DriveClient,
  a: {
    songId: string;
    folderId: string;
    text: string;
    base: BaseRecord | null;
    device: string;
    force?: boolean;
    /** The user confirmed: create a new file when the old one is gone. */
    recreate?: boolean;
  },
): Promise<SaveResult> {
  return guard(async () => {
    const { base } = a;
    if (base === null) {
      return { kind: 'saved', base: await createSongFile(c, a) };
    }
    const meta = await metaOrNull(c, base.fileId);
    if (meta === null) {
      if (!a.recreate) return { kind: 'missing' };
      return { kind: 'saved', base: await createSongFile(c, a) };
    }
    if (!a.force && meta.version !== base.version) {
      const remoteText = await c.download(base.fileId);
      if (remoteText !== base.text && remoteText !== a.text) {
        return {
          kind: 'conflict',
          remote: meta,
          remoteText,
          changedLines: countChangedLines(remoteText, a.text),
        };
      }
    }
    const written = await c.update(base.fileId, {
      name: fileNameForTitle(titleOf(a.text)),
      text: a.text,
      appProperties: songProperties(a.songId, a.device),
    });
    return { kind: 'saved', base: baseFromWrite(written, a.text, a.device) };
  });
}

export type ConflictResolution =
  | { kind: 'saved'; base: BaseRecord; copy?: undefined }
  | {
      kind: 'reloaded';
      /** Drive's latest version: the caller stores it and drops the draft. */
      base: BaseRecord;
      /** reloadKeepCopy: the local text, saved as a new song. */
      copy?: { songId: string; base: BaseRecord };
    };

/**
 * Carries out ConflictDialog's choice (キャンセル = don't call this).
 * - overwrite: `saveSong` with `force`.
 * - reloadKeepCopy: first create the local text as a new song titled
 *   `localCopyTitle(title, now)` (id `newId`), then load Drive's latest. If
 *   the copy fails, nothing is reloaded and the caller keeps the draft.
 *   `onCopy` is told about the copy as soon as it exists (so the caller can
 *   record it even if the reload then fails), and a retry passes it back as
 *   `copy` so no second copy is made (m7-review.md R7).
 * - overwrite on a file that has meanwhile gone: rejects with notFound.
 * - reloadDiscard: load Drive's latest; nothing is written.
 * Reload fetches the CURRENT remote (it may have moved again since the
 * conflict was detected).
 */
export function resolveConflict(
  c: DriveClient,
  a: {
    choice: ConflictChoice;
    songId: string;
    folderId: string;
    /** The local (draft) text. */
    text: string;
    base: BaseRecord;
    device: string;
    /** songId for the reloadKeepCopy copy. */
    newId: string;
    now: Date;
    /** reloadKeepCopy: a copy already made by an earlier (failed) attempt. */
    copy?: { songId: string; base: BaseRecord };
    onCopy?: (copy: { songId: string; base: BaseRecord }) => void;
  },
): Promise<ConflictResolution> {
  return guard(async () => {
    if (a.choice === 'overwrite') {
      const r = await saveSong(c, { ...a, force: true });
      if (r.kind === 'missing') throw new DriveError('notFound');
      if (r.kind !== 'saved') throw new DriveError('other'); // unreachable
      return { kind: 'saved', base: r.base };
    }
    let copy = a.choice === 'reloadKeepCopy' ? a.copy : undefined;
    if (a.choice === 'reloadKeepCopy' && !copy) {
      const title = localCopyTitle(titleOf(a.text) || UNTITLED, a.now);
      const base = await createSongFile(c, {
        songId: a.newId,
        folderId: a.folderId,
        text: withTitle(a.text, title),
        device: a.device,
      });
      copy = { songId: a.newId, base };
      a.onCopy?.(copy);
    }
    const remote = await loadRemote(c, a.base.fileId);
    return {
      kind: 'reloaded',
      base: baseFromRemote(remote.meta, remote.text),
      ...(copy ? { copy } : {}),
    };
  });
}

/**
 * 「名前を変える」 from the list: `{title:}` in base.text + file name, with
 * the same conflict check as a save. Only for songs without unsaved changes
 * (the list disables it otherwise), so base.text is the song's text.
 * A missing file rejects with notFound (never recreated by a rename).
 */
export async function renameSong(
  c: DriveClient,
  a: {
    songId: string;
    folderId: string;
    base: BaseRecord;
    title: string;
    device: string;
  },
): Promise<Exclude<SaveResult, { kind: 'missing' }>> {
  const r = await saveSong(c, {
    songId: a.songId,
    folderId: a.folderId,
    text: withTitle(a.base.text, a.title),
    base: a.base,
    device: a.device,
  });
  if (r.kind === 'missing') throw new DriveError('notFound');
  return r;
}

/** 「複製する」: a new song 「<title> のコピー」 with id `newId`. */
export function duplicateSong(
  c: DriveClient,
  a: { folderId: string; text: string; device: string; newId: string },
): Promise<BaseRecord> {
  const title = copyTitle(titleOf(a.text) || UNTITLED);
  return createSongFile(c, {
    songId: a.newId,
    folderId: a.folderId,
    text: withTitle(a.text, title),
    device: a.device,
  });
}

/** Moves the file to the Drive trash; an already missing file is success. */
export function trashSong(c: DriveClient, fileId: string): Promise<void> {
  return guard(async () => {
    try {
      await c.trash(fileId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  });
}

function lines(text: string): string[] {
  const l = text.replace(/\r\n?/g, '\n').split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/**
 * Number of differing lines for ConflictDialog's 「N 行が違います」: line LCS,
 * then max(removed, added) so a modified line counts once.
 */
export function countChangedLines(a: string, b: string): number {
  const x = lines(a);
  const y = lines(b);
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] =
        x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[y.length];
  return Math.max(x.length - lcs, y.length - lcs);
}
