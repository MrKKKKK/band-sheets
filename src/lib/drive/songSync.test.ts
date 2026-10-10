import { describe, expect, it } from 'vitest';
import { parseSong } from '../parseSong';
import type { BaseRecord } from '../syncTypes';
import { DriveError } from './driveClient';
import { createFakeDriveClient, type FakeDriveClient } from './fakeDriveClient';
import {
  FOLDER_NAME,
  baseFromRemote,
  countChangedLines,
  createSongFile,
  driveErrorKind,
  duplicateSong,
  ensureFolder,
  fetchList,
  loadRemote,
  renameSong,
  resolveConflict,
  saveSong,
  trashSong,
} from './songSync';

const SONG = '{title: きらきら星}\n{key: C}\n\n[C]きらきら [G]ひかる\n';
const EDITED = '{title: きらきら星}\n{key: C}\n\n[C]きらきら [F]ひかる\n';
const REMOTE = '{title: きらきら星}\n{key: D}\n\n[D]きらきら [A]ひかる\n';

async function rejection(p: Promise<unknown>): Promise<DriveError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DriveError);
    return e as DriveError;
  }
  throw new Error('expected a rejection');
}

/** Fake Drive with the app folder and one saved song (base = what we saved). */
async function setup(): Promise<{
  c: FakeDriveClient;
  folderId: string;
  base: BaseRecord;
}> {
  const c = createFakeDriveClient();
  const folderId = await ensureFolder(c);
  const base = await createSongFile(c, {
    songId: 'song-1',
    folderId,
    text: SONG,
    device: 'Windows PC',
  });
  c.calls.length = 0;
  return { c, folderId, base };
}

const titleOf = (text: string) => parseSong(text).meta.title;

describe('ensureFolder', () => {
  it('creates the folder with app properties when none exists', async () => {
    const c = createFakeDriveClient();
    const id = await ensureFolder(c);
    const folders = c.folders();
    expect(folders).toHaveLength(1);
    expect(folders[0].meta).toMatchObject({
      id,
      name: FOLDER_NAME,
      appProperties: { app: 'band-sheets', role: 'root' },
    });
    expect(folders[0].parents).toEqual(['root']);
  });

  it('reuses an existing folder instead of creating one', async () => {
    const c = createFakeDriveClient();
    const first = await ensureFolder(c);
    expect(await ensureFolder(c)).toBe(first);
    expect(c.folders()).toHaveLength(1);
  });

  it('trusts a cached id that still exists without searching', async () => {
    const c = createFakeDriveClient();
    const id = await ensureFolder(c);
    c.calls.length = 0;
    expect(await ensureFolder(c, id)).toBe(id);
    expect(c.calls).toEqual([`getMeta:${id}`]);
  });

  it('searches again when the cached folder was trashed', async () => {
    const c = createFakeDriveClient({
      files: [
        {
          meta: { id: 'old', name: FOLDER_NAME },
          text: '',
          folder: true,
          trashed: true,
        },
        { meta: { id: 'live', name: FOLDER_NAME }, text: '', folder: true },
      ],
    });
    expect(await ensureFolder(c, 'old')).toBe('live');
  });

  it('searches again (and creates) when the cached folder is gone', async () => {
    const c = createFakeDriveClient();
    const id = await ensureFolder(c, 'missing');
    expect(id).not.toBe('missing');
    expect(c.folders()).toHaveLength(1);
  });

  it('uses the oldest folder when two exist', async () => {
    const c = createFakeDriveClient({
      files: [
        { meta: { id: 'older', name: FOLDER_NAME }, text: '', folder: true },
        { meta: { id: 'newer', name: FOLDER_NAME }, text: '', folder: true },
      ],
    });
    expect(await ensureFolder(c)).toBe('older');
  });

  it('propagates errors other than notFound for the cached id', async () => {
    const c = createFakeDriveClient();
    const id = await ensureFolder(c);
    c.failNext('network');
    expect((await rejection(ensureFolder(c, id))).kind).toBe('network');
    expect(c.folders()).toHaveLength(1);
  });
});

