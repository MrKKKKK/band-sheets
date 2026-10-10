import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../lib/auth/gis';
import { createFakeAuth } from '../lib/auth/fakeAuth';
import { DriveError } from '../lib/drive/driveClient';
import { createFakeDriveClient } from '../lib/drive/fakeDriveClient';
import {
  baseKey,
  createMemoryStorage,
  DEVICE_KEY,
  draftKey,
  INDEX_KEY,
  loadIndex,
} from '../lib/storage';
import { failReason, useDriveSession } from './useDriveSession';

function setup(
  status: Parameters<typeof createFakeAuth>[0] = 'signedIn',
  init: Record<string, string> = {},
) {
  const auth = createFakeAuth(status);
  const drive = createFakeDriveClient();
  const storage = createMemoryStorage(init);
  let detected = 0;
  const hook = renderHook(() =>
    useDriveSession({
      auth,
      storage,
      client: drive,
      detectDevice: () => {
        detected += 1;
        return 'Windows PC';
      },
    }),
  );
  return { auth, drive, storage, hook, detected: () => detected };
}

describe('failReason', () => {
  it('maps auth and Drive errors to SaveState reasons', () => {
    expect(failReason(new AuthError('popupClosed'))).toBe('auth');
    expect(failReason(new AuthError('popupBlocked'))).toBe('auth');
    expect(failReason(new AuthError('denied'))).toBe('auth');
    expect(failReason(new AuthError('needsSignIn'))).toBe('auth');
    expect(failReason(new AuthError('scriptLoad'))).toBe('network');
    expect(failReason(new AuthError('unknown'))).toBe('other');
    expect(failReason(new DriveError('auth', 401))).toBe('auth');
    expect(failReason(new DriveError('network'))).toBe('network');
    expect(failReason(new TypeError('Failed to fetch'))).toBe('network');
    expect(failReason(new DriveError('server', 500))).toBe('other');
    expect(failReason(new DriveError('rateLimit', 429))).toBe('other');
    expect(failReason(new Error('x'))).toBe('other');
  });
});

describe('useDriveSession', () => {
  it('follows the auth status', () => {
    const { auth, hook } = setup('signedOut');
    expect(hook.result.current.status).toBe('signedOut');
    expect(hook.result.current.connected).toBe(false);
    act(() => auth.setStatus('signedIn'));
    expect(hook.result.current.status).toBe('signedIn');
    expect(hook.result.current.connected).toBe(true);
    act(() => auth.setStatus('expired'));
    expect(hook.result.current.connected).toBe(true);
  });

  it('reports unconfigured', () => {
    const { hook } = setup('unconfigured');
    expect(hook.result.current.configured).toBe(false);
  });

  it('detects the device name once and keeps it', () => {
    const { hook, storage, detected } = setup();
    expect(hook.result.current.device).toBe('Windows PC');
    expect(storage.data.get(DEVICE_KEY)).toBe('Windows PC');
    hook.rerender();
    expect(detected()).toBe(1);
    const again = setup('signedIn', { [DEVICE_KEY]: 'iPad' });
    expect(again.hook.result.current.device).toBe('iPad');
    expect(again.detected()).toBe(0);
  });

  it('a Drive 401 invalidates the token (→ expired)', async () => {
    const { auth, drive, hook } = setup();
    drive.failNext('auth');
    await expect(
      hook.result.current.client.findFolder('band-sheets'),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(auth.calls).toContain('invalidate');
    await waitFor(() => expect(hook.result.current.status).toBe('expired'));
  });

  it('other Drive errors pass through without invalidating', async () => {
    const { auth, drive, hook } = setup();
    drive.failNext('network');
    await expect(
      hook.result.current.client.listFiles('x'),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(auth.calls).not.toContain('invalidate');
  });

  it('a token error inside the client becomes DriveError auth', async () => {
    const auth = createFakeAuth('signedIn');
    const failing = createFakeDriveClient();
    failing.findFolder = () => Promise.reject(new AuthError('needsSignIn'));
    const { result } = renderHook(() =>
      useDriveSession({
        auth,
        storage: null,
        client: failing,
        detectDevice: () => 'PC',
      }),
    );
    const err = await result.current.client.findFolder('a').catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.kind).toBe('auth');
    expect(auth.calls).toContain('invalidate');
  });

  it('ensureToken asks the auth synchronously', () => {
    const { auth, hook } = setup('expired');
    let p: Promise<string> | undefined;
    act(() => {
      p = hook.result.current.ensureToken();
    });
    expect(auth.calls).toEqual(['ensureToken']);
    return expect(p).resolves.toMatch(/^fake-token/);
  });

  it('signIn: busy flag, success', async () => {
    const { auth, hook } = setup('signedOut');
    let p: Promise<boolean> | undefined;
    act(() => {
      p = hook.result.current.signIn();
    });
    expect(auth.calls).toEqual(['signIn']);
    expect(hook.result.current.signingIn).toBe(true);
    await act(async () => {
      expect(await p).toBe(true);
    });
    expect(hook.result.current.signingIn).toBe(false);
    expect(hook.result.current.status).toBe('signedIn');
    expect(hook.result.current.signInError).toBeNull();
  });

  it('signIn: failure kind', async () => {
    const { auth, hook } = setup('signedOut');
    auth.failNext('popupClosed');
    await act(async () => {
      expect(await hook.result.current.signIn()).toBe(false);
    });
    expect(hook.result.current.signInError).toBe('popupClosed');
    expect(hook.result.current.signingIn).toBe(false);
  });

  it('signOut forgets the Drive cache but keeps unsaved drafts', async () => {
    const base = (fileId: string, text: string) =>
      JSON.stringify({ fileId, version: '1', modifiedTime: 't', text });
    const draft = (text: string) =>
      JSON.stringify({ v: 1, text, baseVersion: '1', savedAt: 's' });
    const { auth, hook, storage } = setup('signedIn', {
      [INDEX_KEY]: JSON.stringify({
        v: 1,
        folderId: 'folder',
        listedAt: 'x',
        songs: [
          { songId: 'clean', fileId: 'f1', title: 'A', summary: '', parts: '' },
          { songId: 'same', fileId: 'f2', title: 'B', summary: '', parts: '' },
          { songId: 'dirty', fileId: 'f3', title: 'C', summary: '', parts: '' },
          { songId: 'local', title: 'D', summary: '', parts: '' },
        ],
      }),
      [baseKey('clean')]: base('f1', 'a'),
      [baseKey('same')]: base('f2', 'b'),
      [draftKey('same')]: draft('b'),
      [baseKey('dirty')]: base('f3', 'c'),
      [draftKey('dirty')]: draft('c changed'),
      [draftKey('local')]: draft('d'),
    });
    await act(() => hook.result.current.signOut());
    expect(auth.calls).toContain('signOut');
    expect(hook.result.current.status).toBe('signedOut');
    const idx = loadIndex(storage);
    expect(idx.folderId).toBeUndefined();
    expect(idx.listedAt).toBeUndefined();
    expect(idx.songs.map((e) => e.songId)).toEqual(['dirty', 'local']);
    expect(storage.data.has(baseKey('clean'))).toBe(false);
    expect(storage.data.has(baseKey('same'))).toBe(false);
    expect(storage.data.has(draftKey('same'))).toBe(false);
    expect(storage.data.has(baseKey('dirty'))).toBe(true);
    expect(storage.data.has(draftKey('dirty'))).toBe(true);
    expect(storage.data.has(draftKey('local'))).toBe(true);
  });
});
