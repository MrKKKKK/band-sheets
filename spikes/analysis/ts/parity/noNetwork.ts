/**
 * Test helper: make any network use from analysis code fail loudly (privacy rule: user audio
 * never leaves the device). Stubs fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon.
 * Call in beforeEach (or at the top of a test) and undo with `vi.unstubAllGlobals()`.
 * Limit: does not intercept node:http / node:net; the TS code must not import them anyway.
 */
import { vi } from 'vitest';

export class NetworkAccessError extends Error {
  constructor(what: string) {
    super(`network access is forbidden in analysis code: ${what}`);
    this.name = 'NetworkAccessError';
  }
}

function forbidden(what: string) {
  return function () {
    throw new NetworkAccessError(what);
  };
}

export function stubNoNetwork(): void {
  vi.stubGlobal('fetch', forbidden('fetch'));
  vi.stubGlobal('XMLHttpRequest', forbidden('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', forbidden('WebSocket'));
  vi.stubGlobal('EventSource', forbidden('EventSource'));
  const nav = (globalThis as { navigator?: object }).navigator;
  if (nav) vi.stubGlobal('navigator', { ...nav, sendBeacon: forbidden('sendBeacon') });
  else vi.stubGlobal('navigator', { sendBeacon: forbidden('sendBeacon') });
}