describe('fetchList / loadRemote', () => {
  it('lists the folder contents', async () => {
    const { c, folderId, base } = await setup();
    const list = await fetchList(c, folderId);
    expect(list.map((f) => f.id)).toEqual([base.fileId]);
    expect(list[0].appProperties).toMatchObject({ songId: 'song-1' });
  });

  it('loads meta then text (meta first, so the version is never newer than the text)', async () => {
    const { c, base } = await setup();
    const r = await loadRemote(c, base.fileId);
    expect(r.text).toBe(SONG);
    expect(r.meta.version).toBe(base.version);
    expect(c.calls).toEqual([
      `getMeta:${base.fileId}`,
      `download:${base.fileId}`,
    ]);
  });

  it('treats a trashed file as notFound', async () => {
    const { c, base } = await setup();
    await c.trash(base.fileId);
    expect((await rejection(loadRemote(c, base.fileId))).kind).toBe('notFound');
  });

  it('baseFromRemote takes the device from appProperties', async () => {
    const { c, base } = await setup();
    const r = await loadRemote(c, base.fileId);
    expect(baseFromRemote(r.meta, r.text)).toEqual(base);
  });
});

describe('createSongFile', () => {
  it('creates <title>.bandsheet with songId/device app properties', async () => {
    const { c, folderId, base } = await setup();
    const file = c.files().find((f) => f.meta.id === base.fileId)!;
    expect(file.meta.name).toBe('きらきら星.bandsheet');
    expect(file.meta.appProperties).toEqual({
      app: 'band-sheets',
      songId: 'song-1',
      device: 'Windows PC',
      format: '1',
    });
    expect(file.text).toBe(SONG);
    expect(base).toEqual({
      fileId: file.meta.id,
      version: file.meta.version,
      modifiedTime: file.meta.modifiedTime,
      device: 'Windows PC',
      text: SONG,
    });
    expect(folderId).toBeTruthy();
  });

  it('names an untitled song 無題の曲.bandsheet', async () => {
    const { c, folderId } = await setup();
    await createSongFile(c, {
      songId: 's2',
      folderId,
      text: '[C]la\n',
      device: 'PC',
    });
    expect(c.files()[1].meta.name).toBe('無題の曲.bandsheet');
  });
});

