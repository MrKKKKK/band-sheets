/**
 * In-memory `DriveClient` for unit tests and stories (never talks to Google).
 * Mirrors the real Drive where callers can observe it
 * (docs/m7-drive-findings.md):
 * - `version` is a decimal string that grows on EVERY change (content, name,
 *   appProperties, trash) — callers may only compare it for equality.
 * - `modifiedTime` advances on content/name/appProperties changes (a fake
 *   clock: 1 s per change from 2026-10-06T00:00:00Z), not on trash.
 * - `update` merges `appProperties`; trashed files still answer `download`
 *   and `update` but `getMeta` says notFound and lists skip them. A file in a
 *   trashed folder counts as trashed.
 * - `findFolder` sees only folders directly under My Drive ('root'), oldest
 *   first.
 *
 * `calls` records `"<method>"` or `"<method>:<id>"` (id = fileId / folderId /
 * folder name) for every client method, including failed ones.
 */

import type { DriveErrorKind, DriveFileMeta } from '../syncTypes';
import { DriveError, type DriveClient } from './driveClient';

interface FakeFile {
  meta: DriveFileMeta;
  text: string;
  trashed: boolean;
  folder: boolean;
  parents: string[];
}

export interface FakeSeedFile {
  meta: Partial<DriveFileMeta>;
  text: string;
  parents?: string[];
  /** Seed a folder instead of a file (text is ignored). */
  folder?: boolean;
  trashed?: boolean;
}

export type FakeDriveClient = DriveClient & {
  /** 次の n 回の呼び出しを失敗させる */
  failNext(kind: DriveErrorKind, n?: number): void;
  /** 別の端末の保存をまねる（version を進める） */
  externalUpdate(fileId: string, text: string, device?: string): void;
  /** Non-folder files, in creation order (copies). */
  files(): { meta: DriveFileMeta; text: string; trashed: boolean }[];
  /** Folders, in creation order (copies). */
  folders(): { meta: DriveFileMeta; trashed: boolean; parents: string[] }[];
  calls: string[];
};

const STATUS: Record<DriveErrorKind, number | undefined> = {
  auth: 401,
  notFound: 404,
  rateLimit: 429,
  network: undefined,
  server: 500,
  other: 400,
};

const START = Date.parse('2026-10-06T00:00:00.000Z');

function copyMeta(m: DriveFileMeta): DriveFileMeta {
  const c: DriveFileMeta = { ...m };
  if (m.appProperties) c.appProperties = { ...m.appProperties };
  return c;
}

