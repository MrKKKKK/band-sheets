/**
 * The microphone's public types (docs/mic-recording-plan.md §2.5), kept in lib so the pure recorder state and texts
 * do not import from `src/audio/`; `src/audio/micSession.ts` re-exports them.
 */

/** An input device as the user should see it: Chromium's virtual `default` / `communications` entries are folded into the real device. */
export interface MicDevice {
  /** the REAL device id (also the key of the remembered latency) */
  deviceId: string;
  /** empty until the permission was given once */
  label: string;
  /** the system's default input */
  isDefault: boolean;
}

export type MicErrorKind =
  /** NotAllowedError / SecurityError */
  | 'denied'
  /** NotFoundError / OverconstrainedError (the chosen device is gone) */
  | 'notFound'
  /** NotReadableError / AbortError: another app holds it, or the OS failed */
  | 'busy'
  /** no getUserMedia / AudioContext / AudioWorklet */
  | 'unsupported'
  | 'unknown';

/**
 * Why an open mic stopped working by itself. A hidden tab is NOT one.
 * - `ended`: the track ended (unplugged, permission revoked);
 * - `contextClosed` / `contextInterrupted`: the AudioContext closed, or was interrupted / suspended after running
 *   (not by `close()`);
 * - `workletError`: the capture processor threw.
 * A context that just stalls (no state change) is not reported: the caller watches `now()` for that.
 */
export type MicInterruption =
  'ended' | 'contextClosed' | 'contextInterrupted' | 'workletError';
