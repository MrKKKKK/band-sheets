/**
 * e2e only (e2e/harness/mic.html; never imported by the app): drives the REAL MicSession in Chromium with
 * `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. `#open` opens the default mic inside a real
 * click (user activation for the AudioContext); `record` captures a few seconds with clicks scheduled up front.
 */
import {
  CAPTURE_WORKLET_URL,
  createMicSession,
  type CaptureEnd,
  type MicDevice,
  type OpenMic,
} from '../micSession';

export interface MicHarnessOpened {
  /** OpenMic.deviceId = the opened track's `getSettings().deviceId` (must be a real id, never `default`) */
  deviceId: string;
  label: string;
  sampleRate: number;
  devices: MicDevice[];
  /** the module given to audioWorklet.addModule, resolved against the page */
  workletUrl: string;
}

export interface MicHarnessTake {
  end: CaptureEnd;
  firstFrame: number;
  endFrame: number;
  levels: number;
  peak: number;
}

export interface MicHarness {
  /** Resolves after `#open` was clicked. */
  opened: Promise<MicHarnessOpened | { error: string }>;
  /** Closes the open mic and opens `deviceId` (after the `#open` click: the page keeps its user activation). */
  reopen(deviceId: string): Promise<MicHarnessOpened | { error: string }>;
  record(sec: number): Promise<MicHarnessTake>;
  close(): Promise<void>;
}

const session = createMicSession();
let mic: OpenMic | null = null;
let levels = 0;
let resolveOpened!: (v: MicHarnessOpened | { error: string }) => void;
const opened = new Promise<MicHarnessOpened | { error: string }>(
  (r) => (resolveOpened = r),
);

async function openMic(
  deviceId: string | null,
): Promise<MicHarnessOpened | { error: string }> {
  try {
    await mic?.close();
    mic = await session.open(deviceId, {
      onLevel: () => levels++,
      onInterrupted: (r) => console.warn('interrupted', r),
    });
    return {
      deviceId: mic.deviceId,
      label: mic.label,
      sampleRate: mic.sampleRate,
      workletUrl: new URL(CAPTURE_WORKLET_URL, location.href).href,
      devices: await session.listDevices(),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

document.querySelector('#open')!.addEventListener('click', () => {
  void openMic(null).then(resolveOpened);
});

const harness: MicHarness = {
  opened,
  reopen: openMic,
  async record(sec) {
    if (!mic) throw new Error('not open');
    await mic.resume();
    const r = mic.sampleRate;
    const t0 = mic.now() + 0.2;
    const clicks = Array.from({ length: Math.floor(sec / 0.5) }, (_, i) => ({
      time: t0 + i * 0.5,
      strong: i % 4 === 0,
    }));
    mic.scheduleClicks(clicks);
    const cap = mic.startCapture(
      Math.round(t0 * r),
      Math.round((t0 + 600) * r),
    );
    levels = 0;
    await new Promise((res) => setTimeout(res, sec * 1000));
    mic.stopClicks();
    cap.stop(Math.round(mic.now() * r));
    const end = await Promise.race([
      cap.done,
      new Promise<CaptureEnd>((_, rej) =>
        setTimeout(() => rej(new Error('capture did not end')), 3000),
      ),
    ]);
    const all = cap.buffer.sliceFloat(
      cap.buffer.firstFrame,
      cap.buffer.endFrame,
    );
    let peak = 0;
    for (const v of all) peak = Math.max(peak, Math.abs(v));
    return {
      end,
      firstFrame: cap.buffer.firstFrame,
      endFrame: cap.buffer.endFrame,
      levels,
      peak,
    };
  },
  async close() {
    await mic?.close();
    mic = null;
  },
};

(window as unknown as { __mic: MicHarness }).__mic = harness;
