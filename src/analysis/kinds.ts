/**
 * The one table of analysis kinds (plan section 3.5). Adding drums later = a `drums.worker.ts` + a runner + one row
 * here (and its types in types.ts / protocol.ts).
 *
 * Each kind is its own Worker chunk, so a run loads only its analyzer. Vite needs the literal
 * `new Worker(new URL('./x.worker.ts', import.meta.url), …)` form to bundle the Worker, hence one function per kind.
 */
import type { AnalysisKind } from './types';

export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export type CreateWorker = (kind: AnalysisKind) => WorkerLike;

// Worker names `band-sheets-analysis-<kind>` (visible in devtools; plain literals: Vite needs static options).
// scripts/check-bundle.mjs looks for that prefix to find this module leaking into the entry chunk.
export const createAnalysisWorker: CreateWorker = (kind) => {
  switch (kind) {
    case 'chords':
      return new Worker(new URL('./chords.worker.ts', import.meta.url), {
        type: 'module',
        name: 'band-sheets-analysis-chords',
      });
    case 'hum':
      return new Worker(new URL('./hum.worker.ts', import.meta.url), {
        type: 'module',
        name: 'band-sheets-analysis-hum',
      });
  }
};
