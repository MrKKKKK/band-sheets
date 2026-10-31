/**
 * Spike 5 T14: pooled aggregates of recording takes for one level (from out/r3/pool.ts of the dev looks, as a function).
 * Output is numbers only: pooled and per-take F50 per instrument, grid F, edits vs keyboard, summed confusion, timing spread.
 * No hits, no pitches, no titles.
 */
import { gridScores, mapInst, matchOnsets, scoreTake, type DrumTruth } from './score';
import { confusionTable } from './report';
import type { DrumAnalysisResult, DrumLevel } from './types';

export interface PoolItem {
  id: string;
  truth: DrumTruth & { excludedBars?: number[] };
  result: DrumAnalysisResult;
}
type C = { tp: number; nRef: number; nEst: number };
const f = (c: C) => (c.nRef && c.nEst ? (2 * c.tp) / (c.nRef + c.nEst) : 0);
const fx = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(3));
const quantile = (x: number[], p: number) => [...x].sort((a, b) => a - b)[Math.min(x.length - 1, Math.floor(p * x.length))];

export function poolTakes(items: PoolItem[], level: DrumLevel, cfg?: Parameters<typeof scoreTake>[0]['cfg']): string {
  const tol = 0.05;
  const pooled: Record<string, C> = {};
  const perTake: Record<string, Record<string, number>> = {};
  const conf: Record<string, Record<string, number>> = {};
  const dev: Record<string, number[]> = {};
  const offs: number[] = [];
  let edits = 0, kb = 0, kbCopy = 0, hitEdits = 0, swingEdits = 0, gT = 0, gR = 0, gE = 0;
  for (const { id, truth, result } of items) {
    const ts = scoreTake({ truth, result, level, cfg, excludedBars: truth.excludedBars ?? [], align: true });
    const off = ts.alignment.offsetSec;
    offs.push(off * 1000);
    const ref = truth.hits.map((h) => ({ ...h, inst: mapInst(h.inst, level) })).filter((h) => h.inst) as { t: number; inst: string }[];
    const est = (result.drums as { t: number; inst: string }[]).map((h) => ({ t: h.t - off, inst: mapInst(h.inst, level) })).filter((h) => h.inst) as { t: number; inst: string }[];
    perTake[id] = {};
    const all: C = { tp: 0, nRef: ref.length, nEst: est.length };
    for (const inst of new Set([...ref.map((h) => h.inst), ...est.map((h) => h.inst)])) {
      const r = ref.filter((h) => h.inst === inst).map((h) => h.t);
      const e = est.filter((h) => h.inst === inst).map((h) => h.t);
      const pairs = r.length && e.length ? matchOnsets(r, e, tol) : [];
      const c = (pooled[inst] ??= { tp: 0, nRef: 0, nEst: 0 });
      c.tp += pairs.length;
      c.nRef += r.length;
      c.nEst += e.length;
      all.tp += pairs.length;
      perTake[id][inst] = f({ tp: pairs.length, nRef: r.length, nEst: e.length });
      for (const [i, j] of pairs) (dev[inst] ??= []).push((e[j] - r[i]) * 1000);
    }
    perTake[id].all = f(all);
    for (const [a, row] of Object.entries(ts.confusion)) for (const [b, n] of Object.entries(row)) ((conf[a] ??= {})[b] = (conf[a][b] ?? 0) + n);
    const s = ts.scores;
    edits += s['edit.count'];
    hitEdits += s['edit.hits'];
    swingEdits += s['edit.swing'];
    kb += s['edit.keyboardSteps'];
    kbCopy += s['edit.keyboardStepsCopy'];
    perTake[id].grid = s['grid.f'];
    perTake[id].edit = s['edit.ratioToKeyboard'];
    const q = result.drum.quantized!;
    const tq = truth.hits.map((h) => ({ bar: h.bar, tick: h.tick, inst: mapInst(h.inst, level), mark: (h as { mark?: string }).mark })).filter((h) => h.inst) as never[];
    const eq = q.hits.map((h: { inst: string }) => ({ ...h, inst: mapInst(h.inst, level) })).filter((h: { inst: string | null }) => h.inst) as never[];
    const g = gridScores(tq, eq);
    gT += g.matched;
    gR += g.nRef;
    gE += g.nEst;
  }
  const insts = Object.keys(pooled).sort();
  const out: string[] = [`## ${level}`, '', `offset ms per take: ${offs.map((o) => o.toFixed(0)).join(', ')}`, ''];
  out.push('| take | ' + insts.join(' | ') + ' | all | grid | edits/kbd |', '|' + ' --- |'.repeat(insts.length + 4));
  for (const { id } of items) out.push(`| ${id} | ` + insts.map((i) => fx(perTake[id][i])).join(' | ') + ` | ${fx(perTake[id].all)} | ${fx(perTake[id].grid)} | ${fx(perTake[id].edit)} |`);
  const allC = Object.values(pooled).reduce((a, c) => ({ tp: a.tp + c.tp, nRef: a.nRef + c.nRef, nEst: a.nEst + c.nEst }), { tp: 0, nRef: 0, nEst: 0 });
  out.push('| pooled F | ' + insts.map((i) => fx(f(pooled[i]))).join(' | ') + ` | ${fx(f(allC))} | ${fx((2 * gT) / (gR + gE))} | ${fx(edits / kb)} |`);
  out.push('| pooled P | ' + insts.map((i) => fx(pooled[i].nEst ? pooled[i].tp / pooled[i].nEst : 0)).join(' | ') + ' | | | |');
  out.push('| pooled R | ' + insts.map((i) => fx(pooled[i].nRef ? pooled[i].tp / pooled[i].nRef : 0)).join(' | ') + ' | | | |');
  out.push('| n truth / est | ' + insts.map((i) => `${pooled[i].nRef}/${pooled[i].nEst}`).join(' | ') + ' | | | |', '');
  out.push(`edits ${edits} (hits ${hitEdits}, swing ${swingEdits}), keyboard ${kb}, copy ${kbCopy}; ratio ${fx(edits / kb)}, copy ${fx(edits / kbCopy)}`, '');
  out.push('confusion (truth x est, +-50 ms, summed):', '', confusionTable(conf), '', 'timing est-truth (matched, ms): n, median, |median|, p95|.|');
  for (const i of insts) if (dev[i]?.length) out.push(`- ${i}: n ${dev[i].length}, median ${quantile(dev[i], 0.5).toFixed(1)}, |median| ${quantile(dev[i].map(Math.abs), 0.5).toFixed(1)}, p95 ${quantile(dev[i].map(Math.abs), 0.95).toFixed(1)}`);
  return out.join('\n') + '\n';
}
