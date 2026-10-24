/**
 * Privacy rule (plan sections 2.3 and 5): the user's audio never leaves the device. The analyzers never use the
 * network; as defence in depth every network path of the Worker's global scope is replaced by a function that
 * throws, before any analysis code runs (each `*.worker.ts` imports `./lockdown` FIRST).
 */

/** Globals that can send data out of a Worker (or start something that can). */
export const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebTransport',
  'EventSource',
  'importScripts',
  'Worker',
  'SharedWorker',
] as const;

export class NetworkForbiddenError extends Error {
  constructor(what: string) {
    super(`network access is forbidden in the analysis worker: ${what}`);
    this.name = 'NetworkForbiddenError';
  }
}

/** Replaces each network global of `scope` with a throwing function (non-writable, non-configurable). */
export function lockDownNetwork(scope: object): void {
  for (const k of NETWORK_GLOBALS) {
    try {
      Object.defineProperty(scope, k, {
        value: function forbidden() {
          throw new NetworkForbiddenError(k);
        },
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch {
      /* already locked (non-configurable): leave it */
    }
  }
}
