/**
 * In-memory `DriveAuth` for unit tests and stories (never loads GIS).
 * `ensureToken`/`signIn` succeed immediately (status → 'signedIn') unless a
 * failure was queued with `failNext`.
 */

import {
  AuthError,
  type AuthErrorKind,
  type AuthStatus,
  type DriveAuth,
} from './gis';

export interface FakeAuth extends DriveAuth {
  setStatus(s: AuthStatus): void;
  /** Make the next `n` interactive requests (ensureToken/signIn) fail. */
  failNext(kind: AuthErrorKind, n?: number): void;
  /** Method names in call order, e.g. ['ensureToken', 'invalidate']. */
  calls: string[];
  /** The token `ensureToken` returns; changes on every new grant. */
  token(): string;
}

export function createFakeAuth(initial: AuthStatus = 'signedIn'): FakeAuth {
  let status = initial;
  let grants = initial === 'signedIn' ? 1 : 0;
  const failures: AuthErrorKind[] = [];
  const listeners = new Set<() => void>();
  const calls: string[] = [];

  const token = () => `fake-token-${grants}`;
  const set = (s: AuthStatus) => {
    if (s === status) return;
    status = s;
    for (const fn of [...listeners]) fn();
  };
  const grant = (): Promise<string> => {
    const kind = failures.shift();
    if (kind) return Promise.reject(new AuthError(kind));
    grants += 1;
    set('signedIn');
    return Promise.resolve(token());
  };

  return {
    calls,
    token,
    status: () => status,
    setStatus(s) {
      if (s === 'signedIn' && status !== 'signedIn') grants += 1;
      set(s);
    },
    failNext(kind, n = 1) {
      for (let i = 0; i < n; i += 1) failures.push(kind);
    },
    ensureToken(opts) {
      calls.push('ensureToken');
      if (status === 'unconfigured') {
        return Promise.reject(new AuthError('unconfigured'));
      }
      if (status === 'signedIn') return Promise.resolve(token());
      if (opts?.interactive === false) {
        return Promise.reject(new AuthError('needsSignIn'));
      }
      return grant();
    },
    async signIn() {
      calls.push('signIn');
      if (status === 'unconfigured') throw new AuthError('unconfigured');
      await grant();
    },
    async signOut() {
      calls.push('signOut');
      if (status !== 'unconfigured') set('signedOut');
    },
    invalidate() {
      calls.push('invalidate');
      if (status === 'signedIn') set('expired');
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
