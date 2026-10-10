import { describe, expect, it } from 'vitest';
import { DriveError } from './driveClient';
import { createFakeDriveClient } from './fakeDriveClient';

async function rejection(p: Promise<unknown>): Promise<DriveError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DriveError);
    return e as DriveError;
  }
  throw new Error('expected a rejection');
}

async function withFolder() {
  const c = createFakeDriveClient();
  const folder = await c.createFolder('band-sheets', { app: 'band-sheets' });
  return { c, folder };
}

describe('createFakeDriveClient', () => {
  it('creates a folder and finds it under root', async () => {
    const { c, folder } = await withFolder();
    expect(folder.appProperties).toEqual({ app: 'band-sheets' });
    expect(await c.findFolder('band-sheets')).toEqual(folder);
    expect(await c.findFolder('other')).toBeNull();
    expect(c.folders()).toHaveLength(1);
    expect(c.files()).toEqual([]);
  });

  it('findFolder returns the oldest of two and skips trashed / non-root ones', async () => {
    const c = createFakeDriveClient({
      files: [
        {
          meta: { id: 'trashed', name: 'band-sheets' },
          text: '',
          folder: true,
          trashed: true,
        },
        {
          meta: { id: 'nested', name: 'band-sheets' },
          text: '',
          folder: true,
          parents: ['x'],
        },
        { meta: { id: 'old', name: 'band-sheets' }, text: '', folder: true },
        { meta: { id: 'new', name: 'band-sheets' }, text: '', folder: true },
      ],
    });
    expect((await c.findFolder('band-sheets'))?.id).toBe('old');
  });

  it('create returns version and modifiedTime, readable via getMeta/download', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A.bandsheet',
      text: '{title: A}\n',
      appProperties: { songId: 's1' },
    });
    expect(m.name).toBe('A.bandsheet');
    expect(m.version).toMatch(/^\d+$/);
    expect(Date.parse(m.modifiedTime)).not.toBeNaN();
    expect(await c.getMeta(m.id)).toEqual(m);
    expect(await c.download(m.id)).toBe('{title: A}\n');
    expect(await c.listFiles(folder.id)).toEqual([m]);
  });

  it('create into a missing folder is notFound', async () => {
    const c = createFakeDriveClient();
    const e = await rejection(
      c.create({ folderId: 'nope', name: 'n', text: '', appProperties: {} }),
    );
    expect(e.kind).toBe('notFound');
  });

  it('update changes name and text, merges appProperties, advances version and time', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 'one',
      appProperties: { songId: 's1', device: 'PC' },
    });
    const u = await c.update(m.id, {
      name: 'B',
      text: 'two',
      appProperties: { device: 'Mac' },
    });
    expect(u.name).toBe('B');
    expect(u.version).not.toBe(m.version);
    expect(Number(u.version)).toBeGreaterThan(Number(m.version));
    expect(u.modifiedTime > m.modifiedTime).toBe(true);
    expect(u.appProperties).toEqual({ songId: 's1', device: 'Mac' });
    expect(await c.download(m.id)).toBe('two');
  });

  it('update with the same text still bumps the version (every change does)', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: {},
    });
    const u = await c.update(m.id, { name: 'A', text: 't', appProperties: {} });
    expect(u.version).not.toBe(m.version);
  });

  it('update / download of a missing file is notFound', async () => {
    const c = createFakeDriveClient();
    expect((await rejection(c.download('x'))).kind).toBe('notFound');
    expect(
      (
        await rejection(
          c.update('x', { name: 'n', text: '', appProperties: {} }),
        )
      ).kind,
    ).toBe('notFound');
  });

  it('trash hides the file from getMeta and lists, bumps version but not modifiedTime', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: {},
    });
    await c.trash(m.id);
    expect((await rejection(c.getMeta(m.id))).kind).toBe('notFound');
    expect(await c.listFiles(folder.id)).toEqual([]);
    const [f] = c.files();
    expect(f.trashed).toBe(true);
    expect(f.meta.version).not.toBe(m.version);
    expect(f.meta.modifiedTime).toBe(m.modifiedTime);
    // like Drive, a trashed file's content is still readable
    expect(await c.download(m.id)).toBe('t');
  });

  it('a file in a trashed folder counts as trashed', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: {},
    });
    await c.trash(folder.id);
    expect((await rejection(c.getMeta(m.id))).kind).toBe('notFound');
    expect(await c.findFolder('band-sheets')).toBeNull();
    expect(c.files()[0].trashed).toBe(true);
  });

  it('listFiles skips folders and other folders’ files', async () => {
    const c = createFakeDriveClient({
      files: [
        { meta: { id: 'fold', name: 'band-sheets' }, text: '', folder: true },
        {
          meta: { id: 'sub', name: 'sub' },
          text: '',
          folder: true,
          parents: ['fold'],
        },
        { meta: { id: 'a', name: 'A' }, text: 'a', parents: ['fold'] },
        { meta: { id: 'b', name: 'B' }, text: 'b', parents: ['elsewhere'] },
      ],
    });
    expect((await c.listFiles('fold')).map((f) => f.id)).toEqual(['a']);
  });

  it('seeds files with defaults and given meta', async () => {
    const c = createFakeDriveClient({
      files: [
        {
          meta: {
            id: 'a',
            name: 'A',
            version: '41',
            appProperties: { songId: 'x' },
          },
          text: 'hello',
          parents: ['fold'],
        },
        { meta: {}, text: 'no id' },
      ],
    });
    const files = c.files();
    expect(files[0].meta).toMatchObject({ id: 'a', name: 'A', version: '41' });
    expect(files[0].meta.appProperties).toEqual({ songId: 'x' });
    expect(files[1].meta.id).toMatch(/^fake-file-/);
    expect(files[1].meta.version).toBe('1');
  });

  it('externalUpdate simulates another device saving', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 'mine',
      appProperties: { device: 'PC' },
    });
    c.externalUpdate(m.id, 'theirs', 'iPad');
    const now = await c.getMeta(m.id);
    expect(now.version).not.toBe(m.version);
    expect(now.modifiedTime > m.modifiedTime).toBe(true);
    expect(now.appProperties?.device).toBe('iPad');
    expect(await c.download(m.id)).toBe('theirs');
    c.externalUpdate(m.id, 'again');
    expect((await c.getMeta(m.id)).appProperties?.device).toBe('iPad');
  });

  it('failNext fails the next n calls of any method, then recovers', async () => {
    const { c, folder } = await withFolder();
    c.failNext('network', 2);
    expect((await rejection(c.listFiles(folder.id))).kind).toBe('network');
    const e = await rejection(c.findFolder('band-sheets'));
    expect(e.kind).toBe('network');
    expect(e.status).toBeUndefined();
    expect(await c.findFolder('band-sheets')).not.toBeNull();
  });

  it('failNext defaults to one call and sets HTTP-like statuses', async () => {
    const c = createFakeDriveClient();
    c.failNext('auth');
    const e = await rejection(c.findFolder('x'));
    expect(e.kind).toBe('auth');
    expect(e.status).toBe(401);
    expect(await c.findFolder('x')).toBeNull();
  });

  it('a failed update changes nothing', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: {},
    });
    c.failNext('server');
    await rejection(
      c.update(m.id, { name: 'B', text: 'u', appProperties: {} }),
    );
    expect(await c.getMeta(m.id)).toEqual(m);
  });

  it('records calls, including failed ones', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: {},
    });
    c.failNext('server');
    await rejection(c.getMeta(m.id));
    await c.download(m.id);
    await c.trash(m.id);
    expect(c.calls).toEqual([
      'createFolder:band-sheets',
      `create:${folder.id}`,
      `getMeta:${m.id}`,
      `download:${m.id}`,
      `trash:${m.id}`,
    ]);
  });

  it('returns copies, so callers cannot mutate the store', async () => {
    const { c, folder } = await withFolder();
    const m = await c.create({
      folderId: folder.id,
      name: 'A',
      text: 't',
      appProperties: { k: 'v' },
    });
    m.appProperties!.k = 'changed';
    m.version = '999';
    expect(await c.getMeta(m.id)).toMatchObject({ appProperties: { k: 'v' } });
    expect((await c.getMeta(m.id)).version).not.toBe('999');
  });
});
