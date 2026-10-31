/**
 * The states of 「マイクで録る」 (docs/mic-recording-plan.md §2.6, canvas M2–M8) as a pure reducer. Every
 * time-based decision comes in as a value (`tick`'s seconds, `stop`'s context time), so the whole table is
 * unit-tested without a clock; useMicRecorder.ts does the side effects when a phase is entered.
 *
 * closed ─open→ opening ─opened→ ready (M3) ─record→ countIn (M5) ─tick ≥ 1 bar→ recording (M6)
 *                     └─openFailed→ micError (M2)          │                      │ stop / 600 s / interruption
 *   ready ─measure→ measuring (M4) → measured / measureFailed ─closeMeasure→ ready  ↓
 *   take (M7) ←finished─ finishing ; take ─retake→ confirmRetake (M8) ─confirmRetake→ opening
 * An interruption outside a recording (M3, M4, M5) reopens the mic and nothing is kept; one during a recording
 * keeps what was recorded (finishing → take, with the reason).
 */
import type {
  MicDevice,
  MicErrorKind,
  MicInterruption,
} from '../../audio/micSession';
import { MAX_DURATION_SEC } from '../import/analysisTypes';
import type { TimeSig } from '../melody';
import { barSec, positionAt } from './clickTrack';

/** Why the mic stopped by itself: the session's reasons, or the context clock standing still (`stalled`). */
export type StopCause = MicInterruption | 'stalled';

/** How a recording ended: ■ (`user`), the 10-minute limit, or an interruption. */
export type TakeEnd = 'user' | 'limit' | StopCause;

/** A message shown in M3 after coming back to it. */
export type ReadyNotice =
  /** the chosen mic disappeared; the default one was opened */
  | { kind: 'deviceGone' }
  /** stopped before bar 1: nothing kept */
  | { kind: 'tooShort' }
  /** the mic stopped working during the count-in (nothing kept) or while waiting (M3 / M4): it was reopened */
  | { kind: 'micStopped'; cause: StopCause; during: 'countIn' | 'idle' };

export interface TakeInfo {
  /** the file's length (s); 0 s = the count-in's first beat as heard */
  durationSec: number;
  /** where bar 1 starts in the file (s) = one bar */
  bar1Sec: number;
}

export interface Meter {
  tempo: number;
  ts: TimeSig;
}

export type RecorderPhase =
  | { phase: 'closed' }
  | { phase: 'opening'; notice: ReadyNotice | null }
  | { phase: 'micError'; error: MicErrorKind }
  | { phase: 'ready'; notice: ReadyNotice | null }
  /** M4 A; `heard` = clicks played so far (0–4) */
  | { phase: 'measuring'; heard: number }
  /** M4 B; the new remainder is `remainderMs` */
  | { phase: 'measured'; spreadMs: number }
  | { phase: 'measureFailed' }
  /** M5; `beat` = the count-in beat sounding (1-based), 0 before the first click */
  | { phase: 'countIn'; meter: Meter; beat: number }
  /** M6 */
  | {
      phase: 'recording';
      meter: Meter;
      /** whole seconds since bar 1 */
      elapsedSec: number;
      /** 1 = the song's first bar */
      bar: number;
      beat: number;
      /** whole seconds until the file is 600 s long, from 9 minutes on; else null */
      remainingSec: number | null;
    }
  /** after ■ / the limit / an interruption: the hook waits for the tail and makes the file */
  | {
      phase: 'finishing';
      end: TakeEnd;
      /** context time of ■ / the interruption; null for the limit (the capture ended itself) */
      stopSec: number | null;
    }
  /** M7 (the mic is closed) */
  | { phase: 'take'; take: TakeInfo; end: TakeEnd }
  /** M8 over M7 */
  | { phase: 'confirmRetake'; take: TakeInfo; end: TakeEnd };

export type RecorderState = RecorderPhase & {
  devices: MicDevice[];
  /** the mic to open / that is open: the REAL id once opened; null = the default input */
  deviceId: string | null;
  /** the remembered remainder of the open mic (ms); null = not measured */
  remainderMs: number | null;
  /** 「残り 1 分」 was announced for this recording */
  oneMinuteAnnounced: boolean;
};

