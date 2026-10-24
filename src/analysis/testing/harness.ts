/**
 * e2e only (e2e/harness/analysis.html, served by the dev server; never imported by the app): drives the REAL
 * AnalysisClient (decode on this page, analysis in a new Worker) on the file chosen in `#file`.
 */
import { createAnalysisClient } from '../analysisClient';
import { createAnalysisWorker, type WorkerLike } from '../kinds';
import {
  isAnalysisError,
  type AnalysisKind,
  type AnalysisProgress,
} from '../types';
import type { HumInput } from '../../lib/analysis/hum/types';

export interface HarnessRunOptions {
  info?: HumInput;
  f0Track?: boolean;
  /** Return only sizes instead of the whole result (long inputs). */
  summaryOnly?: boolean;
}

export type HarnessOutcome =
  | { ok: true; ms: number; result?: unknown; resultJsonBytes: number }
  | { ok: false; ms: number; code: string; userMessage?: string };

export interface Harness {
  progress: AnalysisProgress[];
  run(kind: AnalysisKind, opts?: HarnessRunOptions): Promise<HarnessOutcome>;
  cancel(): void;
  /** Starts a Worker of `kind` without a run (to inspect its global scope from the test), and stops it. */
  spawnIdle(kind: AnalysisKind): void;
  stopIdle(): void;
}

let idle: WorkerLike | null = null;

const client = createAnalysisClient();
const input = document.querySelector<HTMLInputElement>('#file')!;

const harness: Harness = {
  progress: [],
  async run(kind, opts = {}) {
    const file = input.files?.[0];
    if (!file) throw new Error('no file chosen');
    harness.progress = [];
    const onProgress = (p: AnalysisProgress) => harness.progress.push(p);
    const t0 = performance.now();
    try {
      const result =
        kind === 'chords'
          ? await client.run({ kind, source: { file } }, onProgress)
          : await client.run(
              {
                kind,
                source: { file },
                info: opts.info!,
                f0Track: opts.f0Track,
              },
              onProgress,
            );
      const ms = performance.now() - t0;
      const json = JSON.stringify(result);
      return {
        ok: true,
        ms,
        resultJsonBytes: json.length,
        ...(opts.summaryOnly ? {} : { result: JSON.parse(json) as unknown }),
      };
    } catch (e) {
      const ms = performance.now() - t0;
      if (isAnalysisError(e))
        return { ok: false, ms, code: e.code, userMessage: e.userMessage };
      return { ok: false, ms, code: `not an AnalysisError: ${String(e)}` };
    }
  },
  cancel: () => client.cancel(),
  spawnIdle(kind) {
    idle?.terminate();
    idle = createAnalysisWorker(kind);
  },
  stopIdle() {
    idle?.terminate();
    idle = null;
  },
};

(window as unknown as { __analysis: Harness }).__analysis = harness;
