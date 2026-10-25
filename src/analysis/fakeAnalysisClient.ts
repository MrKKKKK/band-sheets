/**
 * An AnalysisClient for Storybook and unit tests (plan section 7): no decode, no Worker. Replays the kind's stages
 * as progress, then resolves with the given result or rejects with the given error code. Can stop at a stage and
 * stay pending (progress screens) until `cancel()`.
 */
import {
  ANALYSIS_STAGES,
  AnalysisError,
  type AnalysisClient,
  type AnalysisErrorCode,
  type AnalysisKind,
  type AnalysisProgress,
  type AnalysisRequest,
  type AnalysisResultMap,
} from './types';

export interface FakeAnalysisOptions {
  /** Result per kind. A kind without a result rejects with `internal` (unless `error` is set). */
  results?: Partial<AnalysisResultMap>;
  /** Fail with this code after `failAfterStages` stages (default: all stages). */
  error?: AnalysisErrorCode;
  /** Japanese message that comes with `error` (as the analyzer's input errors do). */
  userMessage?: string;
  failAfterStages?: number;
  /** Stay pending after this many stages (until cancel()). */
  holdAfterStages?: number;
  /** Delay per stage in ms (default 0: stages follow each other in microtasks). */
  stageMs?: number;
}

export interface FakeAnalysisClient extends AnalysisClient {
  /** Requests received so far (for assertions). */
  readonly requests: AnalysisRequest[];
  readonly cancelCount: number;
}

/** Detaches `{audio}` samples as `postMessage(msg, [buffer])` does; false when they are already detached. */
function detachSamples(req: AnalysisRequest): boolean {
  if (!('audio' in req.source)) return true;
  const { buffer } = req.source.audio.samples;
  try {
    structuredClone(buffer, { transfer: [buffer as ArrayBuffer] });
    return true;
  } catch {
    return false;
  }
}

export function createFakeAnalysisClient(
  opts: FakeAnalysisOptions = {},
): FakeAnalysisClient {
  const requests: AnalysisRequest[] = [];
  let cancelCount = 0;
  let stopActive: (() => void) | null = null;

  function cancel(): void {
    if (!stopActive) return;
    cancelCount++;
    stopActive();
  }

  function run<R extends AnalysisRequest>(
    req: R,
    onProgress?: (p: AnalysisProgress) => void,
  ): Promise<AnalysisResultMap[R['kind']]> {
    cancel();
    requests.push(req);
    // like the real client, the decoded samples are transferred away (detached) inside run()
    const transferred = detachSamples(req);
    const kind: AnalysisKind = req.kind;
    const stages: readonly string[] = ANALYSIS_STAGES[kind];
    const failAt = opts.error ? (opts.failAfterStages ?? stages.length) : -1;
    const holdAt = opts.holdAfterStages ?? -1;
    return new Promise((resolve, reject) => {
      if (!transferred) return reject(new AnalysisError('internal'));
      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      const me = () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (stopActive === me) stopActive = null;
        reject(new AnalysisError('cancelled'));
      };
      stopActive = me;
      const end = (settle: () => void) => {
        if (stopActive === me) stopActive = null;
        settle();
      };
      const step = (done: number) => {
        if (stopped) return;
        if (done === failAt)
          return end(() =>
            reject(new AnalysisError(opts.error!, opts.userMessage)),
          );
        if (done === holdAt) return; // pending until cancel()
        if (done === stages.length) {
          const result = opts.results?.[kind];
          return end(() =>
            result === undefined
              ? reject(new AnalysisError('internal'))
              : resolve(result as AnalysisResultMap[R['kind']]),
          );
        }
        const next = () => {
          timer = null;
          if (stopped) return;
          onProgress?.({
            kind,
            stage: stages[done],
            next: stages[done + 1] ?? null,
            done: done + 1,
            total: stages.length,
          });
          step(done + 1);
        };
        if (opts.stageMs) timer = setTimeout(next, opts.stageMs);
        else queueMicrotask(next);
      };
      step(0);
    });
  }

  return {
    run,
    cancel,
    requests,
    get cancelCount() {
      return cancelCount;
    },
  };
}
