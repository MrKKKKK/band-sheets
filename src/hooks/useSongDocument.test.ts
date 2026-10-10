import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement, useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { AuthStatus } from '../lib/auth/gis';
import { createFakeAuth } from '../lib/auth/fakeAuth';
import {
  createFakeDriveClient,
  type FakeSeedFile,
} from '../lib/drive/fakeDriveClient';
import { newSongText } from '../lib/serializeSong';
import {
  baseKey,
  createMemoryStorage,
  draftKey,
  INDEX_KEY,
  loadBase,
  loadDraftRecord,
  loadIndex,
  saveDraftRecord,
} from '../lib/storage';
import { useAutosave } from './useAutosave';
import { useDriveSession } from './useDriveSession';
import {
  useSongDocument,
  useSongView,
  type SongDocument,
} from './useSongDocument';

const FOLDER: FakeSeedFile = {
  meta: { id: 'folder', name: 'band-sheets' },
  text: '',
  folder: true,
};
const TEXT = '{title: きらきら星}\n{key: C}\nline1\nline2\n';
const FILE: FakeSeedFile = {
  meta: {
    id: 'f1',
    name: 'きらきら星.bandsheet',
    version: '5',
    modifiedTime: '2026-10-05T10:00:00.000Z',
    appProperties: {
      app: 'band-sheets',
      songId: 's1',
      device: 'iPad',
      format: '1',
    },
  },
  text: TEXT,
  parents: ['folder'],
};
const NOW = new Date('2026-10-06T06:12:00.000Z');

const indexJson = (fileId?: string) =>
  JSON.stringify({
    v: 1,
    folderId: 'folder',
    songs: [
      {
        songId: 's1',
        title: 'きらきら星',
        summary: '',
        parts: '',
        ...(fileId ? { fileId, version: '5' } : {}),
      },
    ],
  });
const baseJson = (version: string, text: string) =>
  JSON.stringify({
    fileId: 'f1',
    version,
    modifiedTime: '2026-10-04T10:00:00.000Z',
    device: 'Windows PC',
    text,
  });
const draftJson = (text: string, baseVersion: string | null) =>
  JSON.stringify({
    v: 1,
    text,
    baseVersion,
    savedAt: '2026-10-06T05:00:00.000Z',
  });

/** Drive song s1 (version 5) known to this device. */
function onDrive(extra: Record<string, string> = {}) {
  return {
    [INDEX_KEY]: indexJson('f1'),
    [baseKey('s1')]: baseJson('5', TEXT),
    ...extra,
  };
}

function setup(
  o: {
    status?: AuthStatus;
    files?: FakeSeedFile[];
    init?: Record<string, string>;
    songId?: string;
    /** Runs before the first render (e.g. failNext for the open). */
    before?: (drive: ReturnType<typeof createFakeDriveClient>) => void;
  } = {},
) {
  const auth = createFakeAuth(o.status ?? 'signedIn');
  const drive = createFakeDriveClient({
    files: [FOLDER, ...(o.files ?? [FILE])],
  });
  o.before?.(drive);
  const storage = createMemoryStorage(o.init);
  let n = 0;
  const hook = renderHook(
    ({ songId }: { songId: string }) => {
      const session = useDriveSession({
        auth,
        storage,
        client: drive,
        detectDevice: () => 'Windows PC',
      });
      return useSongDocument(session, songId, {
        now: () => NOW,
        newId: () => `new-${++n}`,
      });
    },
    { initialProps: { songId: o.songId ?? 's1' } },
  );
  return { auth, drive, storage, hook, doc: () => hook.result.current };
}

async function opened(doc: () => SongDocument) {
  await waitFor(() => expect(doc().phase).not.toBe('loading'));
}

/** Type in the editor (App's onTextChange). */
function edit(doc: () => SongDocument, text: string) {
  act(() => doc().onTextChange(text));
}

