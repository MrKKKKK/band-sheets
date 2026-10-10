import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuthStatus } from '../lib/auth/gis';
import { createFakeAuth } from '../lib/auth/fakeAuth';
import {
  createFakeDriveClient,
  type FakeSeedFile,
} from '../lib/drive/fakeDriveClient';
import {
  baseKey,
  createMemoryStorage,
  draftKey,
  INDEX_KEY,
  loadBase,
  loadDraftRecord,
  loadIndex,
  saveDraftRecord,
  viewerSettingsKey,
} from '../lib/storage';
import type { SongEntry } from '../lib/syncTypes';
import { useDriveSession } from './useDriveSession';
import { notifyIndexChanged, useSongLibrary } from './useSongLibrary';

const FOLDER: FakeSeedFile = {
  meta: {
    id: 'folder',
    name: 'band-sheets',
    modifiedTime: '2026-10-01T00:00:00.000Z',
  },
  text: '',
  folder: true,
};

function songFile(
  id: string,
  songId: string,
  title: string,
  extra = '',
): FakeSeedFile {
  return {
    meta: {
      id,
      name: `${title}.bandsheet`,
      version: '5',
      modifiedTime: '2026-10-05T10:00:00.000Z',
      appProperties: {
        app: 'band-sheets',
        songId,
        device: 'iPad',
        format: '1',
      },
    },
    text: `{title: ${title}}\n{key: C}\n${extra}`,
    parents: ['folder'],
  };
}

const NOW = new Date('2026-10-06T12:00:00.000Z');

function setup(
  o: {
    status?: AuthStatus;
    files?: FakeSeedFile[];
    init?: Record<string, string>;
  } = {},
) {
  const auth = createFakeAuth(o.status ?? 'signedIn');
  const drive = createFakeDriveClient({ files: [FOLDER, ...(o.files ?? [])] });
  const storage = createMemoryStorage(o.init);
  let n = 0;
  const hook = renderHook(() => {
    const session = useDriveSession({
      auth,
      storage,
      client: drive,
      detectDevice: () => 'Windows PC',
    });
    return {
      session,
      lib: useSongLibrary(session, {
        now: () => NOW,
        newId: () => `new-${++n}`,
      }),
    };
  });
  return { auth, drive, storage, hook, lib: () => hook.result.current.lib };
}

const entry = (
  songId: string,
  title: string,
  extra: Partial<SongEntry> = {},
): SongEntry => ({
  songId,
  title,
  summary: '',
  parts: '',
  ...extra,
});

const draftJson = (
  text: string,
  baseVersion: string | null = null,
  savedAt = '2026-10-06T09:00:00.000Z',
) => JSON.stringify({ v: 1, text, baseVersion, savedAt });

const baseJson = (fileId: string, version: string, text: string) =>
  JSON.stringify({
    fileId,
    version,
    modifiedTime: '2026-10-05T10:00:00.000Z',
    text,
  });

