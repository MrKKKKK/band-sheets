/** Hand-made recorder views and a take for the MicRecorder / LatencyDialog stories (not used by the app). */
import { fn } from 'storybook/test';
import type { MicTake } from '../../hooks/useMicRecorder';
import { encodeWav16 } from '../../lib/mic/wav';
import type { MicDevice } from '../../lib/mic/micTypes';
import type { RecorderPhase, RecorderState } from '../../lib/mic/recorderState';
import type { MicRecorderView } from './MicRecorder';

export const DEVICES: MicDevice[] = [
  { deviceId: 'usb', label: 'マイク (USB Audio Device)', isDefault: true },
  { deviceId: 'built-in', label: '内蔵マイク', isDefault: false },
];

export const METER = { tempo: 96, ts: { num: 4, den: 4 } };

export function stateOf(
  phase: RecorderPhase,
  over: Partial<
    Pick<RecorderState, 'deviceId' | 'remainderMs' | 'devices'>
  > = {},
): RecorderState {
  return {
    devices: DEVICES,
    deviceId: 'usb',
    remainderMs: null,
    ...over,
    ...phase,
  };
}

/** A 24 s take at ♩=96 in 4/4 (bar = 2.5 s): a quiet count-in, then a swelling hum. */
export function makeTake(durationSec = 24): MicTake {
  const rate = 8000;
  const bar1Sec = 2.5;
  const n = Math.round(durationSec * rate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const amp = t < bar1Sec ? 0.03 : 0.25 + 0.2 * Math.sin(t * 1.7);
    pcm[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 220 * t));
  }
  const peaks = new Float32Array(Math.round(durationSec * 100));
  for (let i = 0; i < peaks.length; i++) {
    const t = i / 100;
    peaks[i] =
      t < bar1Sec
        ? i % 50 === 0
          ? 0.5
          : 0.03
        : Math.abs(0.25 + 0.2 * Math.sin(t * 1.7)) *
          (0.6 + 0.4 * Math.abs(Math.sin(t * 3.1)));
  }
  return {
    file: new File([encodeWav16([pcm], rate)], '録音.wav', {
      type: 'audio/wav',
    }),
    peaks,
    durationSec,
    bar1Sec,
    meter: METER,
  };
}

/** A recorder view that shows `state` (and `take`), with every action a spy. */
export function viewOf(
  state: RecorderState,
  opts: { take?: MicTake | null; level?: number } = {},
): MicRecorderView {
  return {
    state,
    take: opts.take ?? null,
    subscribeLevel: () => () => {},
    getLevel: () => opts.level ?? 0,
    open: fn(),
    chooseMic: fn(),
    measure: fn(),
    closeMeasure: fn(),
    record: fn(),
    cancelCountIn: fn(),
    stop: fn(),
    retake: fn(),
    cancelRetake: fn(),
    confirmRetake: fn(),
  };
}
