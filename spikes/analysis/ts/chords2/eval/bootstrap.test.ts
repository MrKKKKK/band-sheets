import { describe, expect, it } from 'vitest';
import type { ScoreBeat } from '../../bass/score';
import { pairUnits, pointRate, pointSum, rateDiff, rateOfA, segmentBootstrap, sumRatio } from './bootstrap';
import { scoreChords, segmentTallies, segmentUnits, wilson, type EvalChord, type SegmentTally } from './score';

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

describe('spike 8 T7: segment ids, the E1 pooled measures and pairing with a base row', () => {
  // truth C7 | Am7 | F | G7 (2 beats each); base reads the triads, the row reads C7, Am7, Fmaj7, G
  const truth = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', '7')];
  const base = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', 'maj')];
  const row = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'F', 'maj7'), ch(3, 4, 'G', 'maj')];
  it('segmentUnits carry the truth segment index; segmentTallies = the same without it', () => {
    const u = segmentUnits(truth, row, beats, 'full', 'name');
    expect(u.map((x) => x.seg)).toEqual([0, 1, 2, 3]);
    expect(segmentTallies(truth, row, beats, 'full', 'name')).toEqual(u.map(({ hit, n }) => ({ hit, n })));
  });
  it('E1 recall / precision pooled = byQuality over 7, maj7, min7, m7b5', () => {
    const q = scoreChords(truth, row, beats, 'full').byQuality;
    const sum = (side: 't' | 'r') => ['7', 'maj7', 'min7', 'm7b5'].reduce((a, k) => { const x = side === 't' ? q[k]?.truth : q[k]?.result; return { hit: a.hit + (x?.hit ?? 0), n: a.n + (x?.n ?? 0) }; }, { hit: 0, n: 0 });
    const rec = segmentUnits(truth, row, beats, 'full', 'addedRecallE1');
    const pre = segmentUnits(truth, row, beats, 'full', 'addedPrecisionE1');
    expect({ hit: pointSum(rec), n: rec.reduce((a, x) => a + x.n, 0) }).toEqual(sum('t'));
    expect({ hit: pointSum(pre), n: pre.reduce((a, x) => a + x.n, 0) }).toEqual(sum('r'));
    expect(pointRate(rec)).toBeCloseTo(4 / 6, 9); // C7, Am7 hit; G7 read G
    expect(pointRate(pre)).toBeCloseTo(4 / 6, 9); // C7, Am7 right; Fmaj7 on F wrong
  });
  it('pairUnits: union of both rows per segment; rateDiff, sumRatio, rateOfA', () => {
    const f = (m: Parameters<typeof segmentUnits>[4]) => pairUnits([{ a: segmentUnits(truth, row, beats, 'full', m), b: segmentUnits(truth, base, beats, 'full', m) }]);
    const pre = f('addedPrecisionE1'); // the base outputs no E1 quality: the row's segments only, base side empty
    expect(pre).toHaveLength(3);
    expect(pre.every((u) => u.b.n === 0)).toBe(true);
    expect(rateOfA(pre)).toBeCloseTo(4 / 6, 9);
    expect(rateDiff(pre)).toBeNull();
    const rec = f('addedRecallE1');
    expect(rateDiff(rec)).toBeCloseTo(4 / 6, 9);
    const tri = f('asTriadE1'); // 7th read as a triad: base C, Am, G (6 points), row G only (2)
    expect(sumRatio(tri)).toBeCloseTo(2 / 6, 9);
    expect(segmentBootstrap(tri, sumRatio)).not.toBeNull();
  });
});
