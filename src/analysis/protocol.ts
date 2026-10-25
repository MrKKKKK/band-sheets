/** Messages between the main thread (analysisClient.ts) and an analysis Worker. One Worker = one run. */
import type { AnalysisErrorCode, AnalysisRequest } from './types';

/** A request as the Worker gets it: the audio is `samples` / `sampleRate`, so no `source`. */
type WorkerRequest<R> = R extends AnalysisRequest ? Omit<R, 'source'> : never;

/**
 * main -> Worker: the request of each kind (optional fields as the caller gave them; the runners apply the
 * defaults) with the decoded audio. `samples` is transferred (zero copy).
 */
export type RunMessage = WorkerRequest<AnalysisRequest> & {
  type: 'run';
  samples: Float32Array;
  sampleRate: number;
};

/** Worker -> main. A run ends with exactly one `result` or `error`. */
export type WorkerMessage =
  | { type: 'stage'; stage: string; ms: number }
  | { type: 'result'; result: unknown }
  | { type: 'error'; code: AnalysisErrorCode; userMessage?: string };
