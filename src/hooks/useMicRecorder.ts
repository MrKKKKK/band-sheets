/**
 * 「マイクで録る」 (docs/mic-recording-plan.md §2.7): wires a MicSession (injected; tests and stories use
 * fakeMicSession.ts) and the storage to the pure reducer of lib/mic/recorderState.ts. The side effects run when a
 * phase is entered (`enter`): opening the mic, the latency measurement, the clock watch and making the file.
 *
 * - Clock: the AudioContext's (`OpenMic.now()`), read every TICK_MS by a timer while measuring / counting in /
 *   recording. Every click of a take is scheduled at the count-in start and the 10-minute end is enforced by the
 *   worklet, so a hidden tab (slow timers) keeps recording; the timer only drives the display.
 * - A context clock that stands still for STALL_MS while counting in / recording is an interruption (`stalled`):
 *   the session only reports state changes.
 * - Compensation = base + output latency read while the count-in clicks sound + this mic's remembered remainder
 *   (none = 0), fixed at the stop. The file starts at the count-in's first click + the compensation and ends at ■ +
 *   the compensation; the tail is awaited with a time limit (a stopped context never delivers it).
 * - M7 closes the mic (the browser's recording indicator goes away); a retake opens it again.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  isMicError,
  type Capture,
  type MicSession,
  type OpenMic,
} from '../audio/micSession';
import { MAX_DURATION_SEC } from '../lib/import/analysisTypes';
import type { TimeSig } from '../lib/melody';
import { barSec, clickBeats } from '../lib/mic/clickTrack';
import {
  compensationFrames,
  compensationSec,
  detectClicks,
  judgeLatency,
  MEASURE_CLICKS,
  type ReportedLatency,
} from '../lib/mic/latency';
import { announcementFor } from '../lib/mic/micTexts';
import {
  initialRecorderState,
  isTakeTooShort,
  recorderReducer,
  type Meter,
  type RecorderEvent,
  type RecorderPhase,
  type RecorderState,
  type StopCause,
  type TakeEnd,
  type TakeInfo,
} from '../lib/mic/recorderState';
import { peakBuckets } from '../lib/mic/takeBuffer';
import { encodeWav16 } from '../lib/mic/wav';
import {
  loadMicRemainder,
  saveMicRemainder,
  type KeyValueStorage,
} from '../lib/storage';

/** The clock watch's period (ms). */
export const TICK_MS = 50;
/** The context clock not moving this long (ms of wall time) while counting in / recording = interrupted. */
export const STALL_MS = 1000;
/** The count-in's first click is this far after ● (s), so it is never scheduled in the past. */
export const COUNT_IN_LEAD_SEC = 0.2;
/** Waiting for the take's tail after ■ / the limit: this + the compensation (ms). */
export const TAIL_WAIT_MS = 1500;
/** … and after an interruption (the context may never deliver it). */
export const INTERRUPTED_WAIT_MS = 500;
/** The measurement: first click this far after 遅れを測る, then one click every MEASURE_GAP_SEC. */
const MEASURE_LEAD_SEC = 0.3;
const MEASURE_GAP_SEC = 0.5;
/** Waveform bucket of the take's peaks (s). */
const PEAK_BUCKET_SEC = 0.01;
const TAKE_FILE_NAME = '録音.wav';

/**
 * A finished take (M7). `file` is a 16-bit mono WAV; 0 s = the count-in's first beat as heard. `meter` = the clicks'
 * tempo / time signature (analyze with these, not with S2's fields, which stay editable).
 */
export interface MicTake extends TakeInfo {
  file: File;
  /** the largest |sample| (0–1) of every 10 ms, for the waveform */
  peaks: Float32Array;
}

export interface UseMicRecorderOptions {
  /** Fixed for the hook's life. */
  session: MicSession;
  storage: KeyValueStorage | null;
  /** ♩ per minute and the time signature of the clicks (read at ●). */
  tempo: number;
  ts: TimeSig;
  /** The screen's one live region (S2's `say`). */
  announce?: (text: string) => void;
}

