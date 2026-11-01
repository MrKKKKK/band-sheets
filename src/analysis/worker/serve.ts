/**
 * The message loop shared by the analysis Workers: one `run` message -> stage messages -> one `result` or `error`.
 * Errors are reduced to a code (plus the analyzer's own Japanese message for unusable input): other error texts
 * could hold song content and are never posted (plan section 5).
 */
import type { InputErrorCode } from '../../lib/analysis/chords/analyze';
import type { RunMessage, WorkerMessage } from '../protocol';
import type { AnalysisErrorCode } from '../types';

export type PostStage = (stage: string, ms: number) => void;

export type Runner<M extends RunMessage> = (
  msg: M,
  onStage: PostStage,
) => unknown;

/** Error codes thrown by runners on purpose (see runChords / runHum). */
export class RunnerError extends Error {
  readonly code: AnalysisErrorCode;
  readonly userMessage?: string;
  constructor(code: AnalysisErrorCode, userMessage?: string) {
    super(code);
    this.name = 'RunnerError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Every analyzer input code (a code missing here is a compile error). */
const INPUT_CODE_TABLE: Record<InputErrorCode, true> = {
  empty: true,
  'too-short': true,
  'non-finite': true,
  silent: true,
  'no-beats': true,
};
const INPUT_CODES = new Set<string>(Object.keys(INPUT_CODE_TABLE));

/** Maps anything a runner threw to the error message posted to the main thread. */
export function errorMessage(err: unknown): WorkerMessage {
  if (err instanceof RunnerError)
    return { type: 'error', code: err.code, userMessage: err.userMessage };
  // AnalysisInputError (by name: instanceof would need the analyzer module here)
  if (
    err instanceof Error &&
    err.name === 'AnalysisInputError' &&
    INPUT_CODES.has((err as { code?: string }).code ?? '')
  ) {
    return {
      type: 'error',
      code: (err as unknown as { code: AnalysisErrorCode }).code,
      userMessage: err.message,
    };
  }
  // "Array buffer allocation failed", "Invalid typed array length", "Invalid array length"
  if (err instanceof RangeError && /alloc|length|memory/i.test(err.message))
    return { type: 'error', code: 'out-of-memory' };
  return { type: 'error', code: 'internal' };
}

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: WorkerMessage): void;
}

/** Handles exactly one run per Worker (the client terminates the Worker afterwards). */
export function serve<M extends RunMessage>(
  scope: WorkerScope,
  kind: M['kind'],
  runner: Runner<M>,
): void {
  scope.onmessage = (e) => {
    scope.onmessage = null; // one run per Worker
    const msg = e.data as M;
    if (msg?.type !== 'run' || msg.kind !== kind) {
      scope.postMessage({ type: 'error', code: 'internal' });
      return;
    }
    try {
      const result = runner(msg, (stage, ms) =>
        scope.postMessage({ type: 'stage', stage, ms }),
      );
      scope.postMessage({ type: 'result', result });
    } catch (err) {
      scope.postMessage(errorMessage(err));
    }
  };
}
