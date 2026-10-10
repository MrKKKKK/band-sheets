import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY, createMemoryStorage, loadAuth, saveAuth } from '../storage';
import {
  AuthError,
  DRIVE_SCOPE,
  GIS_SCRIPT_URL,
  createGisAuth,
  createGisLoader,
  type GoogleOAuth2,
  type GoogleTokenClientConfig,
} from './gis';
import { createFakeAuth } from './fakeAuth';

const HOUR = 3600_000;
const T0 = 1_800_000_000_000;

/** A fake `google.accounts.oauth2`; never touches the network. */
function fakeOAuth2() {
  let config: GoogleTokenClientConfig | null = null;
  const requests: (string | undefined)[] = [];
  const revoked: string[] = [];
  let initCount = 0;
  const api: GoogleOAuth2 = {
    initTokenClient(c) {
      initCount += 1;
      config = c;
      return {
        requestAccessToken(o) {
          requests.push(o?.prompt);
        },
      };
    },
    revoke(token, done) {
      revoked.push(token);
      done?.({ successful: true });
    },
  };
  return {
    api,
    requests,
    revoked,
    initCount: () => initCount,
    config: () => config!,
    grant(token = 'tok-1', expires_in: number | string = 3599) {
      config!.callback({ access_token: token, expires_in, scope: DRIVE_SCOPE });
    },
    respond(r: Parameters<GoogleTokenClientConfig['callback']>[0]) {
      config!.callback(r);
    },
    fail(type: string) {
      config!.error_callback?.({ type });
    },
  };
}

function setup(
  o: {
    stored?: { accessToken: string; expiresAt: number };
    clientId?: string;
    loadScript?: () => Promise<GoogleOAuth2>;
  } = {},
) {
  const g = fakeOAuth2();
  const storage = createMemoryStorage();
  if (o.stored) saveAuth(storage, o.stored);
  let time = T0;
  const loadScript = vi.fn(o.loadScript ?? (() => Promise.resolve(g.api)));
  const auth = createGisAuth({
    clientId: 'clientId' in o ? o.clientId : 'test-client.apps',
    storage,
    loadScript,
    now: () => time,
  });
  return {
    g,
    storage,
    auth,
    loadScript,
    setTime: (t: number) => {
      time = t;
    },
  };
}