export function createFakeDriveClient(seed?: {
  files?: FakeSeedFile[];
}): FakeDriveClient {
  const store = new Map<string, FakeFile>();
  const calls: string[] = [];
  let failures: { kind: DriveErrorKind; left: number } | null = null;
  let tick = 0;
  let nextId = 1;

  const now = () => new Date(START + ++tick * 1000).toISOString();
  const newId = () => {
    let id: string;
    do id = `fake-file-${nextId++}`;
    while (store.has(id));
    return id;
  };
  const bump = (v: string) => String(Number(v) + 1);

  for (const s of seed?.files ?? []) {
    const id = s.meta.id ?? newId();
    store.set(id, {
      meta: {
        id,
        name: s.meta.name ?? 'untitled',
        version: s.meta.version ?? '1',
        modifiedTime: s.meta.modifiedTime ?? now(),
        ...(s.meta.appProperties
          ? { appProperties: { ...s.meta.appProperties } }
          : {}),
      },
      text: s.folder ? '' : s.text,
      trashed: s.trashed ?? false,
      folder: s.folder ?? false,
      parents: s.parents ?? ['root'],
    });
  }

  function isTrashed(f: FakeFile, seen = new Set<string>()): boolean {
    if (f.trashed) return true;
    return f.parents.some((p) => {
      const parent = store.get(p);
      if (!parent || seen.has(p)) return false;
      seen.add(p);
      return isTrashed(parent, seen);
    });
  }

  /** Records the call and throws an injected failure if one is pending. */
  function enter(call: string): void {
    calls.push(call);
    if (failures && failures.left > 0) {
      const { kind } = failures;
      failures.left -= 1;
      if (failures.left === 0) failures = null;
      throw new DriveError(kind, STATUS[kind], `Injected ${kind} failure`);
    }
  }

  function get(id: string): FakeFile {
    const f = store.get(id);
    if (!f) throw new DriveError('notFound', 404, `File not found: ${id}`);
    return f;
  }

  function write(
    f: FakeFile,
    a: { name?: string; text?: string; appProperties?: Record<string, string> },
  ): void {
    if (a.name !== undefined) f.meta.name = a.name;
    if (a.text !== undefined) f.text = a.text;
    if (a.appProperties) {
      f.meta.appProperties = { ...f.meta.appProperties, ...a.appProperties };
    }
    f.meta.version = bump(f.meta.version);
    f.meta.modifiedTime = now();
  }

  function add(f: Omit<FakeFile, 'meta'> & { name: string }, ap: object) {
    const id = newId();
    const file: FakeFile = {
      meta: {
        id,
        name: f.name,
        version: '1',
        modifiedTime: now(),
        appProperties: { ...(ap as Record<string, string>) },
      },
      text: f.text,
      trashed: false,
      folder: f.folder,
      parents: f.parents,
    };
    store.set(id, file);
    return copyMeta(file.meta);
  }

  const visible = (f: FakeFile) => !isTrashed(f);

  return {
    calls,

    failNext(kind, n = 1) {
      failures = n > 0 ? { kind, left: n } : null;
    },

    externalUpdate(fileId, text, device) {
      const f = get(fileId);
      write(f, { text, ...(device ? { appProperties: { device } } : {}) });
    },

    files() {
      return [...store.values()]
        .filter((f) => !f.folder)
        .map((f) => ({
          meta: copyMeta(f.meta),
          text: f.text,
          trashed: isTrashed(f),
        }));
    },

    folders() {
      return [...store.values()]
        .filter((f) => f.folder)
        .map((f) => ({
          meta: copyMeta(f.meta),
          trashed: isTrashed(f),
          parents: [...f.parents],
        }));
    },

    async findFolder(name) {
      enter(`findFolder:${name}`);
      const f = [...store.values()].find(
        (f) =>
          f.folder &&
          f.meta.name === name &&
          f.parents.includes('root') &&
          visible(f),
      );
      return f ? copyMeta(f.meta) : null;
    },

    async createFolder(name, appProperties) {
      enter(`createFolder:${name}`);
      return add(
        { name, text: '', trashed: false, folder: true, parents: ['root'] },
        appProperties,
      );
    },

    async listFiles(folderId) {
      enter(`listFiles:${folderId}`);
      return [...store.values()]
        .filter((f) => !f.folder && f.parents.includes(folderId) && visible(f))
        .map((f) => copyMeta(f.meta));
    },

    async getMeta(fileId) {
      enter(`getMeta:${fileId}`);
      const f = get(fileId);
      if (isTrashed(f)) {
        throw new DriveError('notFound', undefined, 'File is in the trash');
      }
      return copyMeta(f.meta);
    },

    async download(fileId) {
      enter(`download:${fileId}`);
      return get(fileId).text;
    },

    async create(a) {
      enter(`create:${a.folderId}`);
      const parent = store.get(a.folderId);
      if (!parent || !parent.folder) {
        throw new DriveError(
          'notFound',
          404,
          `Folder not found: ${a.folderId}`,
        );
      }
      return add(
        {
          name: a.name,
          text: a.text,
          trashed: false,
          folder: false,
          parents: [a.folderId],
        },
        a.appProperties,
      );
    },

    async update(fileId, a) {
      enter(`update:${fileId}`);
      const f = get(fileId);
      write(f, a);
      return copyMeta(f.meta);
    },

    async trash(fileId) {
      enter(`trash:${fileId}`);
      const f = get(fileId);
      f.trashed = true;
      f.meta.version = bump(f.meta.version);
    },
  };
}
