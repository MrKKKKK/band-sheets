/**
 * A MicSession for unit tests and Storybook (docs/mic-recording-plan.md §2.5, §3): no getUserMedia, no Web Audio.
 * Its clock only moves on `advance(sec)` (or every `tickMs` for stories), so 10 minutes or "1 minute left" take no
 * time. The audio goes through the REAL capture logic (captureCore.ts + captureRouter.ts): a synthetic hum, plus
 * every scheduled click heard `clickRoundTripMs` later (so a latency measurement with latency.ts succeeds), or
 * none (`clickRoundTripMs: null`, the measurement fails).
 */
import { clickSamples } from '../lib/mic/clickTrack';
import type { ReportedLatency } from '../lib/mic/latency';
import { CaptureCore } from './captureCore';
import { createCaptureRouter } from './captureRouter';
import {
  MicError,
  type MicDevice,
  type MicErrorKind,
  type MicHandlers,
  type MicInterruption,
  type MicSession,
  type OpenMic,
  type ScheduledClick,
} from './micSession';

export interface FakeMicOptions {
  /** Default: one mic `fake-mic` 「テスト用マイク」. [] = no mic (open fails with notFound). */
  devices?: MicDevice[];
  /** open() fails with this. */
  openError?: MicErrorKind;
  /** Default 48000. */
  sampleRate?: number;
  /** Default base 10 ms + output 40 ms. */
  latency?: ReportedLatency;
  /** How late a click shows up in the input (ms); null = never heard. Default 100. */
  clickRoundTripMs?: number | null;
  /** The input apart from the clicks. Default 'hum'. */
  voice?: 'hum' | 'silence';
  /** The clock moves by itself every `tickMs` (stories). Default: only advance(). */
  tickMs?: number;
}

export interface FakeMicSession extends MicSession {
  /** Moves the clock by `sec` (in 128-frame render quanta), producing levels / chunks / capture ends on the way. */
  advance(sec: number): void;
  /** The open mic reports `reason` (once). The input goes silent; `contextClosed` / `contextInterrupted` also stop the clock, and `contextClosed` ends the capture with `closed`. */
  interrupt(reason: MicInterruption): void;
  /** Replaces the device list and fires `devicechange`. */
  setDevices(devices: MicDevice[]): void;
  /** Every click scheduled so far (also the stopped ones). */
  readonly scheduled: readonly ScheduledClick[];
  readonly stats: {
    opens: number;
    closes: number;
    resumes: number;
    stopClicks: number;
  };
  /** The mic open now (null after close()). */
  readonly openMic: OpenMic | null;
}

const QUANTUM = 128;
const HUM_HZ = 220;

