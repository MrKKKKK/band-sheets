/** Messages between the bench page (main thread) and the analysis Worker. */
import type { SliceResult, StageStat } from './slice';

export interface RunRequest {
  type: 'run';
  id: number;
  sr: number;
  /** transferred (zero-copy) */
  channels: Float32Array[];
}

export type WorkerMessage =
  | { type: 'stage'; id: number; stage: StageStat }
  | { type: 'done'; id: number; result: SliceResult; workerHeap?: number }
  | { type: 'error'; id: number; message: string };
