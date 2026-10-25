/** Messages between the drum bench page and its Worker (spike 5 T8). No hits ever cross back: counts and timings only. */
import type { DrumInfo } from '../drum/types';

export interface DrumRunRequest {
  type: 'run';
  id: number;
  sr: number;
  /** mono samples at `sr`, transferred (zero-copy) */
  samples: Float32Array;
  info: DrumInfo;
  /** partial DrumConfig overrides */
  config?: unknown;
}

export interface DrumRunSummary {
  hitCount: number;
  /** hits per instrument */
  perInst: Record<string, number>;
  /** quantized hits on the grid */
  gridCount: number;
  stagesMs: Record<string, number>;
  /** whole run in the Worker (analysis + conversion to the app's drum model), ms */
  totalMs: number;
  /** analyzeDrums only (the number T13 compares with the 15 s per 5 minutes target), ms */
  analysisMs: number;
  audioSec: number;
  configHash: string;
  warnings: number;
  resultJsonBytes: number;
  roundTrip: { parsed: boolean; identical: boolean; problem?: string };
}

export type DrumWorkerMessage =
  | { type: 'stage'; id: number; name: string; ms: number }
  | { type: 'done'; id: number; summary: DrumRunSummary; workerHeap?: number }
  | { type: 'error'; id: number; message: string; code?: string };
