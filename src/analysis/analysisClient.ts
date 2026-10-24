/**
 * The real AnalysisClient (plan sections 2.2, 2.3, 6): decode on the main thread -> a NEW Worker per run (so
 * memory does not pile up across runs) -> per-stage progress -> result or AnalysisError. `cancel()` terminates the
 * Worker at once; a decode in progress is discarded when it finishes. No timers.
 *
 * Load this module LAZILY (dynamic `import()` / `React.lazy` from the import screen only): the entry chunk and the
 * tablet viewer must not contain any of it (scripts/check-bundle.mjs).
 */
import { decodeFile, type DecodeOptions } from './decodeFile';
import {
  createAnalysisWorker,
  type CreateWorker,
  type WorkerLike,
} from './kinds';
import type { RunMessage, WorkerMessage } from './protocol';
import {
  ANALYSIS_STAGES,
  AnalysisError,
  type AnalysisClient,
  type AnalysisProgress,
  type AnalysisRequest,
  type AnalysisResultMap,
  type DecodedAudio,
} from './types';

export interface AnalysisClientOptions {
  createWorker?: CreateWorker;
  decode?: (file: Blob, opts: DecodeOptions) => Promise<DecodedAudio>;
}

interface ActiveRun {
  abort: AbortController;
  worker: WorkerLike | null;
  fail: (e: AnalysisError) => void;
}

function runMessage(req: AnalysisRequest, audio: DecodedAudio): RunMessage {
  const { samples, sampleRate } = audio;
  return req.kind === 'chords'
    ? { type: 'run', kind: 'chords', samples, sampleRate }
    : {
        type: 'run',
        kind: 'hum',
        samples,
        sampleRate,
        info: req.info,
        f0Track: req.f0Track ?? false,
        firstNoteAuto: req.firstNoteAuto ?? false,
      };
}

export function createAnalysisClient(
  opts: AnalysisClientOptions = {},
): AnalysisClient {
  const createWorker = opts.createWorker ?? createAnalysisWorker;
  const decode = opts.decode ?? decodeFile;
  let active: ActiveRun | null = null;

  function cancel(): void {
    active?.fail(new AnalysisError('cancelled'));
  }

  function run<R extends AnalysisRequest>(
    req: R,
    onProgress?: (p: AnalysisProgress) => void,
  ): Promise<AnalysisResultMap[R['kind']]> {
    cancel(); // one run at a time
    const stages: readonly string[] = ANALYSIS_STAGES[req.kind];
    let done = 0;
    const progress = (stage: string) => {
      done = Math.min(done + 1, stages.length);
      onProgress?.({
        kind: req.kind,
        stage,
        next: stages[done] ?? null,
        done,
        total: stages.length,
      });
    };

    return new Promise<AnalysisResultMap[R['kind']]>((resolve, reject) => {
      let settled = false;
      const me: ActiveRun = {
        abort: new AbortController(),
        worker: null,
        fail: (e) => finish(() => reject(e)),
      };
      active = me;
      function finish(settle: () => void): void {
        if (settled) return;
        settled = true;
        me.abort.abort();
        if (me.worker) {
          me.worker.onmessage = null;
          me.worker.onerror = null;
          me.worker.onmessageerror = null;
          me.worker.terminate();
          me.worker = null;
        }
        if (active === me) active = null;
        settle();
      }

      const start = async () => {
        const audio =
          'audio' in req.source
            ? req.source.audio
            : await decode(req.source.file, { signal: me.abort.signal });
        if (settled) return; // cancelled while decoding: drop the audio
        progress('decode');
        let worker: WorkerLike;
        try {
          worker = createWorker(req.kind);
        } catch {
          throw new AnalysisError('unsupported');
        }
        me.worker = worker;
        worker.onmessage = (e) => {
          const m = e.data as WorkerMessage;
          if (m.type === 'stage') progress(m.stage);
          else if (m.type === 'result')
            finish(() => resolve(m.result as AnalysisResultMap[R['kind']]));
          else if (m.type === 'error')
            me.fail(new AnalysisError(m.code, m.userMessage));
        };
        worker.onerror = (e) => {
          e.preventDefault?.();
          const oom = /memory|allocation/i.test(e.message ?? '');
          me.fail(new AnalysisError(oom ? 'out-of-memory' : 'worker-crashed'));
        };
        worker.onmessageerror = () => me.fail(new AnalysisError('internal'));
        const msg = runMessage(req, audio);
        // transfer: the samples are detached here (no copy); the main thread keeps no reference
        worker.postMessage(msg, [msg.samples.buffer]);
      };
      start().catch((e: unknown) =>
        me.fail(e instanceof AnalysisError ? e : new AnalysisError('internal')),
      );
    });
  }

  return { run, cancel };
}