export type RecorderEvent =
  /** 「マイクで録る」 chosen, or a retry from M2 */
  | { type: 'open' }
  | { type: 'opened'; deviceId: string; remainderMs: number | null }
  | { type: 'openFailed'; error: MicErrorKind }
  | { type: 'devices'; devices: MicDevice[] }
  | { type: 'chooseMic'; deviceId: string }
  | { type: 'measure' }
  | { type: 'measureProgress'; heard: number }
  | { type: 'measureDone'; remainderMs: number; spreadMs: number }
  | { type: 'measureFailed' }
  /** M4's 閉じる / 中止 */
  | { type: 'closeMeasure' }
  | { type: 'record'; meter: Meter }
  /** the clock: seconds since the count-in's first beat (negative before it) */
  | { type: 'tick'; sinceCountInSec: number }
  /** M5's 「やめる」 */
  | { type: 'cancelCountIn' }
  /** ■ at context time `atSec` */
  | { type: 'stop'; atSec: number }
  | { type: 'interrupted'; cause: StopCause; atSec: number }
  /** the file is made (null = nothing after bar 1: too short) */
  | { type: 'finished'; take: TakeInfo | null }
  | { type: 'retake' }
  | { type: 'cancelRetake' }
  | { type: 'confirmRetake' }
  /** leaving 「マイクで録る」 (the file tab, the screen): releases the mic; a take is kept */
  | { type: 'close' };

/** The file length from which the remaining time is shown and 「残り 1 分」 announced. */
export const REMAINING_FROM_SEC = MAX_DURATION_SEC - 60;
/** A take shorter than this cannot be analyzed ('too-short'). */
export const MIN_TAKE_SEC = 1;

export const initialRecorderState: RecorderState = {
  phase: 'closed',
  devices: [],
  deviceId: null,
  remainderMs: null,
  oneMinuteAnnounced: false,
};

/** Too short to keep: nothing after bar 1, or shorter than the analysis accepts. */
export function isTakeTooShort(durationSec: number, bar1Sec: number): boolean {
  return !(durationSec > bar1Sec && durationSec >= MIN_TAKE_SEC);
}

/** The phases in which an open mic waits (M3, M4): a vanished device or an interruption reopens it. */
const IDLE_OPEN = new Set<RecorderPhase['phase']>([
  'ready',
  'measuring',
  'measured',
  'measureFailed',
]);

function common(s: RecorderState) {
  return {
    devices: s.devices,
    deviceId: s.deviceId,
    remainderMs: s.remainderMs,
    oneMinuteAnnounced: s.oneMinuteAnnounced,
  };
}

function to(s: RecorderState, phase: RecorderPhase): RecorderState {
  return { ...common(s), ...phase };
}

function reopen(
  s: RecorderState,
  deviceId: string | null,
  notice: ReadyNotice | null,
): RecorderState {
  return {
    ...common(s),
    deviceId,
    remainderMs: null,
    phase: 'opening',
    notice,
  };
}

/** The device to open again: the remembered one while it is still listed (or nothing is listed yet), else the default. */
function stillThere(s: RecorderState): string | null {
  if (s.deviceId === null) return null;
  return s.devices.length === 0 ||
    s.devices.some((d) => d.deviceId === s.deviceId)
    ? s.deviceId
    : null;
}

function onTick(s: RecorderState, sec: number): RecorderState {
  if (s.phase === 'countIn') {
    const bar = barSec(s.meter.tempo, s.meter.ts);
    if (sec < bar) {
      const beat =
        sec < 0 ? 0 : positionAt(sec, s.meter.tempo, s.meter.ts).beat;
      return beat === s.beat ? s : { ...s, beat };
    }
    return onTick(
      to(s, {
        phase: 'recording',
        meter: s.meter,
        elapsedSec: 0,
        bar: 1,
        beat: 1,
        remainingSec: null,
      }),
      sec,
    );
  }
  if (s.phase !== 'recording') return s;
  if (sec >= MAX_DURATION_SEC)
    return to(s, { phase: 'finishing', end: 'limit', stopSec: null });
  const { tempo, ts } = s.meter;
  const pos = positionAt(sec, tempo, ts);
  const elapsedSec = Math.max(0, Math.floor(sec - barSec(tempo, ts)));
  const remainingSec =
    sec >= REMAINING_FROM_SEC ? Math.ceil(MAX_DURATION_SEC - sec) : null;
  const oneMinuteAnnounced = s.oneMinuteAnnounced || remainingSec !== null;
  if (
    pos.bar === s.bar &&
    pos.beat === s.beat &&
    elapsedSec === s.elapsedSec &&
    remainingSec === s.remainingSec &&
    oneMinuteAnnounced === s.oneMinuteAnnounced
  )
    return s;
  return {
    ...s,
    bar: Math.max(1, pos.bar),
    beat: pos.beat,
    elapsedSec,
    remainingSec,
    oneMinuteAnnounced,
  };
}