/** Lets pending promise callbacks (script load) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('createGisAuth: status', () => {
  it('is unconfigured without a client ID (undefined, empty, blank)', async () => {
    for (const clientId of [undefined, '', '  ']) {
      const { auth, loadScript } = setup({ clientId });
      expect(auth.status()).toBe('unconfigured');
      await expect(auth.ensureToken()).rejects.toMatchObject({
        kind: 'unconfigured',
      });
      await expect(auth.signIn()).rejects.toBeInstanceOf(AuthError);
      expect(loadScript).not.toHaveBeenCalled();
    }
  });

  it('is signedOut with no stored token and does not load GIS', () => {
    const { auth, loadScript } = setup();
    expect(auth.status()).toBe('signedOut');
    expect(loadScript).not.toHaveBeenCalled();
  });

  it('is signedIn with a stored token until 1 minute before expiry', () => {
    const { auth, setTime } = setup({
      stored: { accessToken: 'a', expiresAt: T0 + HOUR },
    });
    expect(auth.status()).toBe('signedIn');
    setTime(T0 + HOUR - 60_001);
    expect(auth.status()).toBe('signedIn');
    setTime(T0 + HOUR - 60_000);
    expect(auth.status()).toBe('expired');
  });

  it('preloads GIS for a returning user (stored token, valid or expired)', () => {
    expect(
      setup({ stored: { accessToken: 'a', expiresAt: T0 + HOUR } }).loadScript,
    ).toHaveBeenCalledTimes(1);
    expect(
      setup({ stored: { accessToken: 'a', expiresAt: T0 - 1 } }).loadScript,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('createGisAuth: ensureToken', () => {
  it('returns a valid stored token without GIS', async () => {
    const { auth, g } = setup({
      stored: { accessToken: 'stored', expiresAt: T0 + HOUR },
    });
    await expect(auth.ensureToken()).resolves.toBe('stored');
    expect(g.requests).toEqual([]);
  });

  it('calls requestAccessToken synchronously (inside the gesture) with prompt "" once GIS is loaded', async () => {
    const { auth, g, storage } = setup({
      stored: { accessToken: 'old', expiresAt: T0 - 1 },
    });
    await flush(); // preload finished
    const p = auth.ensureToken();
    // Synchronous: no await between the call and the popup request.
    expect(g.requests).toEqual(['']);
    expect(g.config()).toMatchObject({
      client_id: 'test-client.apps',
      scope: DRIVE_SCOPE,
    });
    g.grant('new-token', 3599);
    await expect(p).resolves.toBe('new-token');
    expect(loadAuth(storage)).toEqual({
      accessToken: 'new-token',
      expiresAt: T0 + 3599_000,
    });
    expect(auth.status()).toBe('signedIn');
  });

  it('loads the script first when it is not loaded yet, then requests', async () => {
    const { auth, g, loadScript } = setup();
    const p = auth.ensureToken();
    expect(loadScript).toHaveBeenCalledTimes(1);
    await flush();
    expect(g.requests).toEqual(['']);
    g.grant('t');
    await expect(p).resolves.toBe('t');
  });

  it('accepts expires_in as a string and falls back to 1 hour when missing', async () => {
    const { auth, g, storage } = setup();
    let p = auth.ensureToken();
    await flush();
    g.grant('t', '120');
    await p;
    expect(loadAuth(storage)?.expiresAt).toBe(T0 + 120_000);
    auth.invalidate();
    p = auth.ensureToken();
    g.respond({ access_token: 't2', scope: DRIVE_SCOPE });
    await p;
    expect(loadAuth(storage)?.expiresAt).toBe(T0 + HOUR);
  });

  it('rejects with needsSignIn and opens nothing when interactive is false', async () => {
    const { auth, g } = setup({
      stored: { accessToken: 'old', expiresAt: T0 - 1 },
    });
    await flush();
    await expect(
      auth.ensureToken({ interactive: false }),
    ).rejects.toMatchObject({ kind: 'needsSignIn' });
    expect(g.requests).toEqual([]);
  });

  it('shares one pending request between concurrent callers and re-asks GIS', async () => {
    const { auth, g } = setup();
    const a = auth.ensureToken();
    await flush();
    const b = auth.ensureToken();
    expect(g.requests).toEqual(['', '']);
    expect(g.initCount()).toBe(1);
    g.grant('shared');
    await expect(a).resolves.toBe('shared');
    await expect(b).resolves.toBe('shared');
  });

  it.each([
    ['popup_failed_to_open', 'popupBlocked'],
    ['popup_closed', 'popupClosed'],
    ['unknown', 'unknown'],
  ])('maps error_callback %s to %s and allows a retry', async (type, kind) => {
    const { auth, g, storage } = setup();
    const p = auth.ensureToken();
    await flush();
    g.fail(type);
    await expect(p).rejects.toMatchObject({ kind });
    expect(loadAuth(storage)).toBeNull();
    const retry = auth.ensureToken();
    expect(g.requests).toEqual(['', '']); // synchronous this time
    g.grant('ok');
    await expect(retry).resolves.toBe('ok');
  });

  it('rejects with denied on an OAuth error response', async () => {
    const { auth, g, storage } = setup();
    const p = auth.ensureToken();
    await flush();
    g.respond({ error: 'access_denied' });
    await expect(p).rejects.toMatchObject({ kind: 'denied' });
    expect(loadAuth(storage)).toBeNull();
  });

  it('rejects with denied when the drive.file scope was unticked', async () => {
    const { auth, g, storage } = setup();
    const p = auth.ensureToken();
    await flush();
    g.respond({ access_token: 't', expires_in: 3599, scope: 'email' });
    await expect(p).rejects.toMatchObject({ kind: 'denied' });
    expect(loadAuth(storage)).toBeNull();
  });

  it('uses hasGrantedAllScopes from GIS when the library provides it', async () => {
    const g = fakeOAuth2();
    const check = vi.fn(() => false);
    g.api.hasGrantedAllScopes = check;
    const { auth } = setup({ loadScript: () => Promise.resolve(g.api) });
    const p = auth.ensureToken();
    await flush();
    g.grant('t');
    await expect(p).rejects.toMatchObject({ kind: 'denied' });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 't' }),
      DRIVE_SCOPE,
    );
  });

  it('rejects with scriptLoad when GIS cannot load, and retries the load next time', async () => {
    let fail = true;
    const g2 = fakeOAuth2();
    const { auth, loadScript } = setup({
      loadScript: () =>
        fail
          ? Promise.reject(new AuthError('scriptLoad'))
          : Promise.resolve(g2.api),
    });
    await expect(auth.ensureToken()).rejects.toMatchObject({
      kind: 'scriptLoad',
    });
    fail = false;
    const p = auth.ensureToken();
    await flush();
    expect(loadScript).toHaveBeenCalledTimes(2);
    g2.grant('t');
    await expect(p).resolves.toBe('t');
  });

  it('wraps a non-AuthError script failure as scriptLoad', async () => {
    const { auth } = setup({
      loadScript: () => Promise.reject(new Error('boom')),
    });
    await expect(auth.ensureToken()).rejects.toMatchObject({
      kind: 'scriptLoad',
    });
  });

  it('ignores a late callback with no pending request', async () => {
    const { auth, g, storage } = setup();
    const p = auth.ensureToken();
    await flush();
    g.grant('t');
    await p;
    g.grant('late');
    expect(loadAuth(storage)?.accessToken).toBe('t');
  });
});

describe('createGisAuth: signIn / signOut / invalidate', () => {
  it('signIn requests with the default prompt (no override)', async () => {
    const { auth, g } = setup();
    const p = auth.signIn();
    await flush();
    expect(g.requests).toEqual([undefined]);
    expect(g.config().prompt).toBeUndefined();
    g.grant('t');
    await p;
    expect(auth.status()).toBe('signedIn');
  });

  it('signOut clears the stored token and revokes it', async () => {
    const { auth, g, storage } = setup({
      stored: { accessToken: 'tok', expiresAt: T0 + HOUR },
    });
    await auth.signOut();
    expect(storage.data.has(AUTH_KEY)).toBe(false);
    expect(auth.status()).toBe('signedOut');
    expect(g.revoked).toEqual(['tok']);
  });

  it('signOut still signs out locally when GIS cannot load', async () => {
    const { auth, storage } = setup({
      stored: { accessToken: 'tok', expiresAt: T0 + HOUR },
      loadScript: () => Promise.reject(new Error('offline')),
    });
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(loadAuth(storage)).toBeNull();
  });

  it('signOut when signed out does nothing and does not load GIS', async () => {
    const { auth, loadScript } = setup();
    await auth.signOut();
    expect(loadScript).not.toHaveBeenCalled();
  });

  it('invalidate turns a valid token into expired (not signedOut)', async () => {
    const { auth, g } = setup({
      stored: { accessToken: 'tok', expiresAt: T0 + HOUR },
    });
    await flush();
    auth.invalidate();
    expect(auth.status()).toBe('expired');
    const p = auth.ensureToken();
    expect(g.requests).toEqual(['']);
    g.grant('fresh');
    await expect(p).resolves.toBe('fresh');
  });
});

describe('createGisAuth: subscribe', () => {
  it('notifies on sign-in, invalidate and sign-out; unsubscribe stops it', async () => {
    const { auth, g } = setup();
    const fn = vi.fn();
    const off = auth.subscribe(fn);
    const p = auth.signIn();
    await flush();
    g.grant('t');
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
    auth.invalidate();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    await auth.signOut();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('notifies when the token reaches its expiry margin', () => {
    vi.useFakeTimers();
    let time = T0;
    const storage = createMemoryStorage();
    saveAuth(storage, { accessToken: 'a', expiresAt: T0 + HOUR });
    const auth = createGisAuth({
      clientId: 'c',
      storage,
      loadScript: () => new Promise(() => {}),
      now: () => time,
    });
    const fn = vi.fn();
    auth.subscribe(fn);
    time = T0 + HOUR - 60_000 - 1;
    vi.advanceTimersByTime(HOUR - 60_000 - 1);
    expect(fn).not.toHaveBeenCalled();
    time = T0 + HOUR - 60_000;
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(auth.status()).toBe('expired');
  });

  it('a throwing listener does not stop the others', async () => {
    const { auth } = setup({
      stored: { accessToken: 'a', expiresAt: T0 + HOUR },
    });
    const ok = vi.fn();
    auth.subscribe(() => {
      throw new Error('x');
    });
    auth.subscribe(ok);
    auth.invalidate();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('createGisLoader', () => {
  function env() {
    const win: { google?: { accounts?: { oauth2?: GoogleOAuth2 } } } = {};
    return { win, load: createGisLoader({ doc: document, win }) };
  }
  const scripts = () =>
    [...document.head.querySelectorAll('script')].filter(
      (s) => s.src === GIS_SCRIPT_URL,
    );

  afterEach(() => {
    for (const s of scripts()) s.remove();
  });

  it('adds one async script tag and resolves with google.accounts.oauth2 on load', async () => {
    const { win, load } = env();
    const a = load();
    const b = load();
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].async).toBe(true);
    const api = fakeOAuth2().api;
    win.google = { accounts: { oauth2: api } };
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(a).resolves.toBe(api);
    await expect(b).resolves.toBe(api);
    await expect(load()).resolves.toBe(api);
    expect(scripts()).toHaveLength(1);
  });

  it('rejects with scriptLoad on error, removes the tag and retries next time', async () => {
    const { load } = env();
    const a = load();
    scripts()[0].dispatchEvent(new Event('error'));
    await expect(a).rejects.toMatchObject({ kind: 'scriptLoad' });
    expect(scripts()).toHaveLength(0);
    void load().catch(() => {});
    expect(scripts()).toHaveLength(1);
  });

  it('rejects when the script loads without google.accounts.oauth2', async () => {
    const { load } = env();
    const a = load();
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(a).rejects.toMatchObject({ kind: 'scriptLoad' });
  });
});

describe('createFakeAuth', () => {
  it('starts signedIn by default and returns a token', async () => {
    const auth = createFakeAuth();
    expect(auth.status()).toBe('signedIn');
    await expect(auth.ensureToken()).resolves.toBe(auth.token());
  });

  it('ensureToken signs in an expired/signedOut auth, unless non-interactive', async () => {
    const auth = createFakeAuth('expired');
    await expect(
      auth.ensureToken({ interactive: false }),
    ).rejects.toMatchObject({ kind: 'needsSignIn' });
    const fn = vi.fn();
    auth.subscribe(fn);
    await auth.ensureToken();
    expect(auth.status()).toBe('signedIn');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('failNext makes interactive requests fail with the given kind', async () => {
    const auth = createFakeAuth('signedOut');
    auth.failNext('popupClosed');
    await expect(auth.signIn()).rejects.toMatchObject({ kind: 'popupClosed' });
    expect(auth.status()).toBe('signedOut');
    await auth.signIn();
    expect(auth.status()).toBe('signedIn');
  });

  it('invalidate → expired, signOut → signedOut, unconfigured rejects; calls recorded', async () => {
    const auth = createFakeAuth();
    const first = auth.token();
    auth.invalidate();
    expect(auth.status()).toBe('expired');
    await auth.ensureToken();
    expect(auth.token()).not.toBe(first);
    await auth.signOut();
    expect(auth.status()).toBe('signedOut');
    expect(auth.calls).toEqual(['invalidate', 'ensureToken', 'signOut']);
    const un = createFakeAuth('unconfigured');
    await expect(un.ensureToken()).rejects.toMatchObject({
      kind: 'unconfigured',
    });
  });
});
