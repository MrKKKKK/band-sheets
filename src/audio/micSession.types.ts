/**
 * The mic session's contract (docs/mic-recording-plan.md §2.5): what the recorder hook, the fake session and the capture
 * router depend on. The implementation is micSession.ts, which re-exports all of this.
 */
import type { ReportedLatency } from '../lib/mic/latency';
import type { TakeBuffer } from '../lib/mic/takeBuffer';
import type {
  MicDevice,
  MicErrorKind,
  MicInterruption,
} from '../lib/mic/micTypes';

export type { MicDevice, MicErrorKind, MicInterruption };

export class MicError extends Error {
  readonly kind: MicErrorKind;
  constructor(kind: MicErrorKind, cause?: unknown) {
    super(`mic: ${kind}`, { cause });
    this.name = 'MicError';
    this.kind = kind;
  }
}

export function isMicError(e: unknown): e is MicError {
  return e instanceof MicError;
}

export interface MicHandlers {
  /** Peak |sample| (0…1) of the last ~43 ms, about 23 times a second, while the mic is open. */
  onLevel?(peak: number): void;
  /** At most once per open mic. */
  onInterrupted(reason: MicInterruption): void;
}

/** One click on the context clock. */
export interface ScheduledClick {
  /** AudioContext time (seconds) */
  time: number;
  /** the downbeat (higher click) */
  strong: boolean;
}

export interface CaptureEnd {
  /** the end (exclusive) of the frames that reached `buffer` */
  frame: number;
  /** `limit` = reached the end frame given to startCapture (10 minutes); `closed` = the mic closed / broke first */
  reason: 'stopped' | 'limit' | 'closed';
}

export interface Capture {
  /** The captured frames, on the context's frame axis. Filled as chunks arrive. */
  readonly buffer: TakeBuffer;
  /**
   * Ends the capture at context frame `atFrame` (e.g. ■'s frame + the compensation, so the last sung note is kept);
   * a frame that has passed ends it at once. Ignored after the end.
   */
  stop(atFrame: number): void;
  /**
   * Resolves once the capture has ended and every frame before `frame` is in `buffer`. Never rejects. If the
   * context stops running without being closed (`contextInterrupted`) it may never resolve: wait with a time limit. After `workletError` (the worklet is dead: no chunks, level or end) it never resolves either.
   */
  readonly done: Promise<CaptureEnd>;
}

export interface OpenMic {
  /**
   * The device id of the opened track (`getSettings().deviceId`): the REAL device, never Chromium's virtual
   * `default` / `communications` when they have a real twin (a request for one is re-opened `{exact}` on the twin).
   */
  readonly deviceId: string;
  readonly label: string;
  readonly sampleRate: number;
  /** Resumes the context: call it in a click handler too (● 録音, 遅れを測る), the open's own call may come too late for the autoplay rule. */
  resume(): Promise<void>;
  /** The context clock (seconds). */
  now(): number;
  /** `baseLatency` + `outputLatency` as reported NOW: read it while clicks sound (Chromium may report 0 before). */
  latencyNow(): ReportedLatency;
  /** Schedules every click at once (all of a take, ~1200 at 120 bpm for 10 minutes). Adds to earlier ones. */
  scheduleClicks(clicks: readonly ScheduledClick[]): void;
  /** Silences every scheduled click (■, やめる, an interruption). */
  stopClicks(): void;
  /** Starts capturing frames [fromFrame, endFrame). One capture at a time: a new one ends the previous. */
  startCapture(fromFrame: number, endFrame: number): Capture;
  /** Stops the track and closes the context; pending captures resolve with `closed`. No interruption is reported. */
  close(): Promise<void>;
}

export interface MicSession {
  /** Audio inputs (Chromium's virtual entries folded); [] when the browser has none or cannot list them. */
  listDevices(): Promise<MicDevice[]>;
  /** `devicechange`; returns the unsubscribe. */
  onDeviceChange(listener: () => void): () => void;
  /** Asks for the permission if needed. `deviceId` null = the default input. Throws MicError. */
  open(deviceId: string | null, handlers: MicHandlers): Promise<OpenMic>;
}

/** Classifies a getUserMedia failure (only those: an AbortError elsewhere, e.g. addModule's, is not "busy"). */
export function micErrorOf(e: unknown): MicError {
  if (isMicError(e)) return e;
  // by name: OverconstrainedError is not an Error / DOMException in every browser
  const name =
    typeof e === 'object' && e !== null
      ? String((e as { name?: unknown }).name ?? '')
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicError('denied', e);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicError('notFound', e);
    case 'NotReadableError':
    case 'AbortError':
      return new MicError('busy', e);
    default:
      return new MicError('unknown', e);
  }
}
