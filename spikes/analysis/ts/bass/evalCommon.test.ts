import { describe, expect, it } from 'vitest';
import { median, type ScoreChord } from './score';
import { argOf, at, parseJsonl, slashIn, withSlashMarks } from './evalCommon';
import { withBass } from './segment_eval';
import type { SegmentBass } from './segmentBass';
import type { SlashMark } from './slash';

// Characterization of the eval-harness helpers shared by segment_eval / baseline / t9_sweep (behaviour-preserving dedupe).
const chords: ScoreChord[] = [
  { start: 0, end: 2, root: 'C', quality: 'maj', bass: 'E' },
  { start: 2, end: 4, root: 'Bb', quality: 'min7', bass: 'F' },
  { start: 4, end: 5, root: 'F#', quality: '7', bass: null },
];
const mark = (bass: number): SlashMark => ({ bass, kind: 'inversion', confidence: 0.5, second: { pc: 0, confidence: 0.1 } }) as SlashMark;

describe('withSlashMarks', () => {
  it('only sets bass: a sharp name for a mark, null otherwise; every other field (text too) untouched; no length check', () => {
    const withText = chords.map((c, i) => ({ ...c, text: ['C/E', 'Bbm7/F', 'F#7'][i] }));
    const out = withSlashMarks(withText, [mark(4), null, mark(10)]);
    expect(out).toEqual([
      { start: 0, end: 2, root: 'C', quality: 'maj', bass: 'E', text: 'C/E' },
      { start: 2, end: 4, root: 'Bb', quality: 'min7', bass: null, text: 'Bbm7/F' },
      { start: 4, end: 5, root: 'F#', quality: '7', bass: 'A#', text: 'F#7' },
    ]);
    expect(withSlashMarks(withText, [mark(4)]).map((c) => c.bass)).toEqual(['E', null, null]);
  });
});

describe('slashIn', () => {
  it('root pitch class (flats ok), quality and the beat count of each segment (at least 1)', () => {
    expect(slashIn(chords, [0, 1, 2, 3])).toEqual([
      { root: 0, quality: 'maj', beats: 2 },
      { root: 10, quality: 'min7', beats: 2 },
      { root: 6, quality: '7', beats: 1 },
    ]);
  });
});

describe('withBass', () => {
  it('writes the B-1 bass as a sharp name, null when it equals the root', () => {
    const sb = (pc: number): SegmentBass => ({ pc, midi: 36 + pc, confidence: 0.5, second: { pc: 0, confidence: 0.1 } });
    expect(withBass(chords, [sb(0), sb(11), sb(6)]).map((c) => c.bass)).toEqual([null, 'B', null]);
    expect(withBass(chords, [sb(1), sb(10), sb(3)]).map((c) => c.bass)).toEqual(['C#', null, 'D#']);
  });
});

describe('argOf / at / parseJsonl', () => {
  it('argOf: value after the flag, undefined when absent or last', () => {
    expect(argOf(['--a', '1', '--b'], '--a')).toBe('1');
    expect(argOf(['--a', '1', '--b'], '--b')).toBeUndefined();
    expect(argOf(['--a', '1'], '--c')).toBeUndefined();
  });
  it('at: [start, end) lookup, undefined outside', () => {
    expect(at(chords, 2)?.root).toBe('Bb');
    expect(at(chords, 1.999)?.root).toBe('C');
    expect(at(chords, 5)).toBeUndefined();
  });
  it('parseJsonl: skips blank lines, null = no file', () => {
    expect(parseJsonl<{ a: number }>('{"a":1}\n\n  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonl(null)).toEqual([]);
  });
});

describe('median', () => {
  it('odd / even / unsorted / empty (NaN), input not mutated', () => {
    const x = [3, 1, 2];
    expect(median(x)).toBe(2);
    expect(x).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNaN();
  });
});
