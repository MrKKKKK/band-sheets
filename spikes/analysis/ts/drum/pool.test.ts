import { describe, expect, it } from 'vitest';
import { countF, poolNumbers, renderPool, type PoolItem } from './pool';
import { resolveDrumConfig } from './config';
import { scoreTake } from './score';

// two bars of truth; the estimate has an extra SD in bar 1 and a closing head at bar 2 (after the last truth bar)
const truth = {
  barTicks: 64,
  barStartsSec: [0, 2, 4],
  hits: [
    { t: 0, bar: 0, tick: 0, inst: 'BD' },
    { t: 1, bar: 0, tick: 32, inst: 'SD' },
    { t: 2, bar: 1, tick: 0, inst: 'BD' },
  ],
};
const result = {
  drums: [
    { t: 0.0, inst: 'BD' },
    { t: 1.04, inst: 'SD' },
    { t: 2.0, inst: 'BD' },
    { t: 3.0, inst: 'SD' },
    { t: 4.0, inst: 'BD' },
  ],
  drum: { quantized: { bpm: 120, ts: [4, 4], startSec: 0, hits: [{ bar: 0, tick: 0, inst: 'BD' }, { bar: 0, tick: 32, inst: 'SD' }, { bar: 1, tick: 0, inst: 'BD' }, { bar: 1, tick: 32, inst: 'SD' }, { bar: 2, tick: 0, inst: 'BD' }] } },
} as unknown as PoolItem['result'];

describe('poolNumbers', () => {
  it('sums scoreTake counts, so excluded bars are dropped from the pooled F and grid too (T16 should-fix 1)', () => {
    const item: PoolItem = { id: 'x', truth: { ...truth, excludedBars: [1] }, result };
    const p = poolNumbers([item, item], 'S-3', { align: false });
    const one = scoreTake({ truth, result, level: 'S-3', excludedBars: [1] });
    expect(countF(p.all)).toBeCloseTo(one.scores['onset.f.all'], 12);
    expect(countF(p.grid)).toBeCloseTo(one.scores['grid.f'], 12);
    expect(p.perInst.BD.nRef).toBe(2); // bar 1's BD is excluded
    expect(p.edits).toBe(2 * one.scores['edit.count']);
    expect(renderPool(p)).toContain('pooled F');
  });
  it('uses cfg.score.toleranceSec, not a fixed 50 ms', () => {
    const item: PoolItem = { id: 'x', truth, result };
    const base = resolveDrumConfig({});
    const tight = resolveDrumConfig({ score: { ...base.score, toleranceSec: 0.03 } });
    expect(poolNumbers([item], 'S-3', { align: false }).perInst.SD.matched).toBe(1);
    expect(poolNumbers([item], 'S-3', { cfg: tight, align: false }).perInst.SD.matched).toBe(0);
  });
  it('the closing head after the last truth bar is a delete in the edits', () => {
    const p = poolNumbers([{ id: 'x', truth, result }], 'S-3', { align: false });
    expect(p.hitEdits).toBe(2); // extra SD in bar 1 + BD at bar 2
  });
});