describe('useSongDocument: opening', () => {
  it('A: no draft, base current → Drive version, no download', async () => {
    const { doc, drive } = setup({ init: onDrive() });
    expect(doc().phase).toBe('loading');
    await opened(doc);
    expect(doc().phase).toBe('ready');
    expect(doc().decision).toEqual({ kind: 'drive' });
    expect(doc().initialText).toBe(TEXT);
    expect(doc().baseVersion).toBe('5');
    expect(drive.calls).toEqual(['getMeta:f1']);
    expect(doc().saveState).toEqual({
      kind: 'saved',
      at: '2026-10-04T10:00:00.000Z',
    });
  });

  it('A: Drive is newer than the base → downloads it into base', async () => {
    const { doc, storage } = setup({
      init: onDrive({
        [baseKey('s1')]: baseJson('3', 'old'),
        [draftKey('s1')]: draftJson('old', '3'),
      }),
    });
    await opened(doc);
    expect(doc().initialText).toBe(TEXT);
    expect(loadBase(storage, 's1')?.version).toBe('5');
    // the draft was identical to the old base: dropped
    expect(loadDraftRecord(storage, 's1')).toBeNull();
  });

  it('A: song in the index but never downloaded', async () => {
    const { doc, storage } = setup({ init: { [INDEX_KEY]: indexJson('f1') } });
    await opened(doc);
    expect(doc().initialText).toBe(TEXT);
    expect(loadBase(storage, 's1')?.fileId).toBe('f1');
  });

  it('B: unsaved draft on the current version → ask; resume keeps the draft', async () => {
    const { doc, storage } = setup({
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '5') }),
    });
    await opened(doc);
    expect(doc().phase).toBe('ask');
    expect(doc().ask).toEqual({
      kind: 'draftNewer',
      songTitle: '無題の曲',
      draft: { savedAt: '2026-10-06T05:00:00.000Z', device: 'Windows PC' },
      drive: { modifiedTime: '2026-10-05T10:00:00.000Z', device: 'iPad' },
    });
    await act(() => doc().answerOpen('resumeDraft'));
    expect(doc().phase).toBe('ready');
    expect(doc().initialText).toBe('mine');
    expect(doc().baseVersion).toBe('5');
    expect(doc().dirty).toBe(true);
    expect(doc().saveState).toEqual({
      kind: 'dirty',
      draftAt: '2026-10-06T05:00:00.000Z',
    });
    expect(loadDraftRecord(storage, 's1')?.text).toBe('mine');
  });

  it('B: open Drive instead discards the draft', async () => {
    const { doc, storage } = setup({
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '5') }),
    });
    await opened(doc);
    await act(() => doc().answerOpen('openDrive'));
    expect(doc().initialText).toBe(TEXT);
    expect(loadDraftRecord(storage, 's1')).toBeNull();
    expect(doc().dirty).toBe(false);
  });

  it('C: Drive saved elsewhere since the draft → driveNewer; open Drive', async () => {
    const { doc, storage, drive } = setup({
      init: onDrive({
        [baseKey('s1')]: baseJson('3', 'old'),
        [draftKey('s1')]: draftJson('old + mine', '3'),
      }),
    });
    await opened(doc);
    expect(doc().ask?.kind).toBe('driveNewer');
    drive.calls.length = 0;
    await act(() => doc().answerOpen('openDrive'));
    expect(doc().initialText).toBe(TEXT);
    expect(loadBase(storage, 's1')?.version).toBe('5');
    expect(loadDraftRecord(storage, 's1')).toBeNull();
    expect(drive.calls.filter((c) => c.startsWith('create'))).toEqual([]);
  });

  it('C: keep the old draft as a separate song, then open Drive', async () => {
    const { doc, storage, drive, auth } = setup({
      init: onDrive({
        [baseKey('s1')]: baseJson('3', 'old'),
        [draftKey('s1')]: draftJson('{title: きらきら星}\nmine\n', '3'),
      }),
    });
    await opened(doc);
    auth.calls.length = 0;
    let p: Promise<void> | undefined;
    act(() => {
      p = doc().answerOpen('keepDraftCopy');
    });
    expect(auth.calls).toEqual(['ensureToken']); // before any await
    expect(doc().opening).toBe(true);
    await act(() => p!);
    const copy = drive.files().find((f) => f.meta.id !== 'f1')!;
    expect(copy.meta.appProperties?.songId).toBe('new-1');
    expect(copy.text).toContain('mine');
    expect(copy.meta.name).toMatch(
      /^きらきら星（手元の版 10_6 \d\d_00）\.bandsheet$/,
    );
    expect(loadBase(storage, 'new-1')?.fileId).toBe(copy.meta.id);
    expect(loadIndex(storage).songs.map((e) => e.songId)).toContain('new-1');
    expect(doc().phase).toBe('ready');
    expect(doc().initialText).toBe(TEXT);
    expect(loadDraftRecord(storage, 's1')).toBeNull();
  });

  it('C: keeping the copy fails → the draft stays and the dialog too', async () => {
    const { doc, storage, drive } = setup({
      init: onDrive({
        [baseKey('s1')]: baseJson('3', 'old'),
        [draftKey('s1')]: draftJson('mine', '3'),
      }),
    });
    await opened(doc);
    drive.failNext('network', 5);
    await act(() => doc().answerOpen('keepDraftCopy'));
    expect(doc().phase).toBe('ask');
    expect(doc().opening).toBe(false);
    expect(doc().openError).toBe('network');
    expect(loadDraftRecord(storage, 's1')?.text).toBe('mine');
  });

  it('device-only song → its draft, no network', async () => {
    const { doc, drive } = setup({
      init: {
        [INDEX_KEY]: indexJson(),
        [draftKey('s1')]: draftJson('{title: 手元}\n', null),
      },
    });
    expect(doc().phase).toBe('ready');
    expect(doc().decision).toEqual({ kind: 'draftOnly' });
    expect(doc().initialText).toBe('{title: 手元}\n');
    expect(doc().saveState).toEqual({
      kind: 'localOnly',
      draftAt: '2026-10-06T05:00:00.000Z',
    });
    await act(async () => {});
    expect(drive.calls).toEqual([]);
  });

  it('new song (unknown id) → new song text, localOnly without draft time', () => {
    const { doc } = setup({ songId: 'brand-new' });
    expect(doc().phase).toBe('ready');
    expect(doc().initialText).toBe(newSongText());
    expect(doc().baseVersion).toBeNull();
    expect(doc().saveState).toEqual({ kind: 'localOnly' });
    expect(doc().dirty).toBe(false);
  });

  it('signed out with a cached base → opens it offline', async () => {
    const { doc, drive } = setup({ status: 'signedOut', init: onDrive() });
    expect(doc().phase).toBe('ready');
    expect(doc().initialText).toBe(TEXT);
    expect(doc().saveState).toEqual({ kind: 'localOnly' });
    await act(async () => {});
    expect(drive.calls).toEqual([]);
  });

  it('expired: offline decision with the cached base; header 「未確認」 (R2)', () => {
    const { doc } = setup({ status: 'expired', init: onDrive() });
    expect(doc().phase).toBe('ready');
    expect(doc().unconfirmed).toBe(true);
    expect(doc().saveState).toEqual({
      kind: 'unconfirmed',
      at: '2026-10-04T10:00:00.000Z',
    });
  });

  it('offline (network error) with base → opens the cached base', async () => {
    const { doc, drive } = setup({ init: onDrive() });
    drive.failNext('network');
    await opened(doc);
    expect(doc().phase).toBe('ready');
    expect(doc().initialText).toBe(TEXT);
  });

  it('offline with an unsaved draft → asks to resume (B)', async () => {
    const { doc } = setup({
      status: 'signedOut',
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '5') }),
    });
    expect(doc().phase).toBe('ask');
    expect(doc().ask?.kind).toBe('draftNewer');
    await act(() => doc().answerOpen('openDrive'));
    expect(doc().initialText).toBe(TEXT);
  });

  it('unavailable: Drive song without cached text while signed out', () => {
    const { doc } = setup({
      status: 'signedOut',
      init: { [INDEX_KEY]: indexJson('f1') },
    });
    expect(doc().phase).toBe('unavailable');
  });

  it('unavailable: offline and nothing cached', async () => {
    const { doc, drive } = setup({ init: { [INDEX_KEY]: indexJson('f1') } });
    drive.failNext('network', 3);
    await opened(doc);
    expect(doc().phase).toBe('unavailable');
  });

  it('file deleted on Drive but a draft remains → the draft', async () => {
    const { doc } = setup({
      files: [],
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '5') }),
    });
    await opened(doc);
    expect(doc().decision).toEqual({ kind: 'draftOnly' });
    expect(doc().initialText).toBe('mine');
  });

  it('switching songId re-opens', async () => {
    const { hook, doc } = setup({ init: onDrive() });
    await opened(doc);
    hook.rerender({ songId: 'other' });
    expect(doc().initialText).toBe(newSongText());
    expect(doc().editorKey).toBe('other:0');
  });
});