export interface MicRecorder {
  state: RecorderState;
  /**
   * The input's peak (0–1) while a mic is open, else 0: a store of its own (~23 changes a second), so only the
   * meter re-renders — read it with `useMicLevel`.
   */
  subscribeLevel(listener: () => void): () => void;
  getLevel(): number;
  /** In M7 / M8, else null; the same object while it lasts. */
  take: MicTake | null;
  /** 「マイクで録る」 chosen / a retry from M2. Asks for the permission. */
  open(): void;
  chooseMic(deviceId: string): void;
  /** 遅れを測る / もう一度測る (call it in the click: it resumes the context). */
  measure(): void;
  /** M4's 閉じる / 中止. */
  closeMeasure(): void;
  /** ● 録音 (call it in the click: it resumes the context). */
  record(): void;
  /** M5's やめる. */
  cancelCountIn(): void;
  /** ■ 止める. */
  stop(): void;
  /** 録り直す: asks first (M8). */
  retake(): void;
  cancelRetake(): void;
  confirmRetake(): void;
  /** Releases the mic (file tab chosen); a take is kept. Unmounting does it too. */
  close(): void;
}

interface Snapshot {
  state: RecorderState;
  take: MicTake | null;
}

interface EngineDeps {
  session: MicSession;
  storage: KeyValueStorage | null;
  onChange(s: Snapshot): void;
}

/** What may change from render to render (set by the hook's effect). */
interface EngineProps {
  meter: Meter;
  announce?: (text: string) => void;
}

const TICKING = new Set<RecorderPhase['phase']>([
  'measuring',
  'countIn',
  'recording',
]);

function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