describe('useSongLibrary: offline first', () => {
  it('shows the cached index at once, then the merged Drive list', async () => {
    const { lib, drive } = setup({
      files: [songFile('f1', 's1', 'きらきら星')],
      init: {
        [INDEX_KEY]: JSON.stringify({
          v: 1,
          folderId: 'folder',
          listedAt: '2026-10-05T00:00:00.000Z',
          songs: [
            entry('s1', 'きらきら星', { fileId: 'f1', version: '4' }),
            entry('gone', '消えた曲', { fileId: 'f9', version: '1' }),
          ],
        }),
      },
    });
    // cache first (no await yet)
    expect(lib().songs.map((e) => e.songId)).toEqual(['s1', 'gone']);
    expect(lib().listedAt).toBe('2026-10-05T00:00:00.000Z');
    await waitFor(() => expect(lib().refreshing).toBe(false));
    await waitFor(() =>
      expect(lib().songs.map((e) => e.songId)).toEqual(['s1']),
    );
    expect(lib().listedAt).toBe(NOW.toISOString());
    expect(lib().banner).toBeNull();
    expect(drive.calls).toContain('listFiles:folder');
  });

  it('backfills the text of songs without a current base', async () => {
    const { lib, storage } = setup({
      files: [songFile('f1', 's1', 'A曲'), songFile('f2', 's2', 'B曲')],
      init: {
        [baseKey('s2')]: baseJson('f2', '5', '{title: B曲}\n{key: C}\n'),
      },
    });
    await waitFor(() => expect(loadBase(storage, 's1')?.version).toBe('5'));
    const s1 = lib().songs.find((e) => e.songId === 's1')!;
    expect(s1.summary).toBe('C');
    expect(lib().cachedIds.has('s1')).toBe(true);
    expect(lib().statuses.s1).toBe('synced');
  });

  it('does not move the base under an unsaved draft', async () => {
    const { lib, storage, drive } = setup({
      files: [songFile('f1', 's1', 'A曲')],
      init: {
        [baseKey('s1')]: baseJson('f1', '3', 'old'),
        [draftKey('s1')]: draftJson('old edited', '3'),
      },
    });
    await waitFor(() => expect(lib().songs).toHaveLength(1));
    await waitFor(() => expect(lib().refreshing).toBe(false));
    expect(drive.calls).not.toContain('download:f1');
    expect(loadBase(storage, 's1')?.version).toBe('3');
    expect(lib().statuses.s1).toBe('driveNewer');
  });

  it('R3: a draft written during the download survives (same-as-base draft before)', async () => {
    const t = '{title: A曲}\n{key: C}\n';
    const { lib, storage, drive } = setup({
      files: [songFile('f1', 's1', 'A曲')],
      init: {
        [baseKey('s1')]: baseJson('f1', '3', t),
        [draftKey('s1')]: draftJson(t, '3'),
      },
    });
    const realDownload = drive.download.bind(drive);
    drive.download = async (...a: Parameters<typeof realDownload>) => {
      storage.setItem(draftKey('s1'), draftJson('typed meanwhile', '3', 'x'));
      return realDownload(...a);
    };
    await waitFor(() => expect(lib().songs).toHaveLength(1));
    await waitFor(() => expect(lib().refreshing).toBe(false));
    expect(loadDraftRecord(storage, 's1')?.text).toBe('typed meanwhile');
    expect(loadBase(storage, 's1')?.version).toBe('3');
  });

  it('keeps device-only songs with a draft, drops those without', async () => {
    const { lib } = setup({
      status: 'signedOut',
      init: {
        [INDEX_KEY]: JSON.stringify({
          v: 1,
          songs: [entry('l1', 'old title'), entry('l2', 'never edited')],
        }),
        [draftKey('l1')]: draftJson('{title: 新しい名前}\n{key: G}\n'),
      },
    });
    expect(lib().songs).toEqual([
      expect.objectContaining({
        songId: 'l1',
        title: '新しい名前',
        summary: 'G',
        modifiedTime: '2026-10-06T09:00:00.000Z',
      }),
    ]);
    expect(lib().statuses.l1).toBe('localOnly');
    expect(lib().cachedIds.has('l1')).toBe(true);
    expect(lib().banner).toBeNull();
  });

  it('keeps a vanished Drive song that has a draft as device-only', async () => {
    const { lib } = setup({
      init: {
        [INDEX_KEY]: JSON.stringify({
          v: 1,
          songs: [entry('s9', 'X', { fileId: 'f9', version: '1' })],
        }),
        [baseKey('s9')]: baseJson('f9', '1', 'x'),
        [draftKey('s9')]: draftJson('{title: X}\nchanged', '1'),
      },
    });
    await waitFor(() => expect(lib().listedAt).toBe(NOW.toISOString()));
    expect(lib().songs).toEqual([expect.objectContaining({ songId: 's9' })]);
    expect(lib().songs[0].fileId).toBeUndefined();
    expect(lib().statuses.s9).toBe('localOnly');
  });

  it('offline: keeps the cache and shows the offline banner', async () => {
    const auth = createFakeAuth('signedIn');
    const drive = createFakeDriveClient({ files: [FOLDER] });
    drive.failNext('network', 10);
    const storage = createMemoryStorage({
      [INDEX_KEY]: JSON.stringify({
        v: 1,
        listedAt: 'L',
        songs: [entry('s1', 'A', { fileId: 'f1' })],
      }),
    });
    const { result } = renderHook(() =>
      useSongLibrary(
        useDriveSession({
          auth,
          storage,
          client: drive,
          detectDevice: () => 'PC',
        }),
      ),
    );
    await waitFor(() => expect(result.current.banner).toBe('offline'));
    expect(result.current.refreshError).toBe('network');
    expect(result.current.songs.map((e) => e.songId)).toEqual(['s1']);
    expect(result.current.listedAt).toBe('L');
  });

  it('401: reconnect banner, token invalidated', async () => {
    const auth = createFakeAuth('signedIn');
    const drive = createFakeDriveClient({ files: [FOLDER] });
    drive.failNext('auth');
    const { result } = renderHook(() =>
      useSongLibrary(
        useDriveSession({
          auth,
          storage: createMemoryStorage(),
          client: drive,
          detectDevice: () => 'PC',
        }),
      ),
    );
    await waitFor(() => expect(result.current.banner).toBe('reconnect'));
    expect(auth.calls).toContain('invalidate');
    expect(auth.status()).toBe('expired');
  });

  it('expired at startup: no fetch until refresh, which asks for a token first', async () => {
    const { lib, drive, auth } = setup({
      status: 'expired',
      files: [songFile('f1', 's1', 'A')],
    });
    await act(async () => {});
    expect(drive.calls).toEqual([]);
    expect(lib().banner).toBe('reconnect');
    let p: Promise<boolean> | undefined;
    act(() => {
      p = lib().refresh();
    });
    // synchronously, before any await (GIS popup inside the click)
    expect(auth.calls).toEqual(['ensureToken']);
    await act(async () => {
      expect(await p).toBe(true);
    });
    expect(lib().banner).toBeNull();
    expect(lib().songs.map((e) => e.songId)).toEqual(['s1']);
  });

  it('refresh: a closed popup is an auth failure, nothing fetched', async () => {
    const { lib, drive, auth } = setup({ status: 'expired' });
    auth.failNext('popupClosed');
    await act(async () => {
      expect(await lib().refresh()).toBe(false);
    });
    expect(drive.calls).toEqual([]);
    expect(lib().refreshError).toBe('auth');
  });

  it('signed out: no fetch, no banner; unconfigured: unconfigured banner', async () => {
    const a = setup({ status: 'signedOut' });
    await act(async () => {});
    expect(a.drive.calls).toEqual([]);
    expect(a.lib().banner).toBeNull();
    const b = setup({ status: 'unconfigured' });
    expect(b.lib().banner).toBe('unconfigured');
    await act(async () => {
      expect(await b.lib().refresh()).toBe(false);
    });
  });

  it('signing in triggers a fetch', async () => {
    const { lib, auth, hook } = setup({
      status: 'signedOut',
      files: [songFile('f1', 's1', 'A')],
    });
    await act(async () => {
      await hook.result.current.session.signIn();
    });
    expect(auth.status()).toBe('signedIn');
    await waitFor(() =>
      expect(lib().songs.map((e) => e.songId)).toEqual(['s1']),
    );
  });

  it('reload re-reads statuses; index writes elsewhere are picked up', async () => {
    const { lib, storage } = setup({ files: [songFile('f1', 's1', 'A')] });
    await waitFor(() => expect(lib().statuses.s1).toBe('synced'));
    await waitFor(() => expect(lib().refreshing).toBe(false));
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: 'edited',
      baseVersion: '5',
      savedAt: 'x',
    });
    expect(lib().statuses.s1).toBe('synced');
    act(() => lib().reload());
    expect(lib().statuses.s1).toBe('dirty');
    const idx = loadIndex(storage);
    storage.setItem(
      INDEX_KEY,
      JSON.stringify({
        ...idx,
        songs: [...idx.songs, entry('x', 'X', { fileId: 'fx' })],
      }),
    );
    act(() => notifyIndexChanged(storage));
    expect(lib().songs.map((e) => e.songId)).toEqual(['s1', 'x']);
  });
});

