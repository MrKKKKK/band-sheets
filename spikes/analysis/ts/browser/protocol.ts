/** Messages between the bench page (main thread) and the analysis Worker. */
import type { StageStat } from '../dsp/analyze';

export interface RunRequest {
  type: 'run';
  id: number;
  sr: number;
  /** transferred (zero-copy) */
  channels: Float32Array[];
}

/** What the page needs from the full TsAnalysisResult (the JSON itself stays in the Worker). */
export interface RunSummary {
  stages: StageStat[];
  /** performance.now() spans: resample, analyze, whole run in the Worker (ms) */
  resampleMs: number;
  totalMs: number;
  memPeak: number;
  beats: number;
  chords: number;
  sections: number;
  resultJsonBytes: number;
  warnings: string[];
}

export type WorkerMessage =
  | { type: 'stage'; id: number; stage: StageStat }
  | { type: 'done'; id: number; summary: RunSummary; workerHeap?: number }
  | { type: 'error'; id: number; message: string };
