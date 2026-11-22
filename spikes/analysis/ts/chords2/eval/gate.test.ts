import { describe, expect, it } from 'vitest';
import { addedQualities, choosePairRule, fixedBroken, handEdits, handEditsPer100, newQualityOutput, seventhAsTriad } from './gate';
import { newAgg, summarize } from './baselineAgg';
import type { EvalChord } from './score';

const beats = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((t) => ({ t }));
const ch = (start: number, end: number, root: string, quality: string, extra: Partial<EvalChord> = {}): EvalChord => ({ start, end, root, quality, bass: null, ...extra });

describe('G1 gate bookkeeping', () => {
  it('counts 7th chords read as triads (root matched only)', () => {
    const truth = [ch(0, 2, 'G', '7'), ch(2, 4, 'A', 'min7'), ch(4, 6, 'D', 'min7'), ch(6, 8, 'C', 'maj')];
    const result = [ch(0, 2, 'G', 'maj'), ch(2, 4, 'A', 'min'), ch(4, 6, 'F', 'maj'), ch(6, 8, 'C', 'maj')];
    // G7 -> G: 2 beats = 2 points; Am7 -> Am: 2; Dm7 -> F: other root, not counted
    expect(seventhAsTriad(truth, result, beats)).toEqual({ d7AsMaj: 2, m7AsMin: 2 });
  });

  it('new-quality output: only qualities the stage added, over scored points', () => {
    expect(addedQualities('V1')).toEqual(expect.arrayContaining(['mM7', 'm6', '6']));
    expect(addedQualities('V1')).not.toContain('min7');
    expect(addedQualities('V0')).toEqual([]);
    const truth = [ch(0, 4, 'A', 'min'), ch(4, 8, 'C', 'maj')];
    const result = [ch(0, 2, 'A', 'm6'), ch(2, 4, 'A', 'min'), ch(4, 8, 'C', 'sus2')];
    expect(newQualityOutput(truth, result, beats, 'V1')).toEqual({ points: 2, n: 8 }); // sus2 is V2
    expect(newQualityOutput(truth, result, beats, 'V2')).toEqual({ points: 6, n: 8 });
  });

  it('fixed / broken segments of a candidate against a base (paired)', () => {
    const truth = [ch(0, 2, 'C', 'maj', { bass: 'E' }), ch(2, 4, 'A', 'min'), ch(4, 8, 'F', 'maj')];
    const base = [ch(0, 2, 'E', 'min'), ch(2, 4, 'A', 'min'), ch(4, 8, 'F', 'maj')];
    const cand = [ch(0, 2, 'C', 'maj', { bass: 'E' }), ch(2, 4, 'C', 'maj'), ch(4, 8, 'F', 'maj')];
    expect(fixedBroken(truth, base, cand, beats, 'down')).toEqual({ fixed: 1, broken: 1, units: 3 });
    expect(fixedBroken(truth, base, base, beats, 'down')).toEqual({ fixed: 0, broken: 0, units: 3 });
  });

  it('hand edits leave out candidate-fixable edits', () => {
    expect(handEdits({ name: 3, slashAdd: 1, slashRemove: 0, slashChange: 0, split: 0, merge: 1, total: 5, nBeats: 10, nameFixableByCandidate: 2 })).toBe(3);
    const a = newAgg();
    a.edits.total = 30;
    a.edits.nameFixableByCandidate = 10;
    a.edits.nBeats = 200;
    expect(handEditsPer100(summarize(a))).toBeCloseTo(10);
    expect(handEditsPer100(summarize(newAgg()))).toBeNull();
  });

  it('G3 pair rule: under 5 conflict segments apart -> bassRoot, else the better one', () => {
    expect(choosePairRule(40, 36)).toBe('bassRoot');
    expect(choosePairRule(41, 36)).toBe('context');
    expect(choosePairRule(30, 36)).toBe('bassRoot');
    expect(choosePairRule(36, 36)).toBe('bassRoot');
  });
});
