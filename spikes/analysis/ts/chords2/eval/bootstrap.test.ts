import { describe, expect, it } from 'vitest';
import type { ScoreBeat } from '../../bass/score';
import { pointRate, pointSum, segmentBootstrap } from './bootstrap';
import { scoreChords, segmentTallies, wilson, type EvalChord, type SegmentTally } from './score';

// as score.test.ts: 120 BPM, 8 beats, two points of weight 0.5 per beat
const beats: ScoreBeat[] = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5 }));
const ch = (start: number, end: number, root: string, quality: string, bass: string | null = null): EvalChord => ({ start, end, root, quality, bass });

describe('segmentTallies: the points of scoreChords, per truth segment', () => {
  const truth = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min'), ch(2, 3, 'G', 'maj', 'B'), ch(3, 4, 'D', 'min7')];
  const result = [ch(0, 1, 'C', 'maj'), ch(1, 1.75, 'A', 'min'), ch(1.75, 2, 'F', 'maj'), ch(2, 3, 'G', 'maj'), ch(3, 4, 'D', 'min')];
  it('sum to the line points and give one unit per segment (name and /X root)', () => {
    for (const vocab of ['full', 'down'] as const) {
      const s = scoreChords(truth, result, beats, vocab);
      const name = segmentTallies(truth, result, beats, vocab, 'name');
      expect(name).toHaveLength(s.name.units.n);
      expect({ hit: pointSum(name), n: name.reduce((a, u) => a + u.n, 0) }).toEqual({ hit: s.name.points.hit, n: s.name.points.n });
      expect(pointRate(name)).toBe(s.name.points.rate);
      const sr = segmentTallies(truth, result, beats, vocab, 'slashRoot');
      expect(sr).toEqual([{ hit: 2, n: 2 }]);
      expect(pointRate(sr)).toBe(s.slashRoot.points.rate);
    }
    expect(segmentTallies(truth, result, beats, 'full', 'name')).toEqual([
      { hit: 2, n: 2 },
      { hit: 1.5, n: 2 },
      { hit: 0, n: 2 },
      { hit: 0, n: 2 },
    ]);
  });
});

describe('segmentBootstrap', () => {
  // 40 segments: 30 long ones (4 points, 3 hit) and 10 short ones (1 point, 0 hit). Point rate 90/130 = .692,
  // unit rate 30/40 = .75: the Wilson interval of the units is about another number than the point-rate line.
  const units: SegmentTally[] = [...Array.from({ length: 30 }, () => ({ hit: 1.5, n: 2 })), ...Array.from({ length: 10 }, () => ({ hit: 0, n: 0.5 }))];
  it('is centred on the point rate (the line unit), not on the unit rate', () => {
    const r = pointRate(units)!;
    expect(r).toBeCloseTo(45 / 65, 9);
    const b = segmentBootstrap(units, pointRate)!;
    expect(b.lo).toBeLessThan(r);
    expect(b.hi).toBeGreaterThan(r);
    expect(b.hi - b.lo).toBeLessThan(0.2);
    const w = wilson(30, 40)!;
    expect((w.lo + w.hi) / 2).toBeGreaterThan((b.lo + b.hi) / 2); // the old pairing compared two different numbers
  });
  it('is deterministic for a seed, and narrows with more segments', () => {
    expect(segmentBootstrap(units, pointRate)).toEqual(segmentBootstrap(units, pointRate));
    expect(segmentBootstrap(units, pointRate, { seed: 2 })).not.toEqual(segmentBootstrap(units, pointRate, { seed: 1 }));
    const many = [...units, ...units, ...units, ...units];
    const a = segmentBootstrap(units, pointRate)!;
    const m = segmentBootstrap(many, pointRate)!;
    expect(m.hi - m.lo).toBeLessThan(a.hi - a.lo);
  });
  it('works for point counts and for paired rows (cand vs base on the same segments)', () => {
    const s = segmentBootstrap(units, pointSum)!;
    expect(s.lo).toBeLessThanOrEqual(45);
    expect(s.hi).toBeGreaterThanOrEqual(45);
    const paired = units.map((u, i) => ({ base: u.hit, cand: i % 2 ? u.hit / 2 : u.hit }));
    const d = segmentBootstrap(paired, (xs) => xs.reduce((a, x) => a + x.cand, 0) - xs.reduce((a, x) => a + x.base / 2, 0))!;
    expect(d.lo).toBeLessThan(d.hi);
  });
  it('is null without segments or values; a constant statistic has a zero-width interval', () => {
    expect(segmentBootstrap([], pointRate)).toBeNull();
    expect(segmentBootstrap([{ hit: 0, n: 0 }], pointRate)).toBeNull();
    expect(segmentBootstrap([{ hit: 1, n: 1 }], pointRate)).toEqual({ lo: 1, hi: 1 });
  });
});
