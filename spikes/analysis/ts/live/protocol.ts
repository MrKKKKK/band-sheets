/** Messages between the page and ts/browser/liveWorker.ts (type-only; no code). */
import type { WindowResult } from './core';
import type { VariantId } from './variants';

export type ToWorker =
  /** once per start: the capture port (worklet blocks {frame, data: Float32Array[]}) and the device rate */
  | { type: 'start'; port: MessagePort; deviceRate: number }
  | { type: 'config'; variantId: VariantId; windowSec: number; key: string | undefined }
  /** 測り直す: tuning and gain are measured again on the next 3 s after the gate */
  | { type: 'recalibrate' }
  | { type: 'stop' };

export type CalibrationState = { state: 'waiting' } | { state: 'collecting'; sec: number } | { state: 'fixed'; tuning: number; gainDb: number; ms: number };

export type FromWorker =
  | { type: 'calibration'; calibration: CalibrationState }
  | {
      type: 'result';
      variantId: VariantId;
      windowSec: number;
      result: WindowResult;
      /** seconds from the end of the window to the newest sample when the result was ready */
      lagSec: number;
      /** results per second over the last ~3 s */
      perSec: number;
      /** wall time of this analyzeWindow call (ms) */
      ms: number;
      /** frames the worklet never delivered (device rate), since start */
      gapFrames: number;
    }
  | { type: 'error'; message: string };
