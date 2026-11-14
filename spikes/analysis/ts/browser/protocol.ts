/** Messages between the bench page (main thread) and the analysis Worker. */
import type { StageStat } from '../dsp/analyze';

export interface RunRequest {
  type: 'run';
  id: number;
  sr: number;
  /** transferred (zero-copy); the Worker empties this array once it has resampled */
  channels: Float32Array[];
  /** Spike 6 T7: run the bass stage (ts/bass/analyze.ts) with these config overrides on top of `enabled: true`; absent = v1a only. */
  bass?: Record<string, unknown>;
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
  /** Spike 6 T7, only with `bass`: bass config hash and the number of chords that got a `/X` (no names: privacy). */
  bass?: { configHash: string; marked: number };
}

export type WorkerMessage =
  | { type: 'stage'; id: number; stage: StageStat }
  | { type: 'done'; id: number; summary: RunSummary; workerHeap?: number }
  /** code: AnalysisInputError code (unusable input; message is the Japanese text for the user) */
  | { type: 'error'; id: number; message: string; code?: string };
