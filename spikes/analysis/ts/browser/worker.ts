/**
 * The analysis Worker (plan section 2 "画面": analysis off the main thread). Receives the decoded mono
 * signal at its own rate (transferred, no copy), runs the vertical slice and posts per-stage stats.
 * Defence in depth for the privacy rule: network APIs are removed from the Worker's global scope
 * before any message is handled (the analysis code never uses them anyway).
 */
import type { RunRequest, WorkerMessage } from './protocol';
import { runSlice } from './slice';

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
    const result = runSlice(
      { channels: req.channels, sr: req.sr },
      { onStage: (stage) => scope.postMessage({ type: 'stage', id: req.id, stage }) },
    );
    scope.postMessage({ type: 'done', id: req.id, result, workerHeap: heap() });
  } catch (err) {
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
