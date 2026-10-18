/**
 * The humming analysis Worker (spike 4 T7). Receives the decoded signal at its own rate (transferred), runs
 * hum/analyze.ts (validate -> resample -> f0 -> notes -> quantize) and posts per-stage timings and the NOTE COUNT
 * only: the notes themselves never leave the Worker. As in worker.ts the network APIs are removed from the
 * Worker's global scope before any message is handled.
 */
import type { HumRunRequest, HumWorkerMessage } from './humProtocol';
import { toMono } from '../dsp/core/resample';
import { AnalysisInputError, analyzeHum } from '../hum/analyze';

interface WorkerScope {
  postMessage(m: HumWorkerMessage): void;
  onmessage: ((e: { data: HumRunRequest }) => void) | null;
  [k: string]: unknown;
}
const scope = self as unknown as WorkerScope;

for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
  try {
    Object.defineProperty(scope, k, {
      value: () => {
        throw new Error(`network access is forbidden in the analysis worker: ${k}`);
      },
      configurable: false,
      writable: false,
    });
  } catch {
    /* not defined in this scope */
  }
}

function heap(): number | undefined {
  return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type !== 'run') return;
  try {
    const t0 = performance.now();
    // S5: the input (44.1 kHz Float32, ~53 MB for 5 min) is only needed until the resample stage is done; the Worker
    // holds no other reference to it, so it can be collected while f0 / notes run.
    const r = analyzeHum(toMono(req.channels), req.sr, req.info, {
      config: req.config,
      onStage: (name, ms) => {
        if (name === 'resample') req.channels.length = 0;
        scope.postMessage({ type: 'stage', id: req.id, name, ms });
      },
    });
    req.channels.length = 0;
    const m = r.hum.meta;
    scope.postMessage({
      type: 'done',
      id: req.id,
      summary: {
        noteCount: r.melody.notes.length,
        stagesMs: m.timings.stagesMs,
        totalMs: performance.now() - t0,
        audioSec: m.timings.audioSec,
        configHash: m.configHash,
        warnings: m.warnings.length,
        resultJsonBytes: JSON.stringify(r).length,
      },
      workerHeap: heap(),
    });
  } catch (err) {
    req.channels.length = 0;
    const code = err instanceof AnalysisInputError ? err.code : undefined;
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), code });
  }
};
