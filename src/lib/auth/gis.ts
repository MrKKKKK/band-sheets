/**
 * Google sign-in for Drive: Google Identity Services (GIS) token model,
 * browser only, scope `drive.file` (docs/m7-plan.md, decision 1).
 *
 * Verified against the official docs (2026-10-06):
 * - developers.google.com/identity/oauth2/web/guides/use-token-model:
 *   `google.accounts.oauth2.initTokenClient({ client_id, scope, callback })`
 *   then `requestAccessToken()`, which must run inside a user gesture
 *   ("a user-driven event such as a button press"); only the popup UX is
 *   supported; `google.accounts.oauth2.revoke(token, done)` removes consent.
 * - developers.google.com/identity/oauth2/web/reference/js-reference:
 *   TokenClientConfig `error_callback` receives `{ type }` with
 *   `popup_failed_to_open` | `popup_closed` | `unknown`; `prompt` defaults to
 *   'select_account'; the override `prompt: ''` means "the user will be
 *   prompted only the first time your app requests access"; TokenResponse
 *   has `access_token`, `expires_in` (seconds), `scope`, `error`,
 *   `error_description`.
 * - developers.google.com/identity/oauth2/web/guides/error: OAuth errors
 *   (e.g. access_denied) come to `callback` with `response.error` set;
 *   non-OAuth (popup) errors go to `error_callback`.
 *
 * There is no refresh token: an expired token is replaced by calling
 * `requestAccessToken({ prompt: '' })` synchronously inside a user gesture
 * (`ensureToken`). The token and its expiry are kept in `band-sheets:auth`
 * so a reload within the hour stays signed in. Never log the token.
 */

import { loadAuth, saveAuth, type KeyValueStorage } from '../storage';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
/** The token counts as expired this long before `expires_in` runs out. */
export const EXPIRY_MARGIN_MS = 60_000;

// --- The subset of `google.accounts.oauth2` this app uses -----------------

export interface GoogleTokenResponse {
  access_token?: string;
  /** Seconds. */
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleErrorEvent {
  type?: 'popup_failed_to_open' | 'popup_closed' | 'unknown' | string;
  message?: string;
}

export interface GoogleTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (r: GoogleTokenResponse) => void;
  error_callback?: (e: GoogleErrorEvent) => void;
  prompt?: string;
}

export interface GoogleTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

export interface GoogleOAuth2 {
  initTokenClient(config: GoogleTokenClientConfig): GoogleTokenClient;
  revoke(accessToken: string, done?: (r?: unknown) => void): void;
  /** Present in the real library (use-token-model guide); optional for fakes. */
  hasGrantedAllScopes?(
    tokenResponse: GoogleTokenResponse,
    firstScope: string,
    ...restScopes: string[]
  ): boolean;
}

// --- Public API (docs/m7-plan.md 「共通 API」) ----------------------------

export type AuthStatus = 'unconfigured' | 'signedOut' | 'signedIn' | 'expired';

export interface DriveAuth {
  status(): AuthStatus;
  /** 有効なトークンを返す。切れていれば同期的に GIS の要求を始める（必ずユーザー操作の中で呼ぶ） */
  ensureToken(opts?: { interactive?: boolean }): Promise<string>;
  signIn(): Promise<void>; // 同意画面を出す（prompt: 'consent' ではなく既定）
  signOut(): Promise<void>; // revoke + saveAuth(null)
  invalidate(): void; // 401 を受けたとき
  subscribe(fn: () => void): () => void;
}

export type AuthErrorKind =
  /** No client ID configured (VITE_GOOGLE_CLIENT_ID). */
  | 'unconfigured'
  /** No valid token and `interactive: false` was asked. */
  | 'needsSignIn'
  /** The popup could not open (blocked: called outside a user gesture). */
  | 'popupBlocked'
  /** The user closed the popup before finishing. */
  | 'popupClosed'
  /** OAuth error (e.g. access_denied) or the drive.file scope not granted. */
  | 'denied'
  /** The GIS script could not be loaded (offline, blocked). */
  | 'scriptLoad'
  | 'unknown';

