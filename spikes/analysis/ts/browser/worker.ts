/**
 * The analysis Worker (plan section 2 "画面": analysis off the main thread). Receives the decoded mono
 * signal at its own rate (transferred, no copy), validates it (AnalysisInputError -> an error message with
 * its code), resamples to 22050 Hz, drops the file-rate signal, runs the full analyzer (dsp/analyze.ts) and posts per-stage stats.
 * Defence in depth for the privacy rule: network APIs are removed from the Worker's global scope
 * before any message is handled (the analysis code never uses them anyway).
 */
import type { RunRequest, WorkerMessage } from './protocol';
import { AnalysisInputError, analyze, validateInput } from '../dsp/analyze';
import { MemTracker } from '../dsp/core/mem';
import { resampleSinc, toMono } from '../dsp/core/resample';

interface WorkerScope {
  postMessage(m: WorkerMessage): void;
  onmessage: ((e: { data: RunRequest }) => void) | null;
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
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m?.usedJSHeapSize;
}

scope.onmessage = (e) => {
  const req = e.data;
  if (req.type !== 'run') return;
  try {
    const mem = new MemTracker();
    const t0 = performance.now();
    for (const c of req.channels) mem.adopt(c);
    let mono: Float32Array | null = toMono(req.channels);
    if (mono !== req.channels[0]) mem.adopt(mono);
    validateInput(mono, req.sr); // before the long resample; positions in the file's own time
    const box: { y: Float32Array | null } = { y: resampleSinc(mono, req.sr, 22050, {}, mem) };
    if (box.y !== mono) {
      // the file-rate signal is not needed any more: drop every reference (the message keeps one too)
      mem.release(...req.channels, ...(mono !== req.channels[0] ? [mono] : []));
      req.channels.length = 0;
      mono = null;
    }
    const resampleMs = performance.now() - t0;
    const resampleStat = { name: 'resample', ms: resampleMs, memLive: mem.live, memPeak: mem.peak };
    scope.postMessage({ type: 'stage', id: req.id, stage: resampleStat });
    const out = analyze(box, {
      mem,
      preTimings: { resample: resampleMs / 1000 },
      onStage: (stage) => scope.postMessage({ type: 'stage', id: req.id, stage }),
    });
    const r = out.result;
    const summary = {
      stages: [resampleStat, ...out.stats],
      resampleMs,
      totalMs: performance.now() - t0,
      memPeak: out.mem.peak,
      beats: r.beats.length,
      chords: r.chords.length,
      sections: r.sections.length,
      resultJsonBytes: JSON.stringify(r).length,
      warnings: r.analyzer.warnings ?? [],
    };
    scope.postMessage({ type: 'done', id: req.id, summary, workerHeap: heap() });
  } catch (err) {
    req.channels.length = 0;
    const code = err instanceof AnalysisInputError ? err.code : undefined;
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), code });
  }
};
