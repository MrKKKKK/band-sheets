import type { AnalysisProgress } from './analysisTypes';

/** The progress view of the import screens (S1b / S2b): steps table and its state for the last progress event. */

/** The six steps shown to the user, each covering consecutive analyzer stages (in order). */
export const CHORD_STEPS: readonly ImportStep[] = [
  { label: '音声を読み込む', stages: ['decode'] },
  { label: '音を変換する', stages: ['resample', 'load'] },
  { label: '拍と小節の頭を探す', stages: ['beats'] },
  {
    label: 'コードを調べる',
    stages: ['chroma', 'chords', 'downbeat', 'merge'],
  },
  { label: 'セクションに分ける', stages: ['sections'] },
  { label: 'キーを調べる', stages: ['key', 'keytrack', 'chords2', 'merge2'] },
];

export type StepState = 'done' | 'now' | 'wait';

export interface ImportProgressView {
  steps: { label: string; state: StepState }[];
  /** 1-based number of the running step (= steps.length when all are done). */
  current: number;
  /** 0..1 over the analyzer's stages. */
  fraction: number;
}

export type ImportStep = { label: string; stages: readonly string[] };

/**
 * Step states for the last progress event (null = nothing finished yet). `steps` cover the kind's analyzer
 * stages in order.
 */
export function importProgressView(
  p: Pick<AnalysisProgress, 'done' | 'total'> | null,
  steps: readonly ImportStep[],
): ImportProgressView {
  const total = p?.total ?? steps.reduce((n, s) => n + s.stages.length, 0);
  const done = Math.max(0, Math.min(p?.done ?? 0, total));
  let end = 0;
  let current = steps.length;
  const view = steps.map((s, i) => {
    end += s.stages.length;
    const state: StepState =
      done >= end ? 'done' : done >= end - s.stages.length ? 'now' : 'wait';
    if (state === 'now' && current === steps.length) current = i + 1;
    return { label: s.label, state };
  });
  return { steps: view, current, fraction: total > 0 ? done / total : 0 };
}
