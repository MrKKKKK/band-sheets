import { describe, expect, it } from 'vitest';
import { editCounts as editCounts6, normalizeTruthSlash, scoreBass, type ScoreBeat, type ScoreChord } from '../../bass/score';
import { editCounts, editDiff, scoreChords, wilson, type EvalChord } from './score';

// 120 BPM, 8 beats; every beat has two points (0.125 / 0.375 into the beat) of weight 0.5: 16 points = 8.0 in all.
const beats: ScoreBeat[] = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5 }));
const ch = (start: number, end: number, root: string, quality: string, bass: string | null = null, extra: Partial<EvalChord> = {}): EvalChord => ({ start, end, root, quality, bass, ...extra });

describe('wilson', () => {
  it('matches the textbook values', () => {
    const w = wilson(3, 4)!;
    expect(w.lo).toBeCloseTo(0.3006, 3);
    expect(w.hi).toBeCloseTo(0.9544, 3);
    expect(wilson(0, 10)!.lo).toBe(0);
    expect(wilson(10, 10)!.hi).toBe(1);
    expect(wilson(0, 0)).toBeNull();
    const w2 = wilson(50, 100)!; // 0.5 +- 0.0962 (z 1.96, n 100)
    expect(w2.lo).toBeCloseTo(0.4038, 3);
    expect(w2.hi).toBeCloseTo(0.5962, 3);
  });
});

describe('hand calculation', () => {
  // truth: C | Am6 (quality collapsed to min, original m6) | G/B | Dsus2 (2 beats = 4 points each)
  const truth = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min', null, { originalQuality: 'm6' }), ch(2, 3, 'G', 'maj', 'B'), ch(3, 4, 'D', 'sus2', null, { originalQuality: 'sus2' })];
  // result: all four right in name, except G without its /B
  const result = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'm6'), ch(2, 3, 'G', 'maj'), ch(3, 4, 'D', 'sus2')];

  it('全: all 16 points are scored; name 12/16 = .75; units 3 of 4', () => {
    const s = scoreChords(truth, result, beats, 'full');
    expect(s.nPoints).toBe(8);
    expect(s.droppedPoints).toBe(0);
    expect(s.name.points).toEqual({ hit: 6, n: 8, rate: 0.75 });
    expect(s.name.units).toMatchObject({ hit: 3, n: 4, rate: 0.75 });
    expect(s.name.units.wilson!.lo).toBeCloseTo(0.3006, 3);
    expect(s.root.rate).toBe(1);
    expect(s.slashRoot.points).toEqual({ hit: 2, n: 2, rate: 1 });
    expect(s.slash).toMatchObject({ truthSlash: 2, resultSlash: 0, hit: 0, recall: 0, precision: null, f: 0 });
    expect(s.wrongSlash).toMatchObject({ noSlashTruth: 6, falseSlash: 0, rate: 0 });
    expect(s.byQuality.m6.truth).toEqual({ hit: 2, n: 2, rate: 1 });
    expect(s.byQuality.sus2.result).toEqual({ hit: 2, n: 2, rate: 1 });
    const e = editCounts(truth, result, beats, 'full');
    expect(e).toMatchObject({ name: 0, slashAdd: 1, total: 1, nBeats: 8 });
  });
  it('落: sus2 is not counted (4 points dropped); m6 and min agree; name 8/12', () => {
    const s = scoreChords(truth, result, beats, 'down');
    expect(s.nPoints).toBe(6);
    expect(s.droppedPoints).toBe(2);
    expect(s.name.points).toEqual({ hit: 4, n: 6, rate: 4 / 6 });
    expect(s.name.units).toMatchObject({ hit: 2, n: 3 });
    const e = editCounts(truth, result, beats, 'down');
    expect(e).toMatchObject({ slashAdd: 1, total: 1, nBeats: 6 });
  });
  it('全 tells m6 from min; 落 does not', () => {
    const asMin = result.map((c) => (c.quality === 'm6' ? { ...c, quality: 'min' } : c));
    expect(scoreChords(truth, asMin, beats, 'full').name.points.hit).toBe(4); // Am6 now wrong
    expect(scoreChords(truth, asMin, beats, 'down').name.points.hit).toBe(4); // same as before: m6 = min
    expect(editCounts(truth, asMin, beats, 'full').name).toBe(1);
    expect(editCounts(truth, asMin, beats, 'down').name).toBe(0);
  });
  it('a truth without originalQuality uses quality (spike 2-6 truths)', () => {
    const old = truth.map(({ originalQuality: _o, ...c }) => c);
    const s = scoreChords(old, result, beats, 'full');
    // Am6 as 'min' vs result 'm6' is a miss; D 'sus2' is in the vocabulary as written
    expect(s.name.points.hit).toBe(4);
  });
  it('a quality outside the full vocabulary is not scored in 全 but is mapped in 落', () => {
    const t = [ch(0, 2, 'C', '7(#9)'), ch(2, 4, 'G', 'maj')];
    const r = [ch(0, 2, 'C', '7'), ch(2, 4, 'G', 'maj')];
    expect(scoreChords(t, r, beats, 'full').nPoints).toBe(4);
    expect(scoreChords(t, r, beats, 'down').nPoints).toBe(8);
    expect(scoreChords(t, r, beats, 'down').name.points.rate).toBe(1);
  });
  it('wrong /X rate with and without a result chord; no chord and N are not hits', () => {
    const t = [ch(0, 2, 'C', 'maj'), ch(2, 4, 'F', 'maj')];
    const r = [ch(0, 1, 'C', 'maj', 'E'), ch(1, 2, 'C', 'maj')]; // second half of the truth has no result chord
    const s = scoreChords(t, r, beats, 'down');
    // 16 points = 8.0; noSlash = all 8.0; false /X on the first beat-pair's chord: beats 0,1 = 4 points = 2.0
    expect(s.wrongSlash.noSlashTruth).toBe(8);
    expect(s.wrongSlash.falseSlash).toBe(2);
    expect(s.wrongSlash.rate).toBe(0.25);
    expect(s.wrongSlash.onChordPoints).toEqual({ hit: 2, n: 4, rate: 0.5 });
    expect(s.noChordPoints).toBe(4);
    expect(s.name.points.hit).toBe(2); // only C without /X on beats 2,3
  });
  it('candidates: a name edit that a candidate would fix is counted separately', () => {
    const t = [ch(0, 4, 'C', '6')];
    const r = [ch(0, 4, 'A', 'min7', null, { candidates: [{ root: 'C', quality: '6' }] })];
    const e = editCounts(t, r, beats, 'full');
    expect(e).toMatchObject({ name: 1, nameFixableByCandidate: 1, total: 1 });
    expect(editCounts(t, [ch(0, 4, 'A', 'min7')], beats, 'full').nameFixableByCandidate).toBe(0);
  });
  it('editDiff: stripping the result bass costs a slashAdd', () => {
    const d = editDiff(truth, result, beats, 'full');
    expect(d.withBass.total).toBe(1);
    expect(d.withoutBass.total).toBe(1);
    const withB = result.map((c) => (c.root === 'G' ? { ...c, bass: 'B' } : c));
    const d2 = editDiff(truth, withB, beats, 'full');
    expect([d2.withBass.total, d2.withoutBass.total]).toEqual([0, 1]);
    expect(d2.savedPer100Beats).toBe(12.5);
  });
});