describe('saveSong', () => {
  it('creates the file when there is no base', async () => {
    const { c, folderId } = await setup();
    const r = await saveSong(c, {
      songId: 'new-song',
      folderId,
      text: SONG,
      base: null,
      device: 'PC',
    });
    expect(r.kind).toBe('saved');
    expect(c.files()).toHaveLength(2);
    expect(c.files()[1].meta.appProperties?.songId).toBe('new-song');
  });

  it('writes when Drive is still at the base version', async () => {
    const { c, folderId, base } = await setup();
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'iPad',
    });
    expect(r.kind).toBe('saved');
    if (r.kind !== 'saved') return;
    expect(c.calls).toEqual([
      `getMeta:${base.fileId}`,
      `update:${base.fileId}`,
    ]);
    const file = c.files()[0];
    expect(file.text).toBe(EDITED);
    expect(file.meta.appProperties?.device).toBe('iPad');
    expect(r.base).toEqual({
      fileId: base.fileId,
      version: file.meta.version,
      modifiedTime: file.meta.modifiedTime,
      device: 'iPad',
      text: EDITED,
    });
    expect(r.base.version).not.toBe(base.version);
  });

  it('renames the file when the title changed', async () => {
    const { c, folderId, base } = await setup();
    await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: SONG.replace('きらきら星', 'かえるの歌'),
      base,
      device: 'PC',
    });
    expect(c.files()[0].meta.name).toBe('かえるの歌.bandsheet');
  });

  it('writes when only the version moved but the content is the same', async () => {
    const { c, folderId, base } = await setup();
    // e.g. another device saved identical text / Drive touched metadata
    c.externalUpdate(base.fileId, SONG, 'iPad');
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
    });
    expect(r.kind).toBe('saved');
    expect(c.calls).toEqual([
      `getMeta:${base.fileId}`,
      `download:${base.fileId}`,
      `update:${base.fileId}`,
    ]);
    expect(c.files()[0].text).toBe(EDITED);
  });

  it('writes when Drive already holds exactly the text being saved', async () => {
    const { c, folderId, base } = await setup();
    c.externalUpdate(base.fileId, EDITED, 'iPad');
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
    });
    expect(r.kind).toBe('saved');
  });

  it('reports a conflict (and writes nothing) when another device saved different text', async () => {
    const { c, folderId, base } = await setup();
    c.externalUpdate(base.fileId, REMOTE, 'iPad');
    const before = c.files()[0];
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
    });
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') return;
    expect(r.remote).toEqual(before.meta);
    expect(r.remote.appProperties?.device).toBe('iPad');
    expect(r.remoteText).toBe(REMOTE);
    expect(r.changedLines).toBe(2);
    expect(c.files()[0]).toEqual(before);
    expect(c.calls.some((x) => x.startsWith('update'))).toBe(false);
  });

  it('force overwrites despite a moved version', async () => {
    const { c, folderId, base } = await setup();
    c.externalUpdate(base.fileId, REMOTE, 'iPad');
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      force: true,
    });
    expect(r.kind).toBe('saved');
    expect(c.files()[0].text).toBe(EDITED);
    expect(c.calls).not.toContain(`download:${base.fileId}`);
  });

  it('trashed file → missing, nothing written (R14)', async () => {
    const { c, folderId, base } = await setup();
    await c.trash(base.fileId);
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
    });
    expect(r).toEqual({ kind: 'missing' });
    expect(c.files()).toHaveLength(1);
    expect(c.calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('missing even with force (overwrite never recreates on its own)', async () => {
    const { c, folderId, base } = await setup();
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base: { ...base, fileId: 'deleted' },
      device: 'PC',
      force: true,
    });
    expect(r).toEqual({ kind: 'missing' });
    expect(c.files()).toHaveLength(1);
  });

  it('recreate: creates a new file when the old one was trashed', async () => {
    const { c, folderId, base } = await setup();
    await c.trash(base.fileId);
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      recreate: true,
    });
    expect(r.kind).toBe('saved');
    if (r.kind !== 'saved') return;
    expect(r.base.fileId).not.toBe(base.fileId);
    const live = c.files().filter((f) => !f.trashed);
    expect(live).toHaveLength(1);
    expect(live[0].text).toBe(EDITED);
    expect(live[0].meta.appProperties?.songId).toBe('song-1');
    // the trashed file is left untouched
    expect(c.files()[0].text).toBe(SONG);
  });

  it('recreate: creates a new file when the old one is gone, also with force', async () => {
    const { c, folderId, base } = await setup();
    const r = await saveSong(c, {
      songId: 'song-1',
      folderId,
      text: EDITED,
      base: { ...base, fileId: 'deleted' },
      device: 'PC',
      force: true,
      recreate: true,
    });
    expect(r.kind).toBe('saved');
    expect(c.files()).toHaveLength(2);
  });

  it.each(['network', 'auth', 'rateLimit', 'server'] as const)(
    'rejects with %s and writes nothing when the version check fails',
    async (kind) => {
      const { c, folderId, base } = await setup();
      c.failNext(kind, 2);
      const e = await rejection(
        saveSong(c, {
          songId: 'song-1',
          folderId,
          text: EDITED,
          base,
          device: 'PC',
        }),
      );
      expect(e.kind).toBe(kind);
      expect(c.files()[0].text).toBe(SONG);
    },
  );

  it('rejects when the write itself fails (caller keeps the draft)', async () => {
    const { c, folderId, base } = await setup();
    const realUpdate = c.update.bind(c);
    c.update = async () => {
      throw new DriveError('network');
    };
    const e = await rejection(
      saveSong(c, {
        songId: 'song-1',
        folderId,
        text: EDITED,
        base,
        device: 'PC',
      }),
    );
    expect(e.kind).toBe('network');
    c.update = realUpdate;
    expect(c.files()[0].text).toBe(SONG);
  });

  it('maps non-Drive errors (fetch TypeError) to network', async () => {
    const { c, folderId, base } = await setup();
    c.getMeta = async () => {
      throw new TypeError('Failed to fetch');
    };
    const e = await rejection(
      saveSong(c, {
        songId: 'song-1',
        folderId,
        text: EDITED,
        base,
        device: 'PC',
      }),
    );
    expect(e.kind).toBe('network');
  });
});

