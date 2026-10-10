/**
 * The Drive operations band-sheets needs (docs/m7-plan.md, decision 2), behind
 * an interface so tests never talk to Google: `createFetchDriveClient`
 * (fetchDriveClient.ts) is the real one, `createFakeDriveClient`
 * (fakeDriveClient.ts) an in-memory Drive for tests and stories.
 * Findings behind these semantics: docs/m7-drive-findings.md.
 */

import type { DriveErrorKind, DriveFileMeta } from '../syncTypes';

export class DriveError extends Error {
  kind: DriveErrorKind;
  status?: number;

  constructor(kind: DriveErrorKind, status?: number, message?: string) {
    super(message ?? `Drive error: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
  }
}

export function isDriveError(e: unknown): e is DriveError {
  return e instanceof DriveError;
}

export interface DriveClient {
  /**
   * The non-trashed folder with this exact name directly under My Drive that
   * this app can see (drive.file: only folders the app created). When there
   * are several, the oldest (by createdTime) wins.
   */
  findFolder(name: string): Promise<DriveFileMeta | null>;
  /** Creates a folder directly under My Drive. */
  createFolder(
    name: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFileMeta>;
  /** Non-trashed, non-folder children of the folder; follows every page. */
  listFiles(folderId: string): Promise<DriveFileMeta[]>;
  /** Throws `notFound` for a missing file and for a trashed one. */
  getMeta(fileId: string): Promise<DriveFileMeta>;
  /** File content as UTF-8 text. */
  download(fileId: string): Promise<string>;
  /** New `text/plain` file in the folder; returns the new version. */
  create(a: {
    folderId: string;
    name: string;
    text: string;
    appProperties: Record<string, string>;
  }): Promise<DriveFileMeta>;
  /**
   * Replaces name and content in one request; `appProperties` keys are merged
   * into the existing ones (Drive semantics). Unconditional: Drive v3 has no
   * "only if still at version X" update — callers check `getMeta` first.
   */
  update(
    fileId: string,
    a: { name: string; text: string; appProperties: Record<string, string> },
  ): Promise<DriveFileMeta>;
  /** Moves the file to the Drive trash (restorable for 30 days). */
  trash(fileId: string): Promise<void>;
}

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SONG_MIME_TYPE = 'text/plain';