export class AuthError extends Error {
  readonly kind: AuthErrorKind;
  constructor(kind: AuthErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

// --- Script loader ----------------------------------------------------------

interface GisWindow {
  google?: { accounts?: { oauth2?: GoogleOAuth2 } };
}

/**
 * Returns a loader that adds the GIS `<script>` once and resolves with
 * `google.accounts.oauth2`. A failed load removes the tag and lets the next
 * call try again. Exposed as a factory so tests get a fresh cache.
 */
export function createGisLoader(
  o: {
    doc?: Document;
    win?: GisWindow;
  } = {},
): () => Promise<GoogleOAuth2> {
  let pending: Promise<GoogleOAuth2> | null = null;
  return () => {
    const doc = o.doc ?? document;
    const win = o.win ?? (window as unknown as GisWindow);
    const ready = win.google?.accounts?.oauth2;
    if (ready) return Promise.resolve(ready);
    if (pending) return pending;
    pending = new Promise<GoogleOAuth2>((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      const fail = (message: string) => {
        script.remove();
        pending = null;
        reject(new AuthError('scriptLoad', message));
      };
      script.addEventListener('load', () => {
        const oauth2 = win.google?.accounts?.oauth2;
        if (oauth2) resolve(oauth2);
        else fail('GIS loaded without google.accounts.oauth2');
      });
      script.addEventListener('error', () => fail('GIS script failed'));
      doc.head.appendChild(script);
    });
    return pending;
  };
}

/** The app-wide loader (one `<script>` per page). */
export const loadGis: () => Promise<GoogleOAuth2> = createGisLoader();

// --- createGisAuth ----------------------------------------------------------

/** Longest delay setTimeout accepts (larger values fire immediately). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function createGisAuth(o: {
  clientId: string | undefined;
  storage: KeyValueStorage | null;
  loadScript?: () => Promise<GoogleOAuth2>;
  now?: () => number;
}): DriveAuth {
  const clientId = o.clientId?.trim() ?? '';
  const now = o.now ?? Date.now;
  const loadScript = o.loadScript ?? loadGis;
  const listeners = new Set<() => void>();

  let oauth2: GoogleOAuth2 | null = null;
  let client: GoogleTokenClient | null = null;
  let scriptPromise: Promise<GoogleOAuth2> | null = null;
  let request: {
    promise: Promise<string>;
    resolve: (t: string) => void;
    reject: (e: AuthError) => void;
  } | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatus: AuthStatus;

  function isValid(rec: { expiresAt: number } | null): boolean {
    return rec !== null && now() < rec.expiresAt - EXPIRY_MARGIN_MS;
  }

  function status(): AuthStatus {
    if (!clientId) return 'unconfigured';
    const rec = loadAuth(o.storage);
    if (!rec) return 'signedOut';
    return isValid(rec) ? 'signedIn' : 'expired';
  }

  function notify(): void {
    lastStatus = status();
    scheduleExpiry();
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // a listener's failure must not stop the others
      }
    }
  }

  /** Tell subscribers when a valid token turns into `expired`. */
  function scheduleExpiry(): void {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (listeners.size === 0 || lastStatus !== 'signedIn') return;
    const rec = loadAuth(o.storage);
    if (!rec) return;
    const delay = rec.expiresAt - EXPIRY_MARGIN_MS - now();
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (status() !== lastStatus) notify();
        else scheduleExpiry();
      },
      Math.min(Math.max(delay, 0), MAX_TIMEOUT_MS),
    );
  }

  function settle(r: GoogleTokenResponse): void {
    const req = request;
    request = null;
    if (!req) return;
    if (r.error || !r.access_token) {
      req.reject(
        new AuthError('denied', r.error_description ?? r.error ?? 'no token'),
      );
      return;
    }
    // Granular consent lets the user untick the Drive permission. Use GIS's
    // own hasGrantedAllScopes when available, else read `scope` ourselves.
    const granted = oauth2?.hasGrantedAllScopes
      ? oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE)
      : typeof r.scope !== 'string' ||
        r.scope.split(/\s+/).includes(DRIVE_SCOPE);
    if (!granted) {
      req.reject(new AuthError('denied', 'drive.file scope not granted'));
      return;
    }
    const seconds = Number(r.expires_in);
    const expiresAt =
      now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    saveAuth(o.storage, { accessToken: r.access_token, expiresAt });
    notify();
    req.resolve(r.access_token);
  }

  function settleError(e: GoogleErrorEvent): void {
    const req = request;
    request = null;
    if (!req) return;
    const kind: AuthErrorKind =
      e.type === 'popup_failed_to_open'
        ? 'popupBlocked'
        : e.type === 'popup_closed'
          ? 'popupClosed'
          : 'unknown';
    req.reject(new AuthError(kind, e.message));
  }

  function tokenClient(api: GoogleOAuth2): GoogleTokenClient {
    if (!client) {
      client = api.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: settle,
        error_callback: settleError,
      });
    }
    return client;
  }

  function startScript(): Promise<GoogleOAuth2> {
    if (!scriptPromise) {
      scriptPromise = loadScript().then(
        (api) => {
          oauth2 = api;
          return api;
        },
        (e: unknown) => {
          scriptPromise = null;
          throw isAuthError(e) ? e : new AuthError('scriptLoad', String(e));
        },
      );
    }
    return scriptPromise;
  }

  /**
   * Opens the GIS popup. When the script is already loaded this calls
   * `requestAccessToken` synchronously (still inside the caller's user
   * gesture). Otherwise it loads the script first; browsers usually keep the
   * gesture's transient activation for a short load, and if not GIS reports
   * `popup_failed_to_open` → 'popupBlocked' and a second click works.
   */
  function requestToken(prompt: string | undefined): Promise<string> {
    if (request) {
      // A new gesture while the popup is still pending (e.g. it was hidden
      // behind the window): ask again so GIS can (re)open it within this
      // gesture, but keep one shared promise.
      if (oauth2) {
        try {
          const c = tokenClient(oauth2);
          if (prompt === undefined) c.requestAccessToken();
          else c.requestAccessToken({ prompt });
        } catch {
          // the pending request still settles through the callbacks
        }
      }
      return request.promise;
    }
    let resolve!: (t: string) => void;
    let reject!: (e: AuthError) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const req = { promise, resolve, reject };
    request = req;
    const open = (api: GoogleOAuth2) => {
      try {
        const c = tokenClient(api);
        if (prompt === undefined) c.requestAccessToken();
        else c.requestAccessToken({ prompt });
      } catch (e) {
        if (request === req) request = null;
        reject(new AuthError('unknown', String(e)));
      }
    };
    if (oauth2) {
      open(oauth2);
    } else {
      startScript().then(open, (e: AuthError) => {
        if (request === req) request = null;
        reject(e);
      });
    }
    return promise;
  }

  // A returning user (token stored) will need GIS at their next save; load
  // it now so `ensureToken` can open the popup synchronously in the gesture.
  lastStatus = status();
  if (lastStatus === 'signedIn' || lastStatus === 'expired') {
    startScript().catch(() => {
      // reported again when a request needs the script
    });
  }

  return {
    status,

    ensureToken(opts) {
      if (!clientId) return Promise.reject(new AuthError('unconfigured'));
      const rec = loadAuth(o.storage);
      if (rec && isValid(rec)) return Promise.resolve(rec.accessToken);
      if (opts?.interactive === false) {
        return Promise.reject(new AuthError('needsSignIn'));
      }
      // prompt '' : no consent screen for a user who already granted access.
      return requestToken('');
    },

    async signIn() {
      if (!clientId) throw new AuthError('unconfigured');
      // Default prompt (select_account; consent the first time).
      await requestToken(undefined);
    },

    async signOut() {
      const rec = loadAuth(o.storage);
      saveAuth(o.storage, null);
      notify();
      if (!rec?.accessToken || !clientId) return;
      try {
        const api = oauth2 ?? (await startScript());
        await new Promise<void>((resolve) => {
          try {
            api.revoke(rec.accessToken, () => resolve());
          } catch {
            resolve();
          }
        });
      } catch {
        // Revoking is best effort; the local sign-out already happened.
      }
    },

    invalidate() {
      const rec = loadAuth(o.storage);
      if (!rec || !isValid(rec)) return;
      // Keep the record (status → 'expired', not 'signedOut') so the UI shows
      // "reconnect" instead of the first-time sign-in screen.
      saveAuth(o.storage, { accessToken: rec.accessToken, expiresAt: 0 });
      notify();
    },

    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1) {
        lastStatus = status();
        scheduleExpiry();
      }
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && expiryTimer !== null) {
          clearTimeout(expiryTimer);
          expiryTimer = null;
        }
      };
    },
  };
}
