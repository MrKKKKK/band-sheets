// Test helper copied from the research branch (spikes/analysis/ts/parity/compare.ts signalToErrorDb).
type Vec = ArrayLike<number>;

/** 10 * log10(sum(expected^2) / sum((actual - expected)^2)); Infinity when identical. */
export function signalToErrorDb(actual: Vec, expected: Vec): number {
  if (actual.length !== expected.length)
    throw new Error(`length mismatch: ${actual.length} vs ${expected.length}`);
  let s = 0;
  let n = 0;
  for (let i = 0; i < actual.length; i++) {
    s += expected[i] * expected[i];
    n += (actual[i] - expected[i]) ** 2;
  }
  if (n === 0) return Infinity;
  if (s === 0) return -Infinity;
  return 10 * Math.log10(s / n);
}
