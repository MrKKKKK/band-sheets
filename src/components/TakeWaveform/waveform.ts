/** Downsamples bucket peaks (0–1) to `count` columns, each the largest peak it covers. */
export function waveformColumns(
  peaks: ArrayLike<number>,
  count: number,
): number[] {
  const n = peaks.length;
  if (n === 0 || count <= 0) return [];
  const cols = Math.min(count, n);
  const out: number[] = new Array<number>(cols).fill(0);
  for (let i = 0; i < n; i++) {
    const c = Math.min(cols - 1, Math.floor((i * cols) / n));
    const v = Math.min(1, Math.max(0, peaks[i]));
    if (v > out[c]) out[c] = v;
  }
  return out;
}

/** Times (s) of the bar lines in a take: 0 (the count-in's start), then every bar until `durationSec`. */
export function barLineTimes(durationSec: number, barSec: number): number[] {
  if (!(durationSec > 0) || !(barSec > 0)) return [];
  const out: number[] = [];
  for (let k = 0; k * barSec < durationSec - 1e-9; k++) out.push(k * barSec);
  return out;
}
