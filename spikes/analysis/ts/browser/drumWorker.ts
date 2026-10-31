/**
 * The drum analysis Worker (spike 5 T8). Receives the mono signal at its own rate (transferred), runs drum/analyze.ts
 * (validate -> onset -> classify -> quantize) and the conversion to the app's drum model, and posts per-stage timings and
 * COUNTS only: the hits themselves never leave the Worker. As in worker.ts / humWorker.ts the network APIs are removed
 * from the Worker's global scope before any message is handled. Imports templates.ts only (templates_build.ts needs alphaTab).
 */
import { DrumInputError, analyzeDrums, drumScore } from '../drum/analyze';
import { resolveDrumConfig } from '../drum/config';
import type { DrumRunRequest, DrumWorkerMessage } from './drumProtocol';

interface WorkerScope {
  postMessage(m: DrumWorkerMessage): void;
  onmessage: ((e: { data: DrumRunRequest }) => void) | null;
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
    const cfg = resolveDrumConfig(req.config ?? {});
    const r = analyzeDrums({ ...req.info, samples: req.samples, sampleRate: req.sr, level: req.level }, cfg, {
      onStage: (name, ms) => scope.postMessage({ type: 'stage', id: req.id, name, ms }),
    });
    const analysisMs = performance.now() - t0;
    const text = drumScore(r);
    const perInst: Record<string, number> = {};
    for (const h of r.drums) perInst[h.inst] = (perInst[h.inst] ?? 0) + 1;
    const m = r.drum.meta;
    scope.postMessage({
      type: 'done',
      id: req.id,
      summary: {
        hitCount: r.drums.length,
        perInst,
        gridCount: r.drum.quantized?.hits.length ?? 0,
        stagesMs: m.timings.stagesMs,
        totalMs: performance.now() - t0,
        analysisMs,
        audioSec: m.timings.audioSec,
        configHash: m.configHash,
        warnings: m.warnings.length,
        resultJsonBytes: JSON.stringify(r).length,
        roundTrip: text.roundTrip,
      },
      workerHeap: heap(),
    });
  } catch (err) {
    const code = err instanceof DrumInputError ? err.code : undefined;
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), code });
  }
};
