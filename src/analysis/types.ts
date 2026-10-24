/**
 * Public types of the browser side of audio analysis (docs/audio-integration-plan.md sections 2.2, 3.5, 6).
 *
 * TYPE-ONLY imports from `src/lib/analysis/` here: this module (and everything the main thread imports from
 * `src/analysis/`) must never pull analyzer code into a main-thread chunk; the analyzers run only inside the
 * Workers (`*.worker.ts`). `scripts/check-bundle.mjs` checks the built entry chunk for analyzer markers.
 */
import type { InputErrorCode } from '../lib/analysis/chords/analyze';
import type { TsAnalysisResult } from '../lib/analysis/chords/result';
import type { HumAnalysisResult, HumInput } from '../lib/analysis/hum/types';

/** One entry per analysis kind (section 3.5: drums is added later as one more kind). */
export type AnalysisKind = 'chords' | 'hum';

/** Mono samples at the file's own rate (decodeFile's output). */
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  /** Channels in the file before the mixdown. */
  channels: number;
  durationSec: number;
}

/**
 * Where the audio comes from: a file the user picked (decoded on the main thread first) or audio that is already
 * decoded. In both cases the samples' buffer is TRANSFERRED to the Worker: after `run`, `audio.samples` is detached.
 */
export type AnalysisSource = { file: Blob } | { audio: DecodedAudio };

export interface ChordsRequest {
  kind: 'chords';
  source: AnalysisSource;
}

export interface HumRequest {
  kind: 'hum';
  source: AnalysisSource;
  /** What the user knows (bpm, time signature, start). Checked in the Worker (`invalid-info`). */
  info: HumInput;
  /** Include the frame f0 track (`hum.f0`) in the result, e.g. for drawing it next to the notes. */
  f0Track?: boolean;
  /**
   * The user knows only where the first sung note is in the bars (`info.firstNoteTick`, S2), not its second: the
   * Worker takes the start of the first detected note as `firstNoteSec` (pass `firstNoteSec: 0` as a placeholder).
   */
  firstNoteAuto?: boolean;
}

export type AnalysisRequest = ChordsRequest | HumRequest;

export interface AnalysisResultMap {
  chords: TsAnalysisResult;
  hum: HumAnalysisResult;
}

/**
 * Stage names per kind, in order, including the main-thread `decode`. Literal copies of the analyzers' `STAGES` /
 * `HUM_STAGES` (importing those would pull analyzer code into the main thread); `types.test.ts` checks they match.
 */
export const ANALYSIS_STAGES = {
  chords: [
    'decode',
    'resample',
    'load',
    'beats',
    'chroma',
    'chords',
    'downbeat',
    'merge',
    'sections',
    'key',
    'keytrack',
    'chords2',
    'merge2',
  ],
  hum: ['decode', 'validate', 'resample', 'f0', 'level', 'notes', 'quantize'],
} as const satisfies Record<AnalysisKind, readonly string[]>;

export type AnalysisStage<K extends AnalysisKind = AnalysisKind> =
  (typeof ANALYSIS_STAGES)[K][number];

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

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  /** Japanese text for the user, only for the analyzer's input codes and `invalid-info`. */
  readonly userMessage?: string;
  constructor(code: AnalysisErrorCode, userMessage?: string) {
    super(userMessage ?? code);
    this.name = 'AnalysisError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function isAnalysisError(e: unknown): e is AnalysisError {
  return e instanceof AnalysisError;
}

/** 10 minutes (plan section 6.1). */
export const MAX_DURATION_SEC = 600;

export interface AnalysisClient {
  /**
   * Decode (when given a file) and analyse in a NEW Worker, which is terminated when the run ends. Starting a run
   * while another is active cancels the earlier one (its promise rejects with `cancelled`).
   * Rejects with an AnalysisError.
   */
  run<R extends AnalysisRequest>(
    request: R,
    onProgress?: (p: AnalysisProgress) => void,
  ): Promise<AnalysisResultMap[R['kind']]>;
  /** Stops the active run at once (`worker.terminate()`; a decode in progress is discarded). No-op when idle. */
  cancel(): void;
}
