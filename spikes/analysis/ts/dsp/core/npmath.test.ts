import { describe, expect, it } from 'vitest';
import { pairwiseSum, roundHalfEven } from './npmath';

describe('roundHalfEven', () => {
  it('matches np.round', () => {
    expect([10.5, 11.5, -0.5, 0.5, 1.5, 2.4, 2.6, 21 / 2].map(roundHalfEven)).toEqual([10, 12, -0, 0, 2, 2, 3, 10]);
  });
});

describe('pairwiseSum', () => {
  // Reference values come from numpy (float64 / float32 `.sum()` of the same arrays).
  it('follows numpy pairwise order (8 accumulators)', () => {
    expect(pairwiseSum([1e16, 1, 1, 1, 1, 1, 1, 1, 1, -1e16])).toBe(8);
    expect(pairwiseSum([1, 2, 3])).toBe(6);
    expect(pairwiseSum([])).toBe(0);
  });
  it('matches numpy on long float64 runs (split above 128) and sub-ranges', () => {
    const a = Array.from({ length: 1000 }, (_, i) => 0.1 * ((i % 7) + 1));
    expect(pairwiseSum(a)).toBe(399.70000000000005);
    expect(pairwiseSum(a, 3, 20)).toBe(8.100000000000001);
  });
  it('matches numpy float32 sums with rnd = Math.fround', () => {
    const x = Float32Array.from({ length: 300 }, (_, i) => 0.1 * ((i % 7) + 1));
    expect(pairwiseSum(x, 0, 300, Math.fround)).toBe(119.69999694824219);
  });
});