describe('useSongDocument: saving', () => {
  async function editing(o: Parameters<typeof setup>[0] = { init: onDrive() }) {
    const t = setup(o);
    await opened(t.doc);
    return t;
  }

  it('dirty → saved: Drive written, base updated, draft removed, index updated', async () => {
    const { doc, drive, storage, auth } = await editing();
    edit(doc, '{title: 新しい名前}\nline1\n');
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: '{title: 新しい名前}\nline1\n',
      baseVersion: '5',
      savedAt: 'x',
    });
    expect(doc().saveState).toEqual({
      kind: 'dirty',
      draftAt: NOW.toISOString(),
    });
    auth.calls.length = 0;
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().save();
    });
    expect(auth.calls).toEqual(['ensureToken']); // Ctrl+S: before any await
    expect(doc().saveState).toEqual({ kind: 'saving' });
    await act(async () => {
      expect(await p).toBe('saved');
    });
    const f = drive.files()[0];
    expect(f.text).toBe('{title: 新しい名前}\nline1\n');
    expect(f.meta.name).toBe('新しい名前.bandsheet');
    expect(f.meta.appProperties?.device).toBe('Windows PC');
    expect(doc().baseVersion).toBe(f.meta.version);
    expect(doc().saveState).toEqual({ kind: 'saved', at: f.meta.modifiedTime });
    expect(doc().dirty).toBe(false);
    expect(loadDraftRecord(storage, 's1')).toBeNull();
    expect(loadBase(storage, 's1')?.text).toBe(f.text);
    expect(loadIndex(storage).songs[0]).toMatchObject({
      title: '新しい名前',
      version: f.meta.version,
      device: 'Windows PC',
    });
  });

  it('text typed while saving keeps its draft (rebased on the new version)', async () => {
    const { doc, storage } = await editing();
    edit(doc, 'v1');
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().save();
    });
    edit(doc, 'v2');
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: 'v2',
      baseVersion: '5',
      savedAt: 'x',
    });
    await act(async () => {
      await p;
    });
    expect(doc().dirty).toBe(true);
    expect(doc().saveState.kind).toBe('dirty');
    expect(loadDraftRecord(storage, 's1')).toMatchObject({
      text: 'v2',
      baseVersion: doc().baseVersion,
    });
  });

  it('nothing to save → skipped without asking for a token', async () => {
    const { doc, auth } = await editing();
    auth.calls.length = 0;
    await act(async () => {
      expect(await doc().save()).toBe('skipped');
    });
    expect(auth.calls).toEqual([]);
  });

  it('first save of a device-only song creates the file (after sign-in)', async () => {
    const { doc, drive, storage, auth } = await editing({
      status: 'signedOut',
      init: {
        [INDEX_KEY]: indexJson(),
        [draftKey('s1')]: draftJson('{title: 手元}\n', null),
      },
    });
    expect(doc().saveState.kind).toBe('localOnly');
    await act(async () => {
      expect(await doc().save()).toBe('saved');
    });
    expect(auth.status()).toBe('signedIn');
    const f = drive.files().find((x) => x.meta.id !== 'f1')!;
    expect(f.meta.name).toBe('手元.bandsheet');
    expect(f.meta.appProperties?.songId).toBe('s1');
    expect(loadIndex(storage).songs[0].fileId).toBe(f.meta.id);
    expect(doc().saveState.kind).toBe('saved');
  });

  it('network failure: failed network, draft kept, retry works', async () => {
    const { doc, drive, storage } = await editing();
    edit(doc, 'changed');
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: 'changed',
      baseVersion: '5',
      savedAt: 'x',
    });
    drive.failNext('network');
    await act(async () => {
      expect(await doc().save()).toBe('failed');
    });
    expect(doc().saveState).toEqual({ kind: 'failed', reason: 'network' });
    expect(loadDraftRecord(storage, 's1')?.text).toBe('changed');
    await act(async () => {
      expect(await doc().save()).toBe('saved');
    });
    expect(doc().saveState.kind).toBe('saved');
  });

  it('Drive 401: failed auth and the token is invalidated', async () => {
    const { doc, drive, auth } = await editing();
    edit(doc, 'changed');
    drive.failNext('auth');
    await act(async () => {
      await doc().save();
    });
    expect(doc().saveState).toEqual({ kind: 'failed', reason: 'auth' });
    expect(auth.calls).toContain('invalidate');
    expect(auth.status()).toBe('expired');
  });

  it('sign-in popup closed: failed auth, nothing written', async () => {
    const { doc, drive, auth } = await editing({
      status: 'expired',
      init: onDrive(),
    });
    edit(doc, 'changed');
    auth.failNext('popupClosed');
    drive.calls.length = 0;
    await act(async () => {
      expect(await doc().save()).toBe('failed');
    });
    expect(doc().saveState).toEqual({ kind: 'failed', reason: 'auth' });
    expect(drive.calls).toEqual([]);
  });

  it('unconfigured: save is skipped', async () => {
    const { doc, auth } = await editing({
      status: 'unconfigured',
      init: { [INDEX_KEY]: indexJson() },
    });
    edit(doc, 'x');
    await act(async () => {
      expect(await doc().save()).toBe('skipped');
    });
    expect(auth.calls).toEqual([]);
  });
});