export function createFakeMicSession(
  opts: FakeMicOptions = {},
): FakeMicSession {
  const rate = opts.sampleRate ?? 48000;
  const latency = opts.latency ?? {
    baseLatencySec: 0.01,
    outputLatencySec: 0.04,
  };
  const roundTrip =
    opts.clickRoundTripMs === undefined ? 100 : opts.clickRoundTripMs;
  let devices: MicDevice[] = opts.devices ?? [
    { deviceId: 'fake-mic', label: 'テスト用マイク', isDefault: true },
  ];
  const deviceListeners = new Set<() => void>();
  const scheduled: ScheduledClick[] = [];
  const stats = { opens: 0, closes: 0, resumes: 0, stopClicks: 0 };
  const clickWave = {
    weak: clickSamples(rate, false),
    strong: clickSamples(rate, true),
  };

  let frame = 0;
  /** where advance() has been asked to go (frames, fractional): leftovers of a quantum carry over */
  let target = 0;
  let mic: {
    open: OpenMic;
    core: CaptureCore;
    handlers: MicHandlers;
    router: ReturnType<typeof createCaptureRouter>;
    /** clicks not stopped, as [start frame in the input, samples] */
    heard: { at: number; wave: Float32Array }[];
    silent: boolean;
    frozen: boolean;
    interrupted: boolean;
  } | null = null;

  function render(m: NonNullable<typeof mic>, start: number): Float32Array {
    const out = new Float32Array(QUANTUM);
    if (m.silent) return out;
    if (opts.voice !== 'silence')
      for (let i = 0; i < QUANTUM; i++)
        out[i] = 0.2 * Math.sin((2 * Math.PI * HUM_HZ * (start + i)) / rate);
    for (const c of m.heard) {
      const a = Math.max(start, c.at);
      const b = Math.min(start + QUANTUM, c.at + c.wave.length);
      for (let f = a; f < b; f++) out[f - start] += c.wave[f - c.at];
    }
    return out;
  }

  function advance(sec: number): void {
    if (mic?.frozen) return;
    target += sec * rate;
    while (frame + QUANTUM <= target + 1e-6) {
      const m = mic;
      if (m && !m.frozen) {
        m.heard = m.heard.filter((c) => c.at + c.wave.length > frame);
        m.core.process([render(m, frame)], frame, QUANTUM);
      }
      if (m?.frozen) {
        target = frame;
        return;
      }
      frame += QUANTUM;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const tickMs = opts.tickMs;

  async function open(
    deviceId: string | null,
    handlers: MicHandlers,
  ): Promise<OpenMic> {
    if (opts.openError) throw new MicError(opts.openError);
    const dev =
      deviceId === null
        ? (devices.find((d) => d.isDefault) ?? devices[0])
        : devices.find((d) => d.deviceId === deviceId);
    if (!dev) throw new MicError('notFound');
    await mic?.open.close();
    stats.opens++;
    const core = new CaptureCore((msg) =>
      queueMicrotask(() => m.router.receive(msg)),
    );
    const router = createCaptureRouter(
      rate,
      (cmd) => core.command(cmd),
      handlers.onLevel,
    );
    const m: NonNullable<typeof mic> = {
      core,
      handlers,
      router,
      heard: [],
      silent: false,
      frozen: false,
      interrupted: false,
      open: {
        deviceId: dev.deviceId,
        label: dev.label,
        sampleRate: rate,
        async resume() {
          stats.resumes++;
        },
        now: () => frame / rate,
        latencyNow: () => ({ ...latency }),
        scheduleClicks(list) {
          for (const c of list) {
            scheduled.push(c);
            if (roundTrip !== null)
              m.heard.push({
                at: Math.round((c.time + roundTrip / 1000) * rate),
                wave: c.strong ? clickWave.strong : clickWave.weak,
              });
          }
        },
        stopClicks() {
          stats.stopClicks++;
          m.heard = m.heard.filter((c) => c.at < frame);
        },
        startCapture: (from, end) => router.startCapture(from, end),
        async close() {
          if (mic !== m) return;
          stats.closes++;
          router.dispose();
          mic = null;
          if (timer !== null) clearInterval(timer);
          timer = null;
        },
      },
    };
    mic = m;
    if (tickMs !== undefined && timer === null)
      timer = setInterval(() => advance(tickMs / 1000), tickMs);
    return m.open;
  }

  return {
    async listDevices() {
      return devices.map((d) => ({ ...d }));
    },
    onDeviceChange(listener) {
      deviceListeners.add(listener);
      return () => deviceListeners.delete(listener);
    },
    open,
    advance,
    interrupt(reason) {
      const m = mic;
      if (!m || m.interrupted) return;
      m.interrupted = true;
      m.silent = true;
      if (reason === 'contextClosed' || reason === 'contextInterrupted')
        m.frozen = true;
      if (reason === 'contextClosed') m.router.dispose();
      m.handlers.onInterrupted(reason);
    },
    setDevices(list) {
      devices = list.map((d) => ({ ...d }));
      for (const l of deviceListeners) l();
    },
    scheduled,
    stats,
    get openMic() {
      return mic?.open ?? null;
    },
  };
}