describe('resolveConflict', () => {
  async function conflicted() {
    const s = await setup();
    s.c.externalUpdate(s.base.fileId, REMOTE, 'iPad');
    s.c.calls.length = 0;
    return s;
  }
  const at = new Date(2026, 9, 6, 15, 12);

  it('overwrite: writes the local text', async () => {
    const { c, folderId, base } = await conflicted();
    const r = await resolveConflict(c, {
      choice: 'overwrite',
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      newId: 'unused',
      now: at,
    });
    expect(r.kind).toBe('saved');
    expect(r.base.text).toBe(EDITED);
    expect(c.files()[0].text).toBe(EDITED);
    expect(r.copy).toBeUndefined();
  });

  it('reloadDiscard: returns the latest Drive version, writes nothing', async () => {
    const { c, folderId, base } = await conflicted();
    const r = await resolveConflict(c, {
      choice: 'reloadDiscard',
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      newId: 'unused',
      now: at,
    });
    expect(r.kind).toBe('reloaded');
    expect(r.base.text).toBe(REMOTE);
    expect(r.base.device).toBe('iPad');
    expect(r.base.version).toBe(c.files()[0].meta.version);
    expect(c.files()).toHaveLength(1);
    expect(c.files()[0].text).toBe(REMOTE);
  });

  it('reloadKeepCopy: saves the local text as a new song, then reloads', async () => {
    const { c, folderId, base } = await conflicted();
    const r = await resolveConflict(c, {
      choice: 'reloadKeepCopy',
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      newId: 'song-copy',
      now: at,
    });
    expect(r.kind).toBe('reloaded');
    expect(r.base.text).toBe(REMOTE);
    expect(r.copy?.songId).toBe('song-copy');
    const copy = c.files()[1];
    expect(copy.meta.appProperties?.songId).toBe('song-copy');
    expect(copy.meta.name).toBe('きらきら星（手元の版 10_6 15_12）.bandsheet');
    expect(titleOf(copy.text)).toBe('きらきら星（手元の版 10/6 15:12）');
    expect(r.copy?.base.text).toBe(copy.text);
    expect(r.copy?.base.fileId).toBe(copy.meta.id);
    expect(c.files()[0].text).toBe(REMOTE);
  });

  it('reloadKeepCopy: fails without reloading when the copy cannot be created', async () => {
    const { c, folderId, base } = await conflicted();
    c.failNext('network');
    const e = await rejection(
      resolveConflict(c, {
        choice: 'reloadKeepCopy',
        songId: 'song-1',
        folderId,
        text: EDITED,
        base,
        device: 'PC',
        newId: 'song-copy',
        now: at,
      }),
    );
    expect(e.kind).toBe('network');
    expect(c.files()).toHaveLength(1);
  });

  it('reloadKeepCopy: a retry after a failed reload reuses the copy (R7)', async () => {
    const { c, folderId, base } = await conflicted();
    let made: { songId: string; base: BaseRecord } | undefined;
    const args = {
      choice: 'reloadKeepCopy' as const,
      songId: 'song-1',
      folderId,
      text: EDITED,
      base,
      device: 'PC',
      now: at,
    };
    const e = await rejection(
      resolveConflict(c, {
        ...args,
        newId: 'song-copy',
        onCopy: (copy) => {
          made = copy;
          c.failNext('network'); // the reload after the copy fails
        },
      }),
    );
    expect(e.kind).toBe('network');
    expect(made?.songId).toBe('song-copy');
    expect(c.files()).toHaveLength(2);
    const r = await resolveConflict(c, {
      ...args,
      newId: 'song-copy-2',
      copy: made,
    });
    expect(r.kind).toBe('reloaded');
    expect(r.copy?.songId).toBe('song-copy');
    expect(c.files()).toHaveLength(2); // no second copy
    expect(r.base.text).toBe(REMOTE);
  });

  it('overwrite when the file has meanwhile gone → notFound, nothing created', async () => {
    const { c, folderId, base } = await conflicted();
    await c.trash(base.fileId);
    const e = await rejection(
      resolveConflict(c, {
        choice: 'overwrite',
        songId: 'song-1',
        folderId,
        text: EDITED,
        base,
        device: 'PC',
        newId: 'unused',
        now: at,
      }),
    );
    expect(e.kind).toBe('notFound');
    expect(c.files()).toHaveLength(1);
  });
});