describe('useSongDocument: conflicts', () => {
  async function conflicted() {
    const t = setup({ init: onDrive() });
    await opened(t.doc);
    t.drive.externalUpdate(
      'f1',
      '{title: きらきら星}\n{key: C}\nline1\ntablet\n',
      'iPad',
    );
    edit(t.doc, '{title: きらきら星}\n{key: C}\nline1\nmine\n');
    saveDraftRecord(t.storage, 's1', {
      v: 1,
      text: '{title: きらきら星}\n{key: C}\nline1\nmine\n',
      baseVersion: '5',
      savedAt: 'x',
    });
    await act(async () => {
      expect(await t.doc().save()).toBe('conflict');
    });
    return t;
  }

  it('conflict → dialog data, nothing written', async () => {
    const { doc, drive, storage } = await conflicted();
    expect(doc().conflict).toEqual({
      songTitle: 'きらきら星',
      drive: {
        modifiedTime: drive.files()[0].meta.modifiedTime,
        device: 'iPad',
      },
      local: {
        editedAt: NOW.toISOString(),
        device: 'Windows PC',
        baseModifiedTime: '2026-10-04T10:00:00.000Z',
      },
      changedLines: 1,
    });
    expect(drive.files()[0].text).toContain('tablet');
    expect(doc().saveState.kind).toBe('dirty');
    expect(loadDraftRecord(storage, 's1')?.text).toContain('mine');
    // a second save while the dialog is open does nothing
    await act(async () => {
      expect(await doc().save()).toBe('skipped');
    });
  });

  it('cancel: dialog closes, still unsaved', async () => {
    const { doc, storage } = await conflicted();
    act(() => doc().cancelConflict());
    expect(doc().conflict).toBeNull();
    expect(doc().saveState.kind).toBe('dirty');
    expect(loadDraftRecord(storage, 's1')).not.toBeNull();
  });

  it('overwrite: our text on Drive', async () => {
    const { doc, drive, storage, auth } = await conflicted();
    auth.calls.length = 0;
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().resolveConflict('overwrite');
    });
    expect(auth.calls).toEqual(['ensureToken']);
    expect(doc().resolving).toBe(true);
    await act(async () => {
      expect(await p).toBe('saved');
    });
    expect(drive.files()[0].text).toContain('mine');
    expect(doc().conflict).toBeNull();
    expect(doc().saveState.kind).toBe('saved');
    expect(loadDraftRecord(storage, 's1')).toBeNull();
  });

  it('reload and discard: Drive text, editor re-created, draft gone', async () => {
    const { doc, drive, storage } = await conflicted();
    const key = doc().editorKey;
    await act(async () => {
      expect(await doc().resolveConflict('reloadDiscard')).toBe('reloaded');
    });
    expect(doc().editorKey).not.toBe(key);
    expect(doc().initialText).toContain('tablet');
    expect(doc().baseVersion).toBe(drive.files()[0].meta.version);
    expect(doc().conflict).toBeNull();
    expect(doc().dirty).toBe(false);
    expect(loadDraftRecord(storage, 's1')).toBeNull();
    expect(drive.files()).toHaveLength(1);
  });

  it('a draft flushed by the old editor on unmount after a reload is dropped', async () => {
    const auth = createFakeAuth('signedIn');
    const drive = createFakeDriveClient({ files: [FOLDER, FILE] });
    const storage = createMemoryStorage(onDrive());
    let docRef: SongDocument | undefined;
    let type: ((t: string) => void) | undefined;
    function Editor(p: { initial: string; base: string | null }) {
      const [t, setT] = useState(p.initial);
      useEffect(() => {
        type = setT;
      }, []);
      useAutosave(t, 's1', storage, p.base);
      return null;
    }
    function Screen() {
      const session = useDriveSession({
        auth,
        storage,
        client: drive,
        detectDevice: () => 'PC',
      });
      const doc = useSongDocument(session, 's1', { now: () => NOW });
      useEffect(() => {
        docRef = doc;
      });
      return doc.phase === 'ready'
        ? createElement(Editor, {
            key: doc.editorKey,
            initial: doc.initialText,
            base: doc.baseVersion,
          })
        : null;
    }
    render(createElement(Screen));
    await waitFor(() => expect(docRef?.phase).toBe('ready'));
    drive.externalUpdate('f1', 'tablet', 'iPad');
    act(() => docRef!.onTextChange('mine'));
    await act(async () => {
      expect(await docRef!.save()).toBe('conflict');
    });
    act(() => type!('late')); // pending autosave (< 500 ms)
    await act(async () => {
      expect(await docRef!.resolveConflict('reloadDiscard')).toBe('reloaded');
    });
    expect(docRef!.initialText).toBe('tablet');
    expect(loadDraftRecord(storage, 's1')).toBeNull();
  });

  it('reload and keep a copy: copy on Drive + in the index', async () => {
    const { doc, drive, storage } = await conflicted();
    await act(async () => {
      expect(await doc().resolveConflict('reloadKeepCopy')).toBe('reloaded');
    });
    const copy = drive.files().find((f) => f.meta.id !== 'f1')!;
    expect(copy.text).toContain('mine');
    expect(copy.meta.appProperties?.songId).toBe('new-1');
    expect(loadBase(storage, 'new-1')?.fileId).toBe(copy.meta.id);
    expect(loadIndex(storage).songs.map((e) => e.songId)).toEqual([
      's1',
      'new-1',
    ]);
    expect(doc().initialText).toContain('tablet');
  });

  it('cancel is ignored while a choice is running (R5)', async () => {
    const { doc } = await conflicted();
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().resolveConflict('reloadDiscard');
    });
    expect(doc().resolving).toBe(true);
    act(() => doc().cancelConflict());
    expect(doc().conflict).not.toBeNull();
    await act(async () => {
      expect(await p).toBe('reloaded');
    });
    expect(doc().conflict).toBeNull();
  });

  it('keep a copy: a retry after a failed reload makes no second copy (R7)', async () => {
    const { doc, drive, storage } = await conflicted();
    const create = drive.create.bind(drive);
    let failAfterCreate = true;
    drive.create = async (a) => {
      const r = await create(a);
      if (failAfterCreate) drive.failNext('network'); // the reload fails
      failAfterCreate = false;
      return r;
    };
    await act(async () => {
      expect(await doc().resolveConflict('reloadKeepCopy')).toBe('failed');
    });
    expect(drive.files()).toHaveLength(2);
    // the copy is recorded on this device at once
    expect(loadBase(storage, 'new-1')).not.toBeNull();
    await act(async () => {
      await doc().save(); // conflict again
    });
    expect(doc().conflict).not.toBeNull();
    await act(async () => {
      expect(await doc().resolveConflict('reloadKeepCopy')).toBe('reloaded');
    });
    expect(drive.files()).toHaveLength(2);
    expect(doc().initialText).toContain('tablet');
  });

  it('a failed resolution keeps the draft and reports it', async () => {
    const { doc, drive, storage } = await conflicted();
    drive.failNext('network', 5);
    await act(async () => {
      expect(await doc().resolveConflict('reloadKeepCopy')).toBe('failed');
    });
    expect(doc().saveState).toEqual({ kind: 'failed', reason: 'network' });
    expect(doc().conflict).toBeNull();
    expect(loadDraftRecord(storage, 's1')?.text).toContain('mine');
    expect(drive.files()).toHaveLength(1);
  });

  it('unmount while saving is harmless', async () => {
    const { doc, hook } = setup({ init: onDrive() });
    await opened(doc);
    edit(doc, 'x');
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().save();
    });
    hook.unmount();
    await expect(p).resolves.toBe('saved');
  });
});

