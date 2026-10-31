/**
 * The microphone for 「鼻歌から下書き」 (docs/mic-recording-plan.md §2.5): device list, opening one mic, the capture
 * AudioWorklet, the click track and the reported output latency. The one entry the screen swaps for
 * fakeMicSession.ts in tests and stories. PC Chromium is the target (like the analysis).
 *
 * Clock: everything is in the AudioContext's time. `now()` is its `currentTime` (seconds); a frame is
 * `round(seconds * sampleRate)`. The caller (useMicRecorder, T4) picks the count-in start on that clock, schedules
 * every click of the take at once (`scheduleClicks`; nothing depends on main-thread timers, so a hidden tab keeps
 * recording and clicking) and starts the capture with the 10-minute end frame, which the worklet enforces itself.
 *
 * Nothing leaves the page: the samples go to the caller's TakeBuffer only.
 */
import type { TakeBuffer } from '../lib/mic/takeBuffer';
import { clickSamples } from '../lib/mic/clickTrack';
import type { ReportedLatency } from '../lib/mic/latency';
import { CAPTURE_PROCESSOR, type CaptureMessage } from './captureCore';
import { createCaptureRouter } from './captureRouter';
import captureWorkletUrl from './capture.worklet.ts?worker&url';

/** The worklet module's URL: dev `/src/audio/capture.worklet.ts?worker_file&type=module`, build `assets/capture.worklet-*.js` (same origin either way). */
export const CAPTURE_WORKLET_URL = captureWorkletUrl;

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
   * context stops running without being closed (`contextInterrupted`) it may never resolve: wait with a time limit.
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

// --- device ids ---------------------------------------------------------------------------------------------

const VIRTUAL_IDS = new Set(['default', 'communications']);

type DeviceLike = Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'label'>;

/**
 * The real input behind a virtual entry: the only real input with its `groupId`, else the only one whose label ends
 * the virtual label after " - " (Windows: 「既定 - USB Mic」 / "Default - USB Mic"). Chromium's fake device has a
 * `default` of its own (no twin).
 */
