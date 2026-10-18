/** Messages between the humming bench page and its Worker (no notes ever cross back: counts and timings only). */
import type { HumInfo } from '../hum/types';

export interface HumRunRequest {
  type: 'run';
  id: number;
  sr: number;
  /** transferred (zero-copy) */
  channels: Float32Array[];
  info: HumInfo;
  /** partial HumConfig overrides */
  config?: unknown;
}

export interface HumRunSummary {
  noteCount: number;
  stagesMs: Record<string, number>;
  /** whole run in the Worker, including mono mixdown (ms) */
  totalMs: number;
  audioSec: number;
  configHash: string;
  warnings: number;
  resultJsonBytes: number;
}

export type HumWorkerMessage =
  | { type: 'stage'; id: number; name: string; ms: number }
  | { type: 'done'; id: number; summary: HumRunSummary; workerHeap?: number }
  | { type: 'error'; id: number; message: string; code?: string };