describe('useSongView', () => {
  function openView(o: {
    status?: AuthStatus;
    init: Record<string, string>;
    files?: FakeSeedFile[];
  }) {
    const auth = createFakeAuth(o.status ?? 'signedIn');
    const drive = createFakeDriveClient({
      files: [FOLDER, ...(o.files ?? [FILE])],
    });
    const storage = createMemoryStorage(o.init);
    const hook = renderHook(() =>
      useSongView(
        useDriveSession({
          auth,
          storage,
          client: drive,
          detectDevice: () => 'iPad',
        }),
        's1',
      ),
    );
    return { drive, storage, view: () => hook.result.current };
  }

  it('cached base at once, one check, same version → no change', async () => {
    const { view, drive } = openView({ init: onDrive() });
    expect(view()).toMatchObject({
      phase: 'ready',
      text: TEXT,
      textKey: 0,
      notice: null,
      unconfirmed: false,
    });
    await waitFor(() => expect(drive.calls).toEqual(['getMeta:f1']));
    await act(async () => {});
    expect(view().textKey).toBe(0);
  });

  it('Drive newer → swaps the text in, notice updated, base saved, no draft', async () => {
    const { view, storage } = openView({
      init: onDrive({ [baseKey('s1')]: baseJson('3', 'old') }),
    });
    expect(view().text).toBe('old');
    await waitFor(() => expect(view().notice).toBe('updated'));
    expect(view().text).toBe(TEXT);
    expect(view().textKey).toBe(1);
    expect(loadBase(storage, 's1')?.version).toBe('5');
    expect(storage.data.has(draftKey('s1'))).toBe(false);
  });

  it('unsaved changes → the draft with notice draft, no Drive call', async () => {
    const { view, drive } = openView({
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '5') }),
    });
    expect(view()).toMatchObject({
      phase: 'ready',
      text: 'mine',
      notice: 'draft',
    });
    await act(async () => {});
    expect(drive.calls).toEqual([]);
  });

  it('nothing cached → downloads (signed in) or unavailable', async () => {
    const a = openView({ init: { [INDEX_KEY]: indexJson('f1') } });
    expect(a.view().phase).toBe('loading');
    await waitFor(() => expect(a.view().phase).toBe('ready'));
    expect(a.view()).toMatchObject({ text: TEXT, notice: null });
    const b = openView({
      status: 'signedOut',
      init: { [INDEX_KEY]: indexJson('f1') },
    });
    expect(b.view().phase).toBe('unavailable');
    const c = openView({ init: { [INDEX_KEY]: indexJson('f1') } });
    c.drive.failNext('network', 3);
    await waitFor(() => expect(c.view().phase).toBe('unavailable'));
  });
});