function createEngine(deps: EngineDeps, initial: EngineProps) {
  let props = initial;
  let snap: Snapshot = { state: initialRecorderState, take: null };
  let level = 0;
  const levelListeners = new Set<() => void>();
  let mic: OpenMic | null = null;
  /** the capture of the measurement / the take */
  let active: Capture | null = null;
  let rec: {
    meter: Meter;
    /** context time of the count-in's first click */
    t0: number;
    t0Frame: number;
    limitFrame: number;
    latency: ReportedLatency | null;
    remainderMs: number | null;
  } | null = null;
  let measureFirstClick = 0;
  /** bumped by every async operation and by anything that abandons one */
  let gen = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stall = { now: -1, since: 0 };
  let unsubscribe: (() => void) | null = null;

  function setLevel(v: number) {
    if (v === level) return;
    level = v;
    for (const l of levelListeners) l();
  }

  function publish(patch: Partial<Snapshot>) {
    snap = { ...snap, ...patch };
    deps.onChange(snap);
  }

  function send(e: RecorderEvent) {
    const prev = snap.state;
    const next = recorderReducer(prev, e);
    if (next === prev) return;
    publish({ state: next });
    // before `enter`, which may send the next event at once
    const text = announcementFor(prev, next);
    if (text) props.announce?.(text);
    enter(prev, next);
  }

  function enter(prev: RecorderState, next: RecorderState) {
    if (TICKING.has(next.phase)) startTicking();
    else stopTicking();
    if (next.phase !== 'take' && next.phase !== 'confirmRetake' && snap.take)
      publish({ take: null });
    if (prev.phase === next.phase) return;
    const keepsCapture =
      (prev.phase === 'countIn' && next.phase === 'recording') ||
      (prev.phase === 'recording' && next.phase === 'finishing');
    if (TICKING.has(prev.phase) && !keepsCapture) abortActive();
    switch (next.phase) {
      case 'opening':
        void openMic(next.deviceId);
        break;
      case 'measuring':
        void runMeasurement();
        break;
      case 'finishing':
        void finish(next.end, next.stopSec);
        break;
      case 'closed':
        abortActive(); // also drops a buffered take (up to ~58 MB)
        closeMic();
        break;
    }
  }

  function closeMic() {
    const m = mic;
    mic = null;
    if (m) {
      m.stopClicks();
      void m.close();
    }
    setLevel(0);
  }

  /** Abandons the measurement / count-in: silence, end the capture, forget it. */
  function abortActive() {
    gen++;
    const a = active;
    active = null;
    rec = null;
    if (mic) {
      mic.stopClicks();
      a?.stop(Math.round(mic.now() * mic.sampleRate));
    }
  }

  async function refreshDevices() {
    const devices = await deps.session.listDevices();
    if (unsubscribe) send({ type: 'devices', devices });
  }

  async function openMic(deviceId: string | null) {
    const my = ++gen;
    closeMic();
    const box: { mic: OpenMic | null } = { mic: null };
    try {
      const m = await deps.session.open(deviceId, {
        onLevel(peak) {
          if (box.mic && box.mic === mic) setLevel(peak);
        },
        onInterrupted(reason) {
          if (box.mic && box.mic === mic) interrupt(reason);
        },
      });
      if (my !== gen) {
        void m.close();
        return;
      }
      box.mic = m;
      mic = m;
      send({
        type: 'opened',
        deviceId: m.deviceId,
        remainderMs: loadMicRemainder(deps.storage, m.deviceId),
      });
      void refreshDevices();
    } catch (e) {
      if (my !== gen) return;
      send({ type: 'openFailed', error: isMicError(e) ? e.kind : 'unknown' });
    }
  }

  function interrupt(cause: StopCause) {
    if (!mic) return;
    mic.stopClicks();
    send({ type: 'interrupted', cause, atSec: mic.now() });
  }

  async function runMeasurement() {
    const m = mic;
    if (!m) return send({ type: 'measureFailed' });
    const my = ++gen;
    const rate = m.sampleRate;
    const first = m.now() + MEASURE_LEAD_SEC;
    const clicks = Array.from({ length: MEASURE_CLICKS }, (_, i) => ({
      time: first + i * MEASURE_GAP_SEC,
      strong: false,
    }));
    const fromFrame = Math.round((first - 0.1) * rate);
    const endSec = clicks[clicks.length - 1].time + 0.45;
    const endFrame = Math.round(endSec * rate);
    measureFirstClick = first;
    m.scheduleClicks(clicks);
    const capture = m.startCapture(fromFrame, endFrame);
    active = capture;
    await waitAtMost(capture.done, (endSec - m.now()) * 1000 + TAIL_WAIT_MS);
    if (my !== gen) return;
    active = null;
    const reported = m.latencyNow();
    const samples = capture.buffer.sliceFloat(fromFrame, endFrame);
    const verdict = judgeLatency(
      detectClicks(
        samples,
        rate,
        clicks.map((c) => c.time * rate - fromFrame),
      ),
      reported,
    );
    if (!verdict.ok) return send({ type: 'measureFailed' });
    saveMicRemainder(deps.storage, m.deviceId, verdict.remainderMs);
    send({
      type: 'measureDone',
      remainderMs: verdict.remainderMs,
      spreadMs: verdict.spreadMs,
    });
  }

  function startTicking() {
    if (timer !== null) return;
    stall = { now: -1, since: Date.now() };
    timer = setInterval(tick, TICK_MS);
  }

  function stopTicking() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function tick() {
    const m = mic;
    if (!m) return;
    const now = m.now();
    const phase = snap.state.phase;
    if (phase === 'measuring') {
      const heard = Math.floor((now - measureFirstClick) / MEASURE_GAP_SEC) + 1;
      send({
        type: 'measureProgress',
        heard: Math.max(0, Math.min(MEASURE_CLICKS, heard)),
      });
      return;
    }
    if (!rec) return;
    if (now !== stall.now) stall = { now, since: Date.now() };
    else if (Date.now() - stall.since >= STALL_MS) return interrupt('stalled');
    // read while the clicks sound (Chromium may report 0 before); the latest reading is used
    if (now >= rec.t0) rec.latency = m.latencyNow();
    send({ type: 'tick', sinceCountInSec: now - rec.t0 });
  }

  function record() {
    const m = mic;
    if (snap.state.phase !== 'ready' || !m) return;
    void m.resume();
    const meter = props.meter;
    let beats;
    try {
      beats = clickBeats(meter.tempo, meter.ts, MAX_DURATION_SEC);
    } catch {
      return; // no valid tempo / time signature: the screen keeps ● disabled
    }
    const rate = m.sampleRate;
    const t0 = m.now() + COUNT_IN_LEAD_SEC;
    m.scheduleClicks(
      beats.map((b) => ({ time: t0 + b.sec, strong: b.strong })),
    );
    const t0Frame = Math.round(t0 * rate);
    // the file starts later by the compensation, so it ends a little under 600 s (accepted)
    const limitFrame = t0Frame + Math.round(MAX_DURATION_SEC * rate);
    const capture = m.startCapture(t0Frame, limitFrame);
    active = capture;
    rec = {
      meter,
      t0,
      t0Frame,
      limitFrame,
      latency: null,
      // the state's, not the storage's: a measurement that could not be stored still counts
      remainderMs: snap.state.remainderMs,
    };
    void capture.done.then((end) => {
      // the worklet ended it at 10 minutes (exact even when the timers lag)
      if (end.reason === 'limit' && active === capture)
        send({ type: 'tick', sinceCountInSec: MAX_DURATION_SEC });
    });
    send({ type: 'record', meter });
  }

  async function finish(end: TakeEnd, stopSec: number | null) {
    const m = mic;
    const capture = active;
    const r = rec;
    const my = ++gen;
    if (!m || !capture || !r) return send({ type: 'finished', take: null });
    m.stopClicks();
    const rate = m.sampleRate;
    const comp = compensationFrames(
      compensationSec({
        ...(r.latency ?? m.latencyNow()),
        remainderMs: r.remainderMs,
      }),
      rate,
    );
    const startFrame = r.t0Frame + comp;
    const endFrame =
      stopSec === null ? r.limitFrame : Math.round(stopSec * rate) + comp;
    capture.stop(endFrame);
    const interrupted = end !== 'user' && end !== 'limit';
    await waitAtMost(
      capture.done,
      interrupted ? INTERRUPTED_WAIT_MS : TAIL_WAIT_MS + (comp / rate) * 1000,
    );
    if (my !== gen) return;
    active = null;
    rec = null;
    // on a timeout: whatever reached the buffer (slice stops at the last captured frame)
    const slice = capture.buffer.slice(startFrame, endFrame);
    closeMic();
    const durationSec = slice.frames / rate;
    const bar1Sec = barSec(r.meter.tempo, r.meter.ts);
    if (isTakeTooShort(durationSec, bar1Sec))
      return send({ type: 'finished', take: null });
    const file = new File([encodeWav16(slice.chunks, rate)], TAKE_FILE_NAME, {
      type: 'audio/wav',
    });
    const info: TakeInfo = { durationSec, bar1Sec, meter: r.meter };
    publish({
      take: {
        ...info,
        file,
        peaks: peakBuckets(slice.chunks, Math.round(rate * PEAK_BUCKET_SEC)),
      },
    });
    send({ type: 'finished', take: info });
  }

  return {
    subscribeLevel(listener: () => void) {
      levelListeners.add(listener);
      return () => void levelListeners.delete(listener);
    },
    getLevel: () => level,
    configure(p: EngineProps) {
      props = p;
    },
    attach() {
      unsubscribe = deps.session.onDeviceChange(() => void refreshDevices());
    },
    /** Unmount: release everything; the engine can be attached again (StrictMode). */
    detach() {
      unsubscribe?.();
      unsubscribe = null;
      stopTicking();
      abortActive();
      send({ type: 'close' });
      gen++;
      closeMic();
    },
    open: () => send({ type: 'open' }),
    chooseMic: (deviceId: string) => send({ type: 'chooseMic', deviceId }),
    measure() {
      if (mic) void mic.resume();
      send({ type: 'measure' });
    },
    closeMeasure: () => send({ type: 'closeMeasure' }),
    record,
    cancelCountIn: () => send({ type: 'cancelCountIn' }),
    stop() {
      const phase = snap.state.phase;
      if (phase !== 'countIn' && phase !== 'recording') return;
      // a last reading while the clicks still sound, in case the ticks got none
      if (mic && rec && mic.now() >= rec.t0) rec.latency = mic.latencyNow();
      mic?.stopClicks();
      send({ type: 'stop', atSec: mic?.now() ?? 0 });
    },
    retake: () => send({ type: 'retake' }),
    cancelRetake: () => send({ type: 'cancelRetake' }),
    confirmRetake: () => send({ type: 'confirmRetake' }),
    close: () => send({ type: 'close' }),
  };
}