/* ---- parity with spike 6's scorer (ts/bass/score.ts): same inputs, 落 = spike 6's numbers ---- */

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// every quality spike 6's mapVocab and mapDown map the same way (no mM7), plus sus2 (dropped in both)
const QUALITIES = ['maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus4', 'm7b5', 'dim7', 'sus2', 'm6', '6', 'add9', 'm9', '9', '7sus4'];

function randomChart(r: () => number, end: number, gaps: boolean): ScoreChord[] {
  const out: ScoreChord[] = [];
  let t = 0;
  while (t < end) {
    const len = 0.25 + Math.floor(r() * 6) * 0.25;
    const root = ROOTS[Math.floor(r() * 12)];
    const bass = r() < 0.3 ? ROOTS[Math.floor(r() * 12)] : null;
    if (!(gaps && r() < 0.15)) out.push({ start: t, end: Math.min(end, t + len), root, quality: QUALITIES[Math.floor(r() * QUALITIES.length)], bass });
    t += len;
  }
  return out;
}

describe('parity with ts/bass/score.ts', () => {
  it('落 equals scoreBass and editCounts on 200 random charts', () => {
    const r = rng(7);
    for (let k = 0; k < 200; k++) {
      const truth = randomChart(r, 4, false);
      const result = randomChart(r, 4, true);
      const tn = normalizeTruthSlash(truth);
      const a = scoreBass(tn, result, beats);
      const b = scoreChords(truth, result, beats, 'down');
      expect(b.nPoints).toBe(a.nPoints);
      expect(b.slash).toEqual(a.slash);
      expect(b.wrongSlash.noSlashTruth).toBe(a.wrongSlash.noSlashTruth);
      expect(b.wrongSlash.falseSlash).toBe(a.wrongSlash.falseSlash);
      expect(b.wrongSlash.rate).toBe(a.wrongSlash.rate);
      const e6 = editCounts6(tn, result, beats);
      const e = editCounts(truth, result, beats, 'down');
      const { nameFixableByCandidate: _n, ...rest } = e;
      expect(rest).toEqual(e6);
    }
  });
});