describe('useSongLibrary: actions', () => {
  async function ready(
    files: FakeSeedFile[],
    init: Record<string, string> = {},
  ) {
    const t = setup({ files, init });
    await waitFor(() => expect(t.lib().refreshing).toBe(false));
    await waitFor(() =>
      expect(
        t
          .lib()
          .songs.every((e) => !e.fileId || t.lib().cachedIds.has(e.songId)),
      ).toBe(true),
    );
    return t;
  }

  it('newSongId stores nothing', async () => {
    const { lib, storage } = await ready([]);
    const before = new Map(storage.data);
    expect(lib().newSongId()).toBe('new-1');
    expect(storage.data).toEqual(before);
  });

  it('rename: file name and title on Drive, base and index updated', async () => {
    const { lib, drive, auth, storage } = await ready([
      songFile('f1', 's1', '旧名'),
    ]);
    expect(lib().canRename('s1')).toBe(true);
    auth.calls.length = 0;
    let p: Promise<unknown> | undefined;
    act(() => {
      p = lib().rename('s1', '新名');
    });
    expect(auth.calls).toEqual(['ensureToken']);
    expect(lib().busyId).toBe('s1');
    await act(async () => {
      expect(await p).toEqual({ ok: true, songId: 's1' });
    });
    expect(lib().busyId).toBeNull();
    const f = drive.files().find((x) => x.meta.id === 'f1')!;
    expect(f.meta.name).toBe('新名.bandsheet');
    expect(f.text).toContain('{title: 新名}');
    expect(loadBase(storage, 's1')?.version).toBe(f.meta.version);
    expect(lib().songs[0].title).toBe('新名');
  });

  it('rename is not allowed with unsaved changes or for device-only songs', async () => {
    const { lib, storage, drive } = await ready([songFile('f1', 's1', 'A')], {
      [INDEX_KEY]: JSON.stringify({ v: 1, songs: [entry('l1', 'L')] }),
      [draftKey('l1')]: draftJson('{title: L}'),
    });
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: 'changed',
      baseVersion: '5',
      savedAt: 'x',
    });
    expect(lib().canRename('s1')).toBe(false);
    expect(lib().canRename('l1')).toBe(false);
    await expect(lib().rename('s1', 'B')).resolves.toEqual({
      ok: false,
      reason: 'notAllowed',
    });
    await expect(lib().rename('l1', 'B')).resolves.toEqual({
      ok: false,
      reason: 'notAllowed',
    });
    expect(drive.calls.filter((c) => c.startsWith('update'))).toEqual([]);
  });

  it('rename: Drive changed meanwhile → conflict, base refreshed', async () => {
    const { lib, drive, storage } = await ready([songFile('f1', 's1', 'A')]);
    drive.externalUpdate('f1', '{title: A}\nfrom tablet\n', 'iPad');
    // the list still has the old version, so the base looks current
    const r = await act(() => lib().rename('s1', 'B'));
    expect(r).toEqual({ ok: false, reason: 'conflict' });
    expect(loadBase(storage, 's1')?.text).toBe('{title: A}\nfrom tablet\n');
    expect(drive.files()[0].meta.name).toBe('A.bandsheet');
  });

  it('rename: network failure', async () => {
    const { lib, drive } = await ready([songFile('f1', 's1', 'A')]);
    drive.failNext('network', 5);
    await expect(act(() => lib().rename('s1', 'B'))).resolves.toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('duplicate a Drive song: 「<曲名> のコピー」 on Drive', async () => {
    const { lib, drive, storage } = await ready([songFile('f1', 's1', 'A')]);
    const r = await act(() => lib().duplicate('s1'));
    expect(r).toEqual({ ok: true, songId: 'new-1' });
    const copy = drive.files().find((f) => f.meta.id !== 'f1')!;
    expect(copy.meta.name).toBe('A のコピー.bandsheet');
    expect(copy.meta.appProperties?.songId).toBe('new-1');
    expect(loadBase(storage, 'new-1')?.fileId).toBe(copy.meta.id);
    expect(lib().songs.map((e) => e.title)).toContain('A のコピー');
  });

  it('duplicate copies unsaved changes too', async () => {
    const { lib, drive, storage } = await ready([songFile('f1', 's1', 'A')]);
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: '{title: A}\nunsaved\n',
      baseVersion: '5',
      savedAt: 'x',
    });
    await act(() => lib().duplicate('s1'));
    const copy = drive.files().find((f) => f.meta.id !== 'f1')!;
    expect(copy.text).toContain('unsaved');
  });

  it('duplicate a device-only song: a device-only copy', async () => {
    const { lib, drive, storage } = await ready([], {
      [INDEX_KEY]: JSON.stringify({ v: 1, songs: [entry('l1', 'L')] }),
      [draftKey('l1')]: draftJson('{title: L}\n'),
    });
    const r = await act(() => lib().duplicate('l1'));
    expect(r).toEqual({ ok: true, songId: 'new-1' });
    expect(drive.calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(loadDraftRecord(storage, 'new-1')).toMatchObject({
      baseVersion: null,
      savedAt: NOW.toISOString(),
    });
    expect(loadDraftRecord(storage, 'new-1')?.text).toContain('L のコピー');
    expect(lib().statuses['new-1']).toBe('localOnly');
  });

  it('remove a Drive song: trash + local data gone', async () => {
    const { lib, drive, storage } = await ready([songFile('f1', 's1', 'A')], {
      [viewerSettingsKey('s1')]: '{}',
    });
    const r = await act(() => lib().remove('s1'));
    expect(r).toEqual({ ok: true });
    expect(drive.files()[0].trashed).toBe(true);
    expect(storage.data.has(baseKey('s1'))).toBe(false);
    expect(storage.data.has(viewerSettingsKey('s1'))).toBe(false);
    expect(lib().songs).toEqual([]);
  });

  it('remove keeps everything when the trash call fails', async () => {
    const { lib, drive, storage } = await ready([songFile('f1', 's1', 'A')]);
    drive.failNext('server', 3);
    await expect(act(() => lib().remove('s1'))).resolves.toEqual({
      ok: false,
      reason: 'other',
    });
    expect(storage.data.has(baseKey('s1'))).toBe(true);
    expect(lib().songs).toHaveLength(1);
  });

  it('remove a device-only song: no Drive call, draft gone', async () => {
    const { lib, drive, storage, auth } = await ready([], {
      [INDEX_KEY]: JSON.stringify({ v: 1, songs: [entry('l1', 'L')] }),
      [draftKey('l1')]: draftJson('{title: L}\n'),
    });
    auth.calls.length = 0;
    drive.calls.length = 0;
    await act(() => lib().remove('l1'));
    expect(drive.calls).toEqual([]);
    expect(auth.calls).toEqual([]);
    expect(storage.data.has(draftKey('l1'))).toBe(false);
    expect(lib().songs).toEqual([]);
  });

  it('unmounting during a fetch is harmless', async () => {
    const { hook, drive } = setup({ files: [songFile('f1', 's1', 'A')] });
    hook.unmount();
    await act(async () => {});
    expect(drive.calls.length).toBeLessThanOrEqual(1);
  });
});