export function recorderReducer(
  s: RecorderState,
  e: RecorderEvent,
): RecorderState {
  switch (e.type) {
    case 'open':
      return s.phase === 'closed' || s.phase === 'micError'
        ? reopen(s, s.phase === 'micError' ? null : stillThere(s), null)
        : s;
    case 'opened':
      return s.phase === 'opening'
        ? {
            ...to(s, { phase: 'ready', notice: s.notice }),
            deviceId: e.deviceId,
            remainderMs: e.remainderMs,
          }
        : s;
    case 'openFailed':
      return s.phase === 'opening'
        ? to(s, { phase: 'micError', error: e.error })
        : s;
    case 'devices': {
      const next = { ...s, devices: e.devices };
      if (
        IDLE_OPEN.has(s.phase) &&
        s.deviceId !== null &&
        !e.devices.some((d) => d.deviceId === s.deviceId)
      )
        return reopen(next, null, { kind: 'deviceGone' });
      return next;
    }
    case 'chooseMic':
      return s.phase === 'ready' && e.deviceId !== s.deviceId
        ? reopen(s, e.deviceId, null)
        : s;
    case 'measure':
      return s.phase === 'ready' ||
        s.phase === 'measured' ||
        s.phase === 'measureFailed'
        ? to(s, { phase: 'measuring', heard: 0 })
        : s;
    case 'measureProgress':
      return s.phase === 'measuring' && e.heard !== s.heard
        ? { ...s, heard: e.heard }
        : s;
    case 'measureDone':
      return s.phase === 'measuring'
        ? {
            ...to(s, { phase: 'measured', spreadMs: e.spreadMs }),
            remainderMs: e.remainderMs,
          }
        : s;
    case 'measureFailed':
      return s.phase === 'measuring' ? to(s, { phase: 'measureFailed' }) : s;
    case 'closeMeasure':
      return s.phase === 'measuring' ||
        s.phase === 'measured' ||
        s.phase === 'measureFailed'
        ? to(s, { phase: 'ready', notice: null })
        : s;
    case 'record':
      return s.phase === 'ready'
        ? {
            ...to(s, { phase: 'countIn', meter: e.meter, beat: 0 }),
            oneMinuteAnnounced: false,
          }
        : s;
    case 'tick':
      return onTick(s, e.sinceCountInSec);
    case 'cancelCountIn':
      return s.phase === 'countIn'
        ? to(s, { phase: 'ready', notice: null })
        : s;
    case 'stop':
      if (s.phase === 'countIn')
        return to(s, { phase: 'ready', notice: { kind: 'tooShort' } });
      return s.phase === 'recording'
        ? to(s, { phase: 'finishing', end: 'user', stopSec: e.atSec })
        : s;
    case 'interrupted':
      if (s.phase === 'recording')
        return to(s, { phase: 'finishing', end: e.cause, stopSec: e.atSec });
      if (s.phase === 'countIn')
        return reopen(s, stillThere(s), {
          kind: 'micStopped',
          cause: e.cause,
          during: 'countIn',
        });
      if (IDLE_OPEN.has(s.phase))
        return reopen(s, stillThere(s), {
          kind: 'micStopped',
          cause: e.cause,
          during: 'idle',
        });
      return s;
    case 'finished':
      if (s.phase !== 'finishing') return s;
      return e.take
        ? to(s, { phase: 'take', take: e.take, end: s.end })
        : // the mic is closed by then: back to M3 through a reopen
          reopen(s, stillThere(s), { kind: 'tooShort' });
    case 'retake':
      return s.phase === 'take'
        ? to(s, { phase: 'confirmRetake', take: s.take, end: s.end })
        : s;
    case 'cancelRetake':
      return s.phase === 'confirmRetake'
        ? to(s, { phase: 'take', take: s.take, end: s.end })
        : s;
    case 'confirmRetake':
      return s.phase === 'confirmRetake' ? reopen(s, stillThere(s), null) : s;
    case 'close':
      // a take stays on the screen (the mic is already closed); everything else releases the mic
      return s.phase === 'take' ||
        s.phase === 'confirmRetake' ||
        s.phase === 'closed'
        ? s
        : to(s, { phase: 'closed' });
  }
}
