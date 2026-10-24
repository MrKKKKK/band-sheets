/** Messages between the main thread (analysisClient.ts) and an analysis Worker. One Worker = one run. */
import type { HumInput } from '../lib/analysis/hum/types';
import type { AnalysisErrorCode } from './types';

/** main -> Worker. `samples` is transferred (zero copy). */
export type RunMessage =
  | { type: 'run'; kind: 'chords'; samples: Float32Array; sampleRate: number }
  | {
      type: 'run';
      kind: 'hum';
      samples: Float32Array;
      sampleRate: number;
      info: HumInput;
      f0Track: boolean;
      firstNoteAuto: boolean;
    };

/** Worker -> main. A run ends with exactly one `result` or `error`. */
export type WorkerMessage =
  | { type: 'stage'; stage: string; ms: number }
  | { type: 'result'; result: unknown }
  | { type: 'error'; code: AnalysisErrorCode; userMessage?: string };
