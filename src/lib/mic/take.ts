/**
 * Making a finished take (docs/mic-recording-plan.md §2.7), pure: which frames of the capture are the file (the
 * compensation shifts both ends) and the file itself. useMicRecorder only waits for the capture and publishes it.
 */
import { barSec } from './clickTrack';
import {
  compensationFrames,
  compensationSec,
  type ReportedLatency,
} from './latency';
import { peakBuckets } from './peaks';
import { isTakeTooShort, type Meter, type TakeInfo } from './recorderState';
import type { TakeSlice } from './takeBuffer';
import { encodeWav16 } from './wav';

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

export interface TakeFramesInput {
  sampleRate: number;
  /** the count-in's first click on the frame axis, and the 10-minute end */
  t0Frame: number;
  limitFrame: number;
  /** ■'s context time (s); null = the limit ended it */
  stopSec: number | null;
  reported: ReportedLatency;
  remainderMs: number | null;
}

export interface TakeFrames {
  compensationFrames: number;
  startFrame: number;
  endFrame: number;
}

/** The file starts at the count-in's first click + the compensation and ends at ■ + the compensation. */
export function takeFrames(i: TakeFramesInput): TakeFrames {
  const comp = compensationFrames(
    compensationSec({ ...i.reported, remainderMs: i.remainderMs }),
    i.sampleRate,
  );
  return {
    compensationFrames: comp,
    startFrame: i.t0Frame + comp,
    endFrame:
      i.stopSec === null
        ? i.limitFrame
        : Math.round(i.stopSec * i.sampleRate) + comp,
  };
}

/** The take's file; null when nothing is left after bar 1 (too short). */
export function makeTake(
  slice: TakeSlice,
  sampleRate: number,
  meter: Meter,
): MicTake | null {
  const durationSec = slice.frames / sampleRate;
  const bar1Sec = barSec(meter.tempo, meter.ts);
  if (isTakeTooShort(durationSec, bar1Sec)) return null;
  return {
    durationSec,
    bar1Sec,
    meter,
    file: new File([encodeWav16(slice.chunks, sampleRate)], TAKE_FILE_NAME, {
      type: 'audio/wav',
    }),
    peaks: peakBuckets(slice.chunks, Math.round(sampleRate * PEAK_BUCKET_SEC)),
  };
}