export function useMicRecorder(options: UseMicRecorderOptions): MicRecorder {
  const [snap, setSnap] = useState<Snapshot>({
    state: initialRecorderState,
    take: null,
  });
  const [engine] = useState(() =>
    createEngine(
      {
        session: options.session,
        storage: options.storage,
        onChange: setSnap,
      },
      {
        meter: { tempo: options.tempo, ts: options.ts },
        announce: options.announce,
      },
    ),
  );

  useEffect(() => {
    engine.configure({
      meter: { tempo: options.tempo, ts: options.ts },
      announce: options.announce,
    });
  });

  useEffect(() => {
    engine.attach();
    return () => engine.detach();
  }, [engine]);

  const { state } = snap;
  return {
    state,
    take:
      state.phase === 'take' || state.phase === 'confirmRetake'
        ? snap.take
        : null,
    subscribeLevel: engine.subscribeLevel,
    getLevel: engine.getLevel,
    open: engine.open,
    chooseMic: engine.chooseMic,
    measure: engine.measure,
    closeMeasure: engine.closeMeasure,
    record: engine.record,
    cancelCountIn: engine.cancelCountIn,
    stop: engine.stop,
    retake: engine.retake,
    cancelRetake: engine.cancelRetake,
    confirmRetake: engine.confirmRetake,
    close: engine.close,
  };
}

/** The open mic's level (0–1) for the meter; only the component that calls it re-renders. */
export function useMicLevel(
  recorder: Pick<MicRecorder, 'subscribeLevel' | 'getLevel'>,
): number {
  return useSyncExternalStore(recorder.subscribeLevel, recorder.getLevel);
}
