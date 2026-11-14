import { describe, expect, it } from 'vitest';
import { median, type ScoreChord } from './score';
import { slashIn, withBass, withSlashMarks } from './segment_eval';
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
  it('writes the mark as a sharp name and clears the bass of unmarked chords', () => {
    const out = withSlashMarks(chords, [mark(4), null, mark(10)]);
    expect(out.map((c) => c.bass)).toEqual(['E', null, 'A#']);
    expect(out.map((c) => [c.start, c.end, c.root, c.quality])).toEqual(chords.map((c) => [c.start, c.end, c.root, c.quality]));
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
