import { describe, expect, it } from 'vitest';
import { ANALYSIS_STAGES } from '../../analysis/types';
import { CHORD_STEPS, importProgressView } from './importProgress';

describe('importProgressView', () => {
  it('covers exactly the chords stages, in order', () => {
    expect(CHORD_STEPS.flatMap((s) => s.stages)).toEqual([
      ...ANALYSIS_STAGES.chords,
    ]);
  });

  it('starts with the first step running', () => {
    const v = importProgressView(null, CHORD_STEPS);
    expect(v.current).toBe(1);
    expect(v.fraction).toBe(0);
    expect(v.steps.map((s) => s.state)).toEqual([
      'now',
      'wait',
      'wait',
      'wait',
      'wait',
      'wait',
    ]);
  });

  it('marks finished steps and the running one', () => {
    // decode, resample, load, beats, chroma done -> step 4 (chords) running
    const v = importProgressView({ done: 5, total: 13 }, CHORD_STEPS);
    expect(v.steps.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'now',
      'wait',
      'wait',
    ]);
    expect(v.current).toBe(4);
    expect(v.fraction).toBeCloseTo(5 / 13);
  });

  it('is all done at the end', () => {
    const v = importProgressView({ done: 13, total: 13 }, CHORD_STEPS);
    expect(v.steps.every((s) => s.state === 'done')).toBe(true);
    expect(v.current).toBe(6);
    expect(v.fraction).toBe(1);
  });
});