describe('useSongDocument: review fixes (m7-review.md)', () => {
  const MINE = '{title: きらきら星}\n{key: C}\nline1\nmine\n';
  const TABLET = '{title: きらきら星}\n{key: C}\nline1\ntablet\n';

  it('R2: expired → reconnect asks for the token first, same version → confirmed', async () => {
    const { doc, auth, drive } = setup({ status: 'expired', init: onDrive() });
    expect(doc().unconfirmed).toBe(true);
    expect(drive.calls).toEqual([]);
    let p: Promise<void> | undefined;
    act(() => {
      p = doc().reconnect();
    });
    // synchronously, inside the click
    expect(auth.calls).toEqual(['ensureToken']);
    await act(async () => {
      await p;
    });
    expect(drive.calls).toEqual(['getMeta:f1']);
    expect(doc().unconfirmed).toBe(false);
    expect(doc().saveState.kind).toBe('saved');
  });

  it('R2: reconnect finds a newer Drive version → opens it (A)', async () => {
    const { doc, drive, storage } = setup({
      status: 'expired',
      init: onDrive(),
    });
    drive.externalUpdate('f1', TABLET, 'iPad');
    await act(() => doc().reconnect());
    await waitFor(() => expect(doc().initialText).toBe(TABLET));
    expect(doc().phase).toBe('ready');
    expect(doc().unconfirmed).toBe(false);
    expect(loadBase(storage, 's1')?.text).toBe(TABLET);
  });

  it('R2: reconnect with unsaved edits and a newer Drive version → C dialog', async () => {
    const { doc, drive, storage } = setup({
      status: 'expired',
      init: onDrive(),
    });
    edit(doc, MINE);
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: MINE,
      baseVersion: '5',
      savedAt: 'x',
    });
    drive.externalUpdate('f1', TABLET, 'iPad');
    await act(() => doc().reconnect());
    await waitFor(() => expect(doc().phase).toBe('ask'));
    expect(doc().ask?.kind).toBe('driveNewer');
    expect(loadDraftRecord(storage, 's1')?.text).toBe(MINE);
  });

  it('R2: signing in elsewhere (list banner) also checks Drive', async () => {
    const { doc, auth, drive } = setup({ status: 'expired', init: onDrive() });
    drive.externalUpdate('f1', TABLET, 'iPad');
    act(() => auth.setStatus('signedIn'));
    await waitFor(() => expect(doc().initialText).toBe(TABLET));
  });

  it('R2: reconnect still offline → stays unconfirmed with the reason', async () => {
    const { doc, drive } = setup({ status: 'expired', init: onDrive() });
    drive.failNext('network');
    await act(() => doc().reconnect());
    expect(doc().unconfirmed).toBe(true);
    expect(doc().reconnectError).toBe('network');
  });

  it('R18: expired + never downloaded → unavailable/unconfirmed; reconnect opens it', async () => {
    const { doc, auth, drive } = setup({
      status: 'expired',
      init: { [INDEX_KEY]: indexJson('f1') },
    });
    expect(doc().phase).toBe('unavailable');
    expect(doc().unavailable).toBe('network');
    expect(doc().unconfirmed).toBe(true);
    let p: Promise<void> | undefined;
    act(() => {
      p = doc().reconnect();
    });
    expect(auth.calls).toEqual(['ensureToken']);
    await act(async () => {
      await p;
    });
    await waitFor(() => expect(doc().phase).toBe('ready'));
    expect(doc().initialText).toBe(TEXT);
    expect(drive.calls).toContain('getMeta:f1');
  });

  it('R18: signing in elsewhere reopens an unavailable song', async () => {
    const { doc, auth } = setup({
      status: 'expired',
      init: { [INDEX_KEY]: indexJson('f1') },
    });
    expect(doc().phase).toBe('unavailable');
    act(() => auth.setStatus('signedIn'));
    await waitFor(() => expect(doc().phase).toBe('ready'));
    expect(doc().initialText).toBe(TEXT);
  });

  it('R19: file gone on Drive, no draft → unavailable notFound (not a network problem)', async () => {
    const { doc } = setup({ files: [], init: onDrive() });
    await opened(doc);
    expect(doc().phase).toBe('unavailable');
    expect(doc().unavailable).toBe('notFound');
    expect(doc().unconfirmed).toBe(false);
  });

  it('R19: network failure with nothing cached stays unavailable network', async () => {
    const { doc, drive } = setup({ init: { [INDEX_KEY]: indexJson('f1') } });
    drive.failNext('network', 3);
    await opened(doc);
    expect(doc().unavailable).toBe('network');
  });

  it('R2: offline at open (network error) → unconfirmed', async () => {
    const { doc } = setup({
      init: onDrive(),
      before: (d) => d.failNext('network'),
    });
    await opened(doc);
    expect(doc().unconfirmed).toBe(true);
    expect(doc().saveState.kind).toBe('unconfirmed');
  });

  it("R4: a save does not rebase another tab's draft", async () => {
    const { doc, storage } = setup({ init: onDrive() });
    await opened(doc);
    edit(doc, MINE);
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().save();
    });
    // another tab autosaves its own unsaved work meanwhile
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: 'other tab',
      baseVersion: '5',
      savedAt: 'x',
    });
    await act(async () => {
      expect(await p).toBe('saved');
    });
    expect(loadDraftRecord(storage, 's1')).toMatchObject({
      text: 'other tab',
      baseVersion: '5',
    });
    expect(loadBase(storage, 's1')?.version).not.toBe('5');
  });

  it('R7: C 「下書きも別の曲として残す」 retried after a failed reload → one copy', async () => {
    const { doc, drive } = setup({
      init: onDrive({ [draftKey('s1')]: draftJson('mine', '3') }),
    });
    await opened(doc);
    expect(doc().ask?.kind).toBe('driveNewer');
    const create = drive.create.bind(drive);
    drive.create = async (a) => {
      const r = await create(a);
      drive.failNext('network');
      return r;
    };
    await act(() => doc().answerOpen('keepDraftCopy'));
    expect(doc().openError).toBe('network');
    expect(drive.files()).toHaveLength(2);
    await act(() => doc().answerOpen('keepDraftCopy'));
    expect(doc().phase).toBe('ready');
    expect(drive.files()).toHaveLength(2);
  });

  it('R14: file gone → ask (missing), nothing created; recreate on confirm', async () => {
    const { doc, drive, storage, auth } = setup({ init: onDrive() });
    await opened(doc);
    edit(doc, MINE);
    saveDraftRecord(storage, 's1', {
      v: 1,
      text: MINE,
      baseVersion: '5',
      savedAt: 'x',
    });
    await drive.trash('f1');
    await act(async () => {
      expect(await doc().save()).toBe('missing');
    });
    expect(doc().missing).toBe(true);
    expect(drive.files().filter((f) => !f.trashed)).toHaveLength(0);
    expect(loadDraftRecord(storage, 's1')?.text).toBe(MINE);
    // cancel: the draft stays, nothing written
    act(() => doc().cancelMissing());
    expect(doc().missing).toBe(false);
    expect(doc().dirty).toBe(true);
    await act(async () => {
      expect(await doc().save()).toBe('missing');
    });
    auth.calls.length = 0;
    let p: Promise<string> | undefined;
    act(() => {
      p = doc().recreate();
    });
    expect(auth.calls).toEqual(['ensureToken']);
    await act(async () => {
      expect(await p).toBe('saved');
    });
    const live = drive.files().filter((f) => !f.trashed);
    expect(live).toHaveLength(1);
    expect(live[0].meta.appProperties?.songId).toBe('s1');
    expect(loadIndex(storage).songs[0].fileId).toBe(live[0].meta.id);
    expect(doc().missing).toBe(false);
  });

  it('R3: a resumed draft older than the cached base never saves without the conflict check', async () => {
    // base moved to 5 under a draft written on version 4; offline open → B
    const { doc, drive } = setup({
      init: onDrive({ [draftKey('s1')]: draftJson(MINE, '4') }),
      before: (d) => d.failNext('network'),
    });
    await opened(doc);
    expect(doc().ask?.kind).toBe('draftNewer');
    await act(() => doc().answerOpen('resumeDraft'));
    expect(doc().baseVersion).toBe('4');
    await act(async () => {
      expect(await doc().save()).toBe('conflict');
    });
    expect(drive.files()[0].text).toBe(TEXT);
  });

  it('R3: a resumed draft on the cached base version saves normally', async () => {
    const { doc, drive } = setup({
      init: onDrive({ [draftKey('s1')]: draftJson(MINE, '5') }),
      before: (d) => d.failNext('network'),
    });
    await opened(doc);
    await act(() => doc().answerOpen('resumeDraft'));
    expect(doc().baseVersion).toBe('5');
    await act(async () => {
      expect(await doc().save()).toBe('saved');
    });
    expect(drive.files()[0].text).toBe(MINE);
  });

  it('R6: a draft of a Drive song never downloaded here saves into the same file (no duplicate)', async () => {
    const { doc, drive } = setup({
      status: 'signedOut',
      init: {
        [INDEX_KEY]: indexJson('f1'),
        [draftKey('s1')]: draftJson(MINE, '5'),
      },
    });
    expect(doc().ask?.kind).toBe('draftNewer');
    await act(() => doc().answerOpen('resumeDraft'));
    await act(async () => {
      expect(await doc().save()).toBe('saved');
    });
    expect(drive.files()).toHaveLength(1);
    expect(drive.files()[0].text).toBe(MINE);
  });

  it('R6: … and on an older version → conflict instead of a second file', async () => {
    const { doc, drive } = setup({
      status: 'signedOut',
      init: {
        [INDEX_KEY]: indexJson('f1'),
        [draftKey('s1')]: draftJson(MINE, '2'),
      },
    });
    await act(() => doc().answerOpen('resumeDraft'));
    await act(async () => {
      expect(await doc().save()).toBe('conflict');
    });
    expect(drive.files()).toHaveLength(1);
  });
});