function twinOf(
  v: Pick<DeviceLike, 'groupId' | 'label'>,
  inputs: readonly DeviceLike[],
): DeviceLike | undefined {
  const real = inputs.filter((d) => !VIRTUAL_IDS.has(d.deviceId));
  const byGroup = v.groupId ? real.filter((d) => d.groupId === v.groupId) : [];
  if (byGroup.length === 1) return byGroup[0];
  const byLabel = real.filter(
    (d) => d.label && v.label.endsWith(` - ${d.label}`),
  );
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

const audioInputs = (devices: readonly MediaDeviceInfo[]) =>
  devices.filter((d) => d.kind === 'audioinput');

/**
 * Folds Chromium's virtual `default` / `communications` entries into their real twins (`twinOf`); the twin of
 * `default` gets `isDefault`. A `default` with no twin is kept as it is (a device of its own); a lonely
 * `communications` is dropped.
 */
export function foldDevices(devices: readonly MediaDeviceInfo[]): MicDevice[] {
  const inputs = audioInputs(devices);
  const def = inputs.find((d) => d.deviceId === 'default');
  const defaultId = def ? (twinOf(def, inputs)?.deviceId ?? 'default') : null;
  const out: MicDevice[] = [];
  for (const d of inputs) {
    if (VIRTUAL_IDS.has(d.deviceId) && twinOf(d, inputs)) continue;
    if (d.deviceId === 'communications') continue;
    out.push({
      deviceId: d.deviceId,
      label: d.label,
      isDefault:
        defaultId !== null ? d.deviceId === defaultId : out.length === 0,
    });
  }
  return out;
}

/** The real device behind `id` (a virtual id → its twin); `id` itself when it is real or has no twin. */
function realIdOf(
  id: string,
  groupId: string | undefined,
  devices: readonly MediaDeviceInfo[],
): string {
  if (!VIRTUAL_IDS.has(id)) return id;
  const inputs = audioInputs(devices);
  const v = inputs.find((d) => d.deviceId === id);
  return (
    twinOf(
      { groupId: groupId || v?.groupId || '', label: v?.label ?? '' },
      inputs,
    )?.deviceId ?? id
  );
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

// --- the capture graph ----------------------------------------------------------------------------------------

export interface CaptureGraph {
  startCapture(fromFrame: number, endFrame: number): Capture;
  /** Resolves every pending capture with `closed` and detaches the port. */
  dispose(): void;
}

/**
 * Loads the capture worklet into `ctx` and wires `source` → worklet → destination (the worklet writes silence; the
 * connection only makes the context pull it). Also used by the story that checks the module loads in a real browser.
 */
export async function connectCapture(
  ctx: BaseAudioContext,
  source: AudioNode,
  handlers: Pick<MicHandlers, 'onLevel'> & { onError?(): void } = {},
): Promise<CaptureGraph> {
  await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
  const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const router = createCaptureRouter(
    ctx.sampleRate,
    (cmd) => node.port.postMessage(cmd),
    handlers.onLevel,
  );
  node.port.onmessage = (e: MessageEvent<CaptureMessage>) =>
    router.receive(e.data);
  node.onprocessorerror = () => handlers.onError?.();
  source.connect(node);
  node.connect(ctx.destination);
  return {
    startCapture: router.startCapture,
    dispose() {
      router.dispose();
      node.port.onmessage = null;
      node.onprocessorerror = null;
    },
  };
}

// --- the real session --------------------------------------------------------------------------------------------

export interface MicSessionDeps {
  mediaDevices?: MediaDevices;
  createContext?: (options: AudioContextOptions) => AudioContext;
  connect?: typeof connectCapture;
}

const CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export function createMicSession(deps: MicSessionDeps = {}): MicSession {
  const md = (): MediaDevices | undefined =>
    deps.mediaDevices ??
    (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  const createContext =
    deps.createContext ?? ((o: AudioContextOptions) => new AudioContext(o));
  const connect = deps.connect ?? connectCapture;

  async function enumerate(): Promise<MediaDeviceInfo[]> {
    try {
      return (await md()?.enumerateDevices()) ?? [];
    } catch {
      return [];
    }
  }

  async function getStream(deviceId: string | null): Promise<MediaStream> {
    const m = md();
    if (!m?.getUserMedia) throw new MicError('unsupported');
    try {
      return await m.getUserMedia({
        audio: deviceId
          ? { ...CONSTRAINTS, deviceId: { exact: deviceId } }
          : CONSTRAINTS,
      });
    } catch (e) {
      throw micErrorOf(e);
    }
  }

  const stopStream = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());

  /**
   * Opens the device and makes sure the track is the REAL device: a request for the default (or a virtual id)
   * that lands on `default` / `communications` is re-opened with the real id `{exact}`.
   */
  async function openTrack(
    deviceId: string | null,
  ): Promise<{ stream: MediaStream; track: MediaStreamTrack; realId: string }> {
    // with an earlier permission the list already has the real ids and labels
    const wanted =
      deviceId === null || VIRTUAL_IDS.has(deviceId)
        ? realIdOf(deviceId ?? 'default', undefined, await enumerate())
        : deviceId;
    let stream = await getStream(VIRTUAL_IDS.has(wanted) ? null : wanted);
    let track = stream.getAudioTracks()[0];
    if (!track) {
      stopStream(stream);
      throw new MicError('notFound');
    }
    const settings = track.getSettings();
    const id = settings.deviceId ?? '';
    if (VIRTUAL_IDS.has(id) || id === '') {
      const real = realIdOf(
        id || 'default',
        settings.groupId,
        await enumerate(),
      );
      if (!VIRTUAL_IDS.has(real)) {
        stopStream(stream);
        stream = await getStream(real);
        track = stream.getAudioTracks()[0];
        if (!track) {
          stopStream(stream);
          throw new MicError('notFound');
        }
      }
    }
    return {
      stream,
      track,
      realId: track.getSettings().deviceId || id,
    };
  }

  async function open(
    deviceId: string | null,
    handlers: MicHandlers,
  ): Promise<OpenMic> {
    if (typeof AudioWorkletNode === 'undefined' && deps.connect === undefined)
      throw new MicError('unsupported');
    const { stream, track, realId } = await openTrack(deviceId);
    const rate = track.getSettings().sampleRate;
    let ctx: AudioContext;
    let graph: CaptureGraph;
    let closing = false;
    let interrupted = false;
    const interrupt = (reason: MicInterruption) => {
      if (closing || interrupted) return;
      interrupted = true;
      handlers.onInterrupted(reason);
    };
    try {
      // the track's rate: Firefox refuses a MediaStreamSource of another rate; harmless in Chromium
      ctx = createContext(rate ? { sampleRate: rate } : {});
    } catch (e) {
      stopStream(stream);
      throw new MicError('unsupported', e);
    }
    let wasRunning = false;
    try {
      const source = ctx.createMediaStreamSource(stream);
      graph = await connect(ctx, source, {
        onLevel: handlers.onLevel,
        onError: () => interrupt('workletError'),
      });
    } catch (e) {
      // addModule (fetch / CSP: AbortError), the source or the node: not a getUserMedia error
      stopStream(stream);
      await ctx.close().catch(() => {});
      throw new MicError('unknown', e);
    }
    // not awaited: it stays pending while the autoplay rule refuses to start (after the awaits the click's user
    // activation may no longer count); the caller resumes again on ● / 遅れを測る
    void ctx.resume().catch(() => {});

    const checkState = () => {
      const state = ctx.state as AudioContextState | 'interrupted';
      if (state === 'running') wasRunning = true;
      else if (state === 'closed') {
        graph.dispose();
        interrupt('contextClosed');
      } else if (
        state === 'interrupted' ||
        (state === 'suspended' && wasRunning) // we never suspend it ourselves
      )
        interrupt('contextInterrupted');
    };
    track.addEventListener('ended', () => interrupt('ended'));
    ctx.addEventListener('statechange', checkState);
    // something may have happened during the awaits, before the listeners were there
    if (track.readyState === 'ended') interrupt('ended');
    checkState();

    const clicks = new Set<AudioBufferSourceNode>();
    const clickBuffer = (strong: boolean) => {
      const samples = clickSamples(ctx.sampleRate, strong);
      const b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      b.copyToChannel(samples, 0);
      return b;
    };
    let buffers: { weak: AudioBuffer; strong: AudioBuffer } | null = null;

    function stopClicks(): void {
      for (const s of clicks) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          // not started / already stopped
        }
        s.disconnect();
      }
      clicks.clear();
    }

    return {
      deviceId: realId,
      label: track.label,
      sampleRate: ctx.sampleRate,
      resume: () => ctx.resume().catch(() => {}),
      now: () => ctx.currentTime,
      latencyNow: () => ({
        baseLatencySec: ctx.baseLatency ?? 0,
        outputLatencySec: ctx.outputLatency ?? 0,
      }),
      scheduleClicks(list) {
        buffers ??= { weak: clickBuffer(false), strong: clickBuffer(true) };
        for (const c of list) {
          const s = ctx.createBufferSource();
          s.buffer = c.strong ? buffers.strong : buffers.weak;
          s.connect(ctx.destination);
          s.onended = () => {
            clicks.delete(s);
            s.disconnect();
          };
          s.start(c.time);
          clicks.add(s);
        }
      },
      stopClicks,
      startCapture: (from, end) => graph.startCapture(from, end),
      async close() {
        if (closing) return;
        closing = true;
        stopClicks();
        graph.dispose();
        stopStream(stream);
        await ctx.close().catch(() => {});
      },
    };
  }

  return {
    async listDevices() {
      return foldDevices(await enumerate());
    },
    onDeviceChange(listener) {
      const m = md();
      m?.addEventListener('devicechange', listener);
      return () => m?.removeEventListener('devicechange', listener);
    },
    open,
  };
}
