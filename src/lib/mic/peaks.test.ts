import { describe, expect, it } from 'vitest';
import { peakBuckets } from './peaks';

describe('peakBuckets', () => {
  it('takes the max |sample| per bucket, including a short last one', () => {
    const p = peakBuckets(
      [Int16Array.from([0, -16384]), Int16Array.from([100, 32767, 5])],
      2,
    );
    expect(Array.from(p)).toEqual([0.5, 32767 / 32768, 5 / 32768]);
  });

  it('is empty for no samples', () => {
    expect(peakBuckets([], 480).length).toBe(0);
  });

  it('with fewer samples than one bucket gives one bucket', () => {
    expect(Array.from(peakBuckets([Int16Array.from([-32768])], 480))).toEqual([
      1,
    ]);
  });
});
