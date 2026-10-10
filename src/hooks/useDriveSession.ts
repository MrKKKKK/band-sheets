/**
 * Sign-in state + the Drive client every M7 screen shares (docs/m7-plan.md,
 * T15). The other hooks (`useSongLibrary`, `useSongDocument`,
 * `useSongView`) take the returned `DriveSession`.
 *
 * Token rules (T8): `ensureToken()` may open the GIS popup, so it must be
 * called synchronously inside a click / key handler, BEFORE any `await`.
 * The Drive client itself only ever asks for the token non-interactively
 * (`ensureToken({ interactive: false })`), so a request made after an
 * `await` never tries to open a popup outside the user gesture.
 *
 * The client is wrapped so that any auth failure (Drive 401, or no valid
 * token any more) calls `auth.invalidate()` (status → 'expired', the
 * reconnect banner) and rejects with `DriveError('auth')`.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useEffect } from 'react';
import {
  isAuthError,
  type AuthErrorKind,
  type AuthStatus,
  type DriveAuth,
} from '../lib/auth/gis';
import { deviceName } from '../lib/deviceName';
import {
  DriveError,
  isDriveError,
  type DriveClient,
} from '../lib/drive/driveClient';
import { createFetchDriveClient } from '../lib/drive/fetchDriveClient';
import { driveErrorKind } from '../lib/drive/songSync';
import { loadDeviceName, type KeyValueStorage } from '../lib/storage';
import { clearDriveCache } from './useSongLibrary';

/** What a failed Drive / sign-in operation means for the UI (SaveState). */
export type FailReason = 'network' | 'auth' | 'other';

/**
 * Error → SaveState 'failed' reason. Sign-in problems (popup closed /
 * blocked, denied, needs sign-in) and Drive 401 are 'auth'; the GIS script
 * not loading and offline fetches are 'network'; the rest 'other'.
 */
export function failReason(e: unknown): FailReason {
  if (isAuthError(e)) {
    if (e.kind === 'scriptLoad') return 'network';
    if (e.kind === 'unconfigured' || e.kind === 'unknown') return 'other';
    return 'auth';
  }
  const kind = driveErrorKind(e);
  if (kind === 'auth') return 'auth';
  if (kind === 'network') return 'network';
  return 'other';
}

export interface DriveSession {
  auth: DriveAuth;
  /** Wrapped client (auth failures invalidate the token). */
  client: DriveClient;
  storage: KeyValueStorage | null;
  status: AuthStatus;
  /** A client ID is configured. */
  configured: boolean;
  /** Has (or had, now 'expired') a Drive sign-in: Drive songs stay Drive songs. */
  connected: boolean;
  /** This device's name (auto-detected once, then fixed). */
  device: string;
  /** auth.ensureToken() — call synchronously in a user gesture, before any await. */
  ensureToken(): Promise<string>;
  /** First sign-in (call in the click handler). Resolves true on success. */
  signIn(): Promise<boolean>;
  signingIn: boolean;
  signInError: AuthErrorKind | null;
  /** Revoke + forget the token and the Drive cache. Unsaved drafts stay. */
  signOut(): Promise<void>;
}

function detectDevice(): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return deviceName({
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
  });
}

/** Wraps every client method: auth failures → invalidate + DriveError('auth'). */
export function withAuthInvalidation(
  client: DriveClient,
  auth: DriveAuth,
): DriveClient {
  const onError = (e: unknown): never => {
    if (isAuthError(e)) {
      auth.invalidate();
      throw new DriveError('auth', undefined, e.message);
    }
    if (isDriveError(e) && e.kind === 'auth') auth.invalidate();
    throw e;
  };
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      try {
        return fn(...a).catch(onError);
      } catch (e) {
        return Promise.reject(e).catch(onError);
      }
    };
  return {
    findFolder: wrap((n) => client.findFolder(n)),
    createFolder: wrap((n, p) => client.createFolder(n, p)),
    listFiles: wrap((id) => client.listFiles(id)),
    getMeta: wrap((id) => client.getMeta(id)),
    download: wrap((id) => client.download(id)),
    create: wrap((a) => client.create(a)),
    update: wrap((id, a) => client.update(id, a)),
    trash: wrap((id) => client.trash(id)),
  };
}

export function useDriveSession(o: {
  auth: DriveAuth;
  storage: KeyValueStorage | null;
  /** Tests / stories inject a fake; default is the fetch client. */
  client?: DriveClient;
  /** Device detection (default: navigator). */
  detectDevice?: () => string;
}): DriveSession {
  const { auth, storage } = o;
  const status = useSyncExternalStore(auth.subscribe, auth.status, auth.status);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<AuthErrorKind | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const detect = o.detectDevice ?? detectDevice;
  const [device] = useState(() => loadDeviceName(storage, detect));

  const injected = o.client;
  const client = useMemo(
    () =>
      withAuthInvalidation(
        injected ??
          createFetchDriveClient({
            getToken: () => auth.ensureToken({ interactive: false }),
          }),
        auth,
      ),
    [auth, injected],
  );

  const ensureToken = useCallback(() => auth.ensureToken(), [auth]);

  const signIn = useCallback((): Promise<boolean> => {
    // auth.signIn() opens the popup synchronously: keep it first.
    const p = auth.signIn();
    setSigningIn(true);
    setSignInError(null);
    return p.then(
      () => {
        if (alive.current) setSigningIn(false);
        return true;
      },
      (e: unknown) => {
        if (alive.current) {
          setSigningIn(false);
          setSignInError(isAuthError(e) ? e.kind : 'unknown');
        }
        return false;
      },
    );
  }, [auth]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    clearDriveCache(storage);
  }, [auth, storage]);

  return useMemo(
    () => ({
      auth,
      client,
      storage,
      status,
      configured: status !== 'unconfigured',
      connected: status === 'signedIn' || status === 'expired',
      device,
      ensureToken,
      signIn,
      signingIn,
      signInError,
      signOut,
    }),
    [
      auth,
      client,
      storage,
      status,
      device,
      ensureToken,
      signIn,
      signingIn,
      signInError,
      signOut,
    ],
  );
}
