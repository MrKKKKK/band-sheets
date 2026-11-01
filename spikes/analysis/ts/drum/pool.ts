/**
 * Spike 5 T14: pooled aggregates of takes for one level (from out/r3/pool.ts of the dev looks, as a function).
 * Output is numbers only: pooled and per-take F50 per instrument, grid F, edits vs keyboard, summed confusion, timing spread.
 * No hits, no pitches, no titles.
 *
 * T16 (review should-fix 1): the pooled numbers are SUMS of scoreTake's own counts (scoreTake drops excluded bars and uses
 * cfg.score.toleranceSec), so the pooled table and the per-take table always count the same hits.
 */
import { scoreTake, type DrumTruth } from './score';
import { confusionTable } from './report';
import type { DrumConfig } from './config';
import type { DrumAnalysisResult, DrumLevel } from './types';

export interface PoolItem {
  id: string;
  truth: DrumTruth & { excludedBars?: number[] };
  result: DrumAnalysisResult;
}
export type Counts = { matched: number; nRef: number; nEst: number };
export const countF = (c: Counts) => (c.nRef && c.nEst ? (2 * c.matched) / (c.nRef + c.nEst) : 0);
const add = (a: Counts, b: Counts) => ({ matched: a.matched + b.matched, nRef: a.nRef + b.nRef, nEst: a.nEst + b.nEst });
const ZERO: Counts = { matched: 0, nRef: 0, nEst: 0 };
const fx = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(3));
const quantile = (x: number[], p: number) => [...x].sort((a, b) => a - b)[Math.min(x.length - 1, Math.floor(p * x.length))];

export interface PoolNumbers {
  level: DrumLevel;
  perInst: Record<string, Counts>;
  all: Counts;
  grid: Counts;
  edits: number;
  hitEdits: number;
  swingEdits: number;
  keyboard: number;
  keyboardCopy: number;
  perTake: { id: string; offsetMs: number; f: Record<string, number>; all: number; grid: number; edit: number }[];
  confusion: Record<string, Record<string, number>>;
  devMs: Record<string, number[]>;
}

/** Sums of scoreTake counts. `align`: one global shift per take (recordings); synthetic truth is exact (align false). */
export function poolNumbers(items: PoolItem[], level: DrumLevel, opts: { cfg?: DrumConfig; align?: boolean } = {}): PoolNumbers {
  const p: PoolNumbers = { level, perInst: {}, all: ZERO, grid: ZERO, edits: 0, hitEdits: 0, swingEdits: 0, keyboard: 0, keyboardCopy: 0, perTake: [], confusion: {}, devMs: {} };
  for (const { id, truth, result } of items) {
    const ts = scoreTake({ truth, result, level, cfg: opts.cfg, excludedBars: truth.excludedBars ?? [], align: opts.align ?? true });
    const f: Record<string, number> = {};
    for (const [inst, c] of Object.entries(ts.counts.onset)) {
      p.perInst[inst] = add(p.perInst[inst] ?? ZERO, c);
      p.all = add(p.all, c);
      f[inst] = countF(c);
    }
    for (const [inst, d] of Object.entries(ts.counts.devSec)) (p.devMs[inst] ??= []).push(...d.map((x) => x * 1000));
    for (const [a, row] of Object.entries(ts.confusion)) for (const [b, n] of Object.entries(row)) ((p.confusion[a] ??= {})[b] = (p.confusion[a][b] ?? 0) + n);
    if (ts.counts.grid) p.grid = add(p.grid, ts.counts.grid);
    const s = ts.scores;
    p.edits += s['edit.count'] ?? 0;
    p.hitEdits += s['edit.hits'] ?? 0;
    p.swingEdits += s['edit.swing'] ?? 0;
    p.keyboard += s['edit.keyboardSteps'] ?? 0;
    p.keyboardCopy += s['edit.keyboardStepsCopy'] ?? 0;
    p.perTake.push({ id, offsetMs: ts.alignment.offsetSec * 1000, f, all: s['onset.f.all'], grid: s['grid.f'], edit: s['edit.ratioToKeyboard'] });
  }
  return p;
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

/** Markdown of poolNumbers (as the T14 summary). */
export function renderPool(p: PoolNumbers, opts: { perTakeRows?: boolean } = {}): string {
  const insts = Object.keys(p.perInst).sort();
  const out: string[] = [`## ${p.level}`, ''];
  if (opts.perTakeRows !== false) out.push(`offset ms per take: ${p.perTake.map((t) => t.offsetMs.toFixed(0)).join(', ')}`, '');
  out.push('| take | ' + insts.join(' | ') + ' | all | grid | edits/kbd |', '|' + ' --- |'.repeat(insts.length + 4));
  if (opts.perTakeRows !== false) for (const t of p.perTake) out.push(`| ${t.id} | ` + insts.map((i) => fx(t.f[i])).join(' | ') + ` | ${fx(t.all)} | ${fx(t.grid)} | ${fx(t.edit)} |`);
  out.push('| pooled F | ' + insts.map((i) => fx(countF(p.perInst[i]))).join(' | ') + ` | ${fx(countF(p.all))} | ${fx(countF(p.grid))} | ${fx(p.edits / p.keyboard)} |`);
  out.push('| pooled P | ' + insts.map((i) => fx(p.perInst[i].nEst ? p.perInst[i].matched / p.perInst[i].nEst : 0)).join(' | ') + ' | | | |');
  out.push('| pooled R | ' + insts.map((i) => fx(p.perInst[i].nRef ? p.perInst[i].matched / p.perInst[i].nRef : 0)).join(' | ') + ' | | | |');
  out.push('| n truth / est | ' + insts.map((i) => `${p.perInst[i].nRef}/${p.perInst[i].nEst}`).join(' | ') + ' | | | |', '');
  out.push(`edits ${p.edits} (hits ${p.hitEdits}, swing ${p.swingEdits}), keyboard ${p.keyboard}, copy ${p.keyboardCopy}; ratio ${fx(p.edits / p.keyboard)}, copy ${fx(p.edits / p.keyboardCopy)}; mean of per-take ratios ${fx(mean(p.perTake.map((t) => t.edit)))}`, '');
  out.push('confusion (truth x est, +-50 ms, summed):', '', confusionTable(p.confusion), '', 'timing est-truth (matched, ms): n, median, |median|, p95|.|');
  for (const i of insts) {
    const d = p.devMs[i];
    if (d?.length) out.push(`- ${i}: n ${d.length}, median ${quantile(d, 0.5).toFixed(1)}, |median| ${quantile(d.map(Math.abs), 0.5).toFixed(1)}, p95 ${quantile(d.map(Math.abs), 0.95).toFixed(1)}`);
  }
  return out.join('\n') + '\n';
}

/** Recordings (one global shift per take), as used by heldout_eval.ts. */
export const poolTakes = (items: PoolItem[], level: DrumLevel, cfg?: DrumConfig): string => renderPool(poolNumbers(items, level, { cfg, align: true }));