describe('renameSong', () => {
  it('a missing file rejects with notFound and is not recreated', async () => {
    const { c, folderId, base } = await setup();
    await c.trash(base.fileId);
    const e = await rejection(
      renameSong(c, {
        songId: 'song-1',
        folderId,
        base,
        title: '新しい名前',
        device: 'PC',
      }),
    );
    expect(e.kind).toBe('notFound');
    expect(c.files()).toHaveLength(1);
  });

  it('changes the title in the text and the file name', async () => {
    const { c, folderId, base } = await setup();
    const r = await renameSong(c, {
      songId: 'song-1',
      folderId,
      base,
      title: 'かえるの歌',
      device: 'PC',
    });
    expect(r.kind).toBe('saved');
    const f = c.files()[0];
    expect(f.meta.name).toBe('かえるの歌.bandsheet');
    expect(titleOf(f.text)).toBe('かえるの歌');
    expect(f.text).toContain('[C]きらきら [G]ひかる');
  });

  it('reports a conflict when Drive moved on with different text', async () => {
    const { c, folderId, base } = await setup();
    c.externalUpdate(base.fileId, REMOTE);
    const r = await renameSong(c, {
      songId: 'song-1',
      folderId,
      base,
      title: 'かえるの歌',
      device: 'PC',
    });
    expect(r.kind).toBe('conflict');
    expect(c.files()[0].text).toBe(REMOTE);
  });
});

describe('duplicateSong', () => {
  it('creates 「<title> のコピー」 as a new song', async () => {
    const { c, folderId } = await setup();
    const b = await duplicateSong(c, {
      folderId,
      text: SONG,
      device: 'PC',
      newId: 'dup',
    });
    const f = c.files()[1];
    expect(f.meta.name).toBe('きらきら星 のコピー.bandsheet');
    expect(f.meta.appProperties?.songId).toBe('dup');
    expect(titleOf(f.text)).toBe('きらきら星 のコピー');
    expect(b.fileId).toBe(f.meta.id);
    expect(b.text).toBe(f.text);
  });

  it('copies an untitled song as 「無題の曲 のコピー」', async () => {
    const { c, folderId } = await setup();
    const b = await duplicateSong(c, {
      folderId,
      text: '[C]la\n',
      device: 'PC',
      newId: 'dup',
    });
    expect(titleOf(b.text)).toBe('無題の曲 のコピー');
  });
});

describe('trashSong', () => {
  it('moves the file to the trash', async () => {
    const { c, base } = await setup();
    await trashSong(c, base.fileId);
    expect(c.files()[0].trashed).toBe(true);
  });

  it('treats an already missing file as success', async () => {
    const { c } = await setup();
    await expect(trashSong(c, 'missing')).resolves.toBeUndefined();
  });

  it('rejects other errors', async () => {
    const { c, base } = await setup();
    c.failNext('auth');
    expect((await rejection(trashSong(c, base.fileId))).kind).toBe('auth');
  });
});

describe('countChangedLines', () => {
  it('counts nothing for equal text', () => {
    expect(countChangedLines('a\nb\n', 'a\nb\n')).toBe(0);
  });
  it('counts a modified line once', () => {
    expect(countChangedLines('a\nb\nc', 'a\nX\nc')).toBe(1);
  });
  it('counts insertions and deletions', () => {
    expect(countChangedLines('a\nb', 'a\nb\nc\nd')).toBe(2);
    expect(countChangedLines('a\nb\nc', 'c')).toBe(2);
  });
  it('ignores CRLF vs LF and a trailing newline', () => {
    expect(countChangedLines('a\r\nb\r\n', 'a\nb')).toBe(0);
  });
});

describe('driveErrorKind', () => {
  it('maps errors to kinds', () => {
    expect(driveErrorKind(new DriveError('auth', 401))).toBe('auth');
    expect(driveErrorKind(new TypeError('Failed to fetch'))).toBe('network');
    expect(driveErrorKind(new Error('x'))).toBe('other');
  });
});