describe('useSongView: review fixes (R2)', () => {
  function openView(
    status: AuthStatus,
    init: Record<string, string>,
    before?: (drive: ReturnType<typeof createFakeDriveClient>) => void,
  ) {
    const auth = createFakeAuth(status);
    const drive = createFakeDriveClient({ files: [FOLDER, FILE] });
    before?.(drive);
    const storage = createMemoryStorage(init);
    const hook = renderHook(() =>
      useSongView(
        useDriveSession({
          auth,
          storage,
          client: drive,
          detectDevice: () => 'iPad',
        }),
        's1',
      ),
    );
    return { auth, drive, storage, view: () => hook.result.current };
  }

  it('expired → cached copy, unconfirmed, no Drive call; reconnect checks', async () => {
    const { view, auth, drive } = openView('expired', onDrive());
    expect(view().phase).toBe('ready');
    expect(view().unconfirmed).toBe(true);
    await act(async () => {});
    expect(drive.calls).toEqual([]);
    let p: Promise<void> | undefined;
    act(() => {
      p = view().reconnect();
    });
    expect(auth.calls).toEqual(['ensureToken']);
    await act(async () => {
      await p;
    });
    await waitFor(() => expect(view().unconfirmed).toBe(false));
    expect(drive.calls).toContain('getMeta:f1');
    expect(view().notice).toBeNull();
  });

  it('expired, Drive newer → after reconnect the new version with notice', async () => {
    const { view } = openView(
      'expired',
      onDrive({ [baseKey('s1')]: baseJson('3', 'old') }),
    );
    expect(view().text).toBe('old');
    await act(() => view().reconnect());
    await waitFor(() => expect(view().notice).toBe('updated'));
    expect(view().text).toBe(TEXT);
    expect(view().unconfirmed).toBe(false);
  });

  it('expired with nothing cached → unavailable but offers reconnect', async () => {
    const { view } = openView('expired', { [INDEX_KEY]: indexJson('f1') });
    expect(view().phase).toBe('unavailable');
    expect(view().unconfirmed).toBe(true);
    await act(() => view().reconnect());
    await waitFor(() => expect(view().phase).toBe('ready'));
    expect(view().text).toBe(TEXT);
  });

  it('the check fails (offline) → unconfirmed', async () => {
    const t = openView('signedIn', onDrive(), (d) => d.failNext('network'));
    await waitFor(() => expect(t.view().unconfirmed).toBe(true));
    expect(t.view().text).toBe(TEXT);
  });
});
