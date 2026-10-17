/** Small comparison helpers shared by the bench page and the Node preview test (T8). */

/** Share of reference beats with a beat within tol (greedy one-to-one in time order), over max(count). */
export function beatShare(a: readonly number[], ref: readonly number[], tol = 0.005): number {
  let i = 0;
  let j = 0;
  let hit = 0;
  while (i < a.length && j < ref.length) {
    const d = a[i] - ref[j];
    if (Math.abs(d) <= tol) {
      hit++;
      i++;
      j++;
    } else if (d < 0) i++;
    else j++;
  }
  return hit / Math.max(a.length, ref.length, 1);
}

/** Label of the column containing time t (columns given by their start times). */
export function labelAt(times: readonly number[], labels: readonly string[], t: number): string {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return 'N';
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return labels[lo];
}

/** Share of `ref` columns (midpoints) whose label equals `a`'s label at the same time. */
export function columnAgreement(
  a: { columnTimes: readonly number[]; columnLabels: readonly string[] },
  refMidpoints: readonly number[],
  refLabels: readonly string[],
): number {
  if (refLabels.length === 0) return 1;
  let same = 0;
  refLabels.forEach((l, i) => {
    if (labelAt(a.columnTimes, a.columnLabels, refMidpoints[i]) === l) same++;
  });
  return same / refLabels.length;
}

/** Signal-to-error (dB) over [skip, n - skip) of the overlap, with b shifted by `lag` (b[i + lag] vs a[i]). */
export function snrDb(test: ArrayLike<number>, ref: ArrayLike<number>, lag = 0, skip = 2048): number {
  const n = Math.min(ref.length, test.length);
  let s = 0;
  let e = 0;
  for (let i = skip; i < n - skip; i++) {
    const j = i + lag;
    if (j < 0 || j >= test.length) continue;
    s += ref[i] * ref[i];
    e += (test[j] - ref[i]) ** 2;
  }
  return e === 0 ? Infinity : 10 * Math.log10(s / e);
}

/** Best integer lag in [-maxLag, maxLag] by SNR. */
export function bestLag(test: ArrayLike<number>, ref: ArrayLike<number>, maxLag = 8): { lag: number; snrDb: number } {
  let best = { lag: 0, snrDb: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = snrDb(test, ref, lag);
    if (v > best.snrDb) best = { lag, snrDb: v };
  }
  return best;
}
