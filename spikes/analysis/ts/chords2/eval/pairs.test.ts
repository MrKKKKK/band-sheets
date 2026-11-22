import { describe, expect, it } from 'vitest';
import { TRUTH_ROWS } from '../identicalPairs';
import { bassOnlyReading, pairReadings, parseReading, scorePairs, soundOnlyReading, type PairItem } from './pairs';
import { noteToPc } from '../../bass/score';

describe('readings', () => {
  it('parses names and finds the other reading of a pair', () => {
    expect(parseReading('C6')).toEqual({ root: 0, quality: '6' });
    expect(parseReading('F#m7b5')).toEqual({ root: 6, quality: 'm7b5' });
    expect(parseReading('Bbm7')).toEqual({ root: 10, quality: 'min7' });
    expect(() => parseReading('Cfoo')).toThrow();
    expect(pairReadings(parseReading('C6'))).toEqual([parseReading('C6'), parseReading('Am7')]);
    expect(pairReadings(parseReading('Am7'))).toEqual([parseReading('Am7'), parseReading('C6')]);
    expect(pairReadings(parseReading('Am6'))![1]).toEqual(parseReading('F#m7b5'));
    expect(pairReadings(parseReading('Gsus4'))![1]).toEqual(parseReading('Csus2'));
    expect(pairReadings(parseReading('Fsus2'))![1]).toEqual(parseReading('Csus4'));
    expect(pairReadings(parseReading('Cmaj'.replace('maj', '')))).toBeNull();
  });
  it('every row of the truth table has both readings in a pair', () => {
    for (const r of TRUTH_ROWS) expect(pairReadings(parseReading(r.truth))![1], r.id).toEqual(parseReading(r.candidate));
  });
});

// Hand calculation on the confirmed truth table (identicalPairs.ts TRUTH_ROWS, 25 rows, 8 of them 食い違う).
const items = (rule: (truth: ReturnType<typeof parseReading>, bass: number) => ReturnType<typeof parseReading> | null): PairItem[] =>
  TRUTH_ROWS.map((r) => {
    const truth = parseReading(r.truth);
    return { id: r.id, conflict: r.conflict, truth, got: rule(truth, noteToPc(r.bass)) };
  });

describe('scorePairs', () => {
  it('table: 25 rows, conflict rows A6 A7 A9 A10 B5 B6 B9 C4', () => {
    expect(TRUTH_ROWS.length).toBe(25);
    expect(TRUTH_ROWS.filter((r) => r.conflict).map((r) => r.id)).toEqual(['A6', 'A7', 'A9', 'A10', 'B5', 'B6', 'B9', 'C4']);
  });
  it('音だけ: the v1a reading wins; right on A3-A6 A9 B3 B4 B8 C1 C4 (10 of 25), on conflict rows A6 A9 C4 (3 of 8)', () => {
    const s = scorePairs(items((t) => soundOnlyReading(pairReadings(t)!)));
    expect(s.all).toMatchObject({ hit: 10, n: 25 });
    expect(s.conflict).toMatchObject({ hit: 3, n: 8, rate: 3 / 8 });
    expect(s.nonConflict).toMatchObject({ hit: 7, n: 17 });
    expect(s.conflict.wilson!.lo).toBeGreaterThan(0.1);
    expect(s.conflict.wilson!.hi).toBeLessThan(0.7);
  });
  it('ベースだけ: right on every non-conflict row (bass = truth root); on conflict rows the bass picks a reading only in B5 (wrong) so 3 of 8 again', () => {
    const s = scorePairs(items((t, bass) => bassOnlyReading(pairReadings(t)!, bass)));
    expect(s.nonConflict).toMatchObject({ hit: 17, n: 17, rate: 1 });
    expect(s.conflict).toMatchObject({ hit: 3, n: 8 });
    expect(s.all).toMatchObject({ hit: 20, n: 25 });
  });
  it('no reading is a miss', () => {
    expect(scorePairs(items(() => null)).all).toMatchObject({ hit: 0, n: 25 });
  });
});
