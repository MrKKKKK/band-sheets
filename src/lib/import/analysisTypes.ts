import type { InputErrorCode } from '../analysis/chords/analyze';

/**
 * The analysis types the pure import code (progress view, error texts) needs. They live here so `src/lib/` does not
 * depend on `src/analysis/`; `src/analysis/types.ts` re-exports them. TYPE-ONLY imports: no analyzer code.
 */

/** 10 minutes (plan section 6.1). */
export const MAX_DURATION_SEC = 600;

/** One entry per analysis kind (section 3.5: drums is added later as one more kind). */
export type AnalysisKind = 'chords' | 'hum';

/** Sent after each stage has FINISHED. `next` is the stage now running (null after the last one). */
export interface AnalysisProgress {
  kind: AnalysisKind;
  stage: string;
  next: string | null;
  done: number;
  total: number;
}

/**
 * Why a run failed. The UI (task T4/T7) maps each code to a Japanese message (plan section 6.2); only the analyzer's
 * own input codes come with a ready Japanese `message`.
 *   decode-failed  the browser could not decode the file (not audio, broken, unsupported format)
 *   too-long       longer than MAX_DURATION_SEC (10 min); for WAV checked from the header before decoding
 *   empty | too-short | non-finite | silent | no-beats   the analyzer's AnalysisInputError codes (message included)
 *   invalid-info   hum: the bpm / time signature / start the user gave is not usable (message included)
 *   out-of-memory  an allocation failed in the Worker
 *   worker-crashed the Worker died or reported an uncaught error
 *   unsupported    no Worker / Web Audio in this browser
 *   cancelled      cancel() was called (or a new run started)
 *   internal       any other error (a bug); no details are passed on (they could hold song content)
 */
export type AnalysisErrorCode =
  | 'decode-failed'
  | 'too-long'
  | InputErrorCode
  | 'invalid-info'
  | 'out-of-memory'
  | 'worker-crashed'
  | 'unsupported'
  | 'cancelled'
  | 'internal';
