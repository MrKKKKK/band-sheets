/**
 * numpy arithmetic helpers shared by the DSP ports (single implementation each).
 *
 *   pairwiseSum(a, start, n, rnd)  numpy's add.reduce on a contiguous run (pairwise summation)
 *   roundHalfEven(x)               np.round / Python round (ties to even)
 */

type Round = (x: number) => number;
const id: Round = (x) => x;

/** np.round / Python round: ties to even. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * numpy's pairwise summation (umath loops: < 8 sequential, <= 128 eight accumulators, else split at
 * n/2 rounded down to a multiple of 8). `rnd` = Math.fround for float32 arrays, identity for float64.
 * np.mean = this / n.
 */
export function pairwiseSum(a: ArrayLike<number>, start = 0, n = a.length - start, rnd: Round = id): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res = rnd(res + a[start + i]);
    return res;
  }
  if (n <= 128) {
    const r = new Float64Array(8);
    for (let j = 0; j < 8; j++) r[j] = a[start + j];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = rnd(r[j] + a[start + i + j]);
    let res = rnd(rnd(rnd(r[0] + r[1]) + rnd(r[2] + r[3])) + rnd(rnd(r[4] + r[5]) + rnd(r[6] + r[7])));
    for (; i < n; i++) res = rnd(res + a[start + i]);
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return rnd(pairwiseSum(a, start, n2, rnd) + pairwiseSum(a, start + n2, n - n2, rnd));
}
