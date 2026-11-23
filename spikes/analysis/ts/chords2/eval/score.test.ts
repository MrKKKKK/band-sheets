import { describe, expect, it } from 'vitest';
import { editCounts as editCounts6, normalizeTruthSlash, scoreBass, type ScoreBeat, type ScoreChord } from '../../bass/score';
import { addConfusion, addFile, newAgg, newConfusion, summarize } from './baselineAgg';
import { seventhAsTriad } from './gate';
import { AS_TRIAD, bassOnlyAlternative, editCounts, editDiff, scoreChords, segmentTallies, wilson, type EvalChord, type Measure } from './score';

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
  it('candidates: only the shown ones count (cap 2 besides the answer; the answer and repeats skipped)', () => {
    const t = [ch(0, 4, 'C', '6')];
    const c = (root: string, quality: string) => ({ root, quality });
    // answer and a repeat do not take a slot: C6 is the 2nd shown candidate
    const r = [ch(0, 4, 'A', 'min7', null, { candidates: [c('A', 'min7'), c('C', 'maj'), c('C', 'maj'), c('C', '6')] })];
    expect(editCounts(t, r, beats, 'full').nameFixableByCandidate).toBe(1);
    // third shown candidate: past the cap
    const r3 = [ch(0, 4, 'A', 'min7', null, { candidates: [c('C', 'maj'), c('E', 'min'), c('C', '6')] })];
    expect(editCounts(t, r3, beats, 'full').nameFixableByCandidate).toBe(0);
  });
  it('candidates: the ベースにだけある音 other name also fixes a name edit', () => {
    const t = [ch(0, 4, 'A', 'mM7', 'G#')]; // AmM7/G# = Am over G#: Am is a hit too
    const r = [ch(0, 4, 'C', 'maj', 'G#', { candidates: [{ root: 'A', quality: 'min' }] })];
    expect(editCounts(t, r, beats, 'full')).toMatchObject({ name: 1, nameFixableByCandidate: 1 });
    expect(editCounts(t, r, beats, 'full', { bassOnly: false }).nameFixableByCandidate).toBe(0);
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

describe('ベースにだけある音 (both names are a hit, kept out of byQuality)', () => {
  it('finds the other name only when the quality-making note is in the bass alone', () => {
    expect(bassOnlyAlternative('mM7', 11)).toBe('min'); // AmM7/G# = Am over G#
    expect(bassOnlyAlternative('min7', 10)).toBe('min'); // Am7/G
    expect(bassOnlyAlternative('m6', 9)).toBe('min'); // Am6/F#
    expect(bassOnlyAlternative('maj', 2)).toBe('add9'); // C/D = Cadd9/D
    expect(bassOnlyAlternative('min', 10)).toBe('min7'); // Am/G = Am7/G
    expect(bassOnlyAlternative('maj', 10)).toBe('7'); // C/Bb
    expect(bassOnlyAlternative('7sus4', 10)).toBe('sus4');
    expect(bassOnlyAlternative('maj', 4)).toBeNull(); // C/E: an ordinary inversion
    expect(bassOnlyAlternative('6', 4)).toBeNull(); // C6/E
    expect(bassOnlyAlternative('m6', 7)).toBeNull(); // Fm6/C
    expect(bassOnlyAlternative('sus4', 7)).toBeNull(); // Gsus4/D
    expect(bassOnlyAlternative('9', 2)).toBeNull(); // 5 notes: never "a triad + the bass"
    expect(bassOnlyAlternative('13', 2)).toBeNull();
  });
  const truth = [ch(0, 2, 'A', 'mM7', 'G#', { originalQuality: 'mM7' }), ch(2, 4, 'C', 'maj', 'E')];
  it('either name of the bass-only chord is a name hit, in 全 and 落', () => {
    for (const q of ['mM7', 'min']) {
      const full = scoreChords(truth, [ch(0, 2, 'A', q, 'G#'), ch(2, 4, 'C', 'maj', 'E')], beats, 'full');
      expect(full.name.points.rate).toBe(1);
      expect(full.bassOnly.points).toEqual({ hit: 4, n: 4, rate: 1 });
      expect(editCounts(truth, [ch(0, 2, 'A', q, 'G#'), ch(2, 4, 'C', 'maj', 'E')], beats, 'full').name).toBe(0);
    }
    const wrong = scoreChords(truth, [ch(0, 2, 'A', 'min7', 'G#'), ch(2, 4, 'C', 'maj', 'E')], beats, 'full');
    expect(wrong.bassOnly.points.hit).toBe(0);
    const off = scoreChords(truth, [ch(0, 2, 'A', 'min', 'G#'), ch(2, 4, 'C', 'maj', 'E')], beats, 'full', { bassOnly: false });
    expect(off.name.points.rate).toBe(0.5);
    expect(off.bassOnly.points.n).toBe(0);
    const t2 = [ch(0, 4, 'C', 'maj', 'D')]; // C/D written as a triad: Cadd9/D is a hit too, in 落 that is maj
    expect(scoreChords(t2, [ch(0, 4, 'C', 'add9', 'D')], beats, 'full').name.points.rate).toBe(1);
    expect(scoreChords(t2, [ch(0, 4, 'C', 'add9', 'D')], beats, 'down').name.points.rate).toBe(1);
  });
  it('the bass-only points are not in byQuality (truth or result side)', () => {
    const s = scoreChords(truth, [ch(0, 2, 'A', 'min', 'G#'), ch(2, 4, 'C', 'maj', 'E')], beats, 'full');
    expect(s.byQuality.mM7).toBeUndefined();
    expect(s.byQuality.min).toBeUndefined();
    expect(s.byQuality.maj.truth).toEqual({ hit: 4, n: 4, rate: 1 });
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
      const b = scoreChords(truth, result, beats, 'down', { bassOnly: false }); // spike 6 has no ベースにだけある音 rule
      expect(b.nPoints).toBe(a.nPoints);
      expect(b.slash).toEqual(a.slash);
      expect(b.wrongSlash.noSlashTruth).toBe(a.wrongSlash.noSlashTruth);
      expect(b.wrongSlash.falseSlash).toBe(a.wrongSlash.falseSlash);
      expect(b.wrongSlash.rate).toBe(a.wrongSlash.rate);
      const e6 = editCounts6(tn, result, beats);
      const e = editCounts(truth, result, beats, 'down', { bassOnly: false });
      const { nameFixableByCandidate: _n, ...rest } = e;
      expect(rest).toEqual(e6);
    }
  });
});

describe('spike 8 §5: added-tone columns (T5)', () => {
  // truth C | G7 | Am7 | C/E, 2 beats each; result C7 then C | G (candidate G7) | Am7 | C7/E
  const truth = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'G', '7'), ch(2, 3, 'A', 'min7'), ch(3, 4, 'C', 'maj', 'E')];
  const result = [ch(0, 0.5, 'C', '7'), ch(0.5, 1, 'C', 'maj'), ch(1, 2, 'G', 'maj', null, { candidates: [{ root: 'G', quality: '7' }, { root: 'E', quality: 'min' }] }), ch(2, 3, 'A', 'min7'), ch(3, 4, 'C', '7', 'E')];
  it('hand calculation: triad names, over-adding, 7th read as triad, added-tone candidates', () => {
    const a = scoreChords(truth, result, beats, 'full').added;
    expect(a.triadName).toEqual({ hit: 1, n: 4, rate: 0.25 }); // C (4 points): 2 hit; C/E read C7/E: 0
    expect(a.overAdd).toEqual({ hit: 1, n: 2, rate: 0.5 }); // C only (C/E has /X); its first beat says C7
    expect(a.asTriad).toEqual({ '7': 2, min7: 0, '6': 0, m6: 0, mM7: 0 });
    expect(a.addedCandidate).toEqual({ hit: 2, n: 8, rate: 0.25 }); // G with G7 shown; Em (another root) does not count
  });
  it('per-segment tallies sum to the same points', () => {
    const sums = (m: Measure) => segmentTallies(truth, result, beats, 'full', m).reduce((x, u) => ({ hit: x.hit + u.hit, n: x.n + u.n }), { hit: 0, n: 0 });
    const a = scoreChords(truth, result, beats, 'full').added;
    for (const m of ['triadName', 'overAdd', 'addedCandidate'] as const) expect(sums(m)).toEqual({ hit: a[m].hit, n: a[m].n });
    expect(segmentTallies(truth, result, beats, 'full', 'overAdd')).toEqual([{ hit: 1, n: 2 }]);
    expect(segmentTallies(truth, result, beats, 'full', 'asTriadE1')).toEqual([{ hit: 2, n: 2 }, { hit: 0, n: 2 }]);
    expect(segmentTallies(truth, result, beats, 'full', 'addedCandidate')).toEqual([{ hit: 0, n: 2 }, { hit: 2, n: 2 }, { hit: 0, n: 2 }, { hit: 0, n: 2 }]);
  });
  it('asTriad = the spike 7 confusion counts (gate.ts seventhAsTriad reads it), E2 qualities too', () => {
    const t2 = [ch(0, 1, 'C', '6'), ch(1, 2, 'A', 'm6'), ch(2, 3, 'A', 'mM7'), ch(3, 4, 'G', '7')];
    const r2 = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min'), ch(2, 3, 'A', 'min'), ch(3, 4, 'G', 'maj')];
    const c = newConfusion();
    addConfusion(c, t2, r2, beats, 'full');
    const a = scoreChords(t2, r2, beats, 'full').added.asTriad;
    for (const [tq, rq] of Object.entries(AS_TRIAD.E2)) expect(a[tq as keyof typeof a]).toBe(c.quality[`${tq}|${rq}`] ?? 0);
    expect(a).toEqual({ '6': 2, m6: 2, mM7: 2, '7': 2, min7: 0 });
    expect(seventhAsTriad(t2, r2, beats)).toEqual({ d7AsMaj: 2, m7AsMin: 0 });
    expect(segmentTallies(t2, r2, beats, 'full', 'asTriadE1')).toEqual([{ hit: 2, n: 2 }]);
    expect(segmentTallies(t2, r2, beats, 'full', 'asTriadE2').map((u) => u.hit)).toEqual([2, 2, 2, 2]);
  });
  it('aggregates over files (baselineAgg)', () => {
    const agg = newAgg();
    addFile(agg, scoreChords(truth, result, beats, 'full'), editCounts(truth, result, beats, 'full'));
    addFile(agg, scoreChords(truth, result, beats, 'full'), editCounts(truth, result, beats, 'full'));
    expect(summarize(agg).added).toEqual({ triadName: 0.25, overAdd: 0.5, addedCandidatePer100: 25, asTriad: { '7': 4, min7: 0, '6': 0, m6: 0, mM7: 0 } });
  });
});
