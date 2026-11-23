/**
 * Spike 8 T2 (docs/audio-spike8-plan.md §3, §4-3; spike 7 carry-over 5): the interval of a gate line in the line's own
 * unit. Spike 7 put a point-rate line next to a Wilson interval on segment units (score.ts `wilson`), two different
 * units. Here the truth segments are resampled with replacement (a segment carries all its points, so points of one
 * chord do not count as independent) and the line's statistic is recomputed on each resample:
 *   - point-rate lines (name, /X root, ...): pointRate over score.ts segmentTallies;
 *   - point-count lines ("7th read as a triad" points, plan §3 / decision 9): pointSum over per-segment counts;
 *   - a line against a base row on the same files: units that carry both rows, `stat` compares them (paired).
 * Percentile interval, deterministic (seeded mulberry32). Pure.
 */
import { prng } from '../../../render/prng';
import type { Interval, SegmentTally, SegmentUnit } from './score';

export interface BootstrapOptions {
  /** resamples (default 2000) */
  reps?: number;
  /** PRNG seed (default 1): the same input gives the same interval */
  seed?: number;
  /** coverage (default .95) */
  level?: number;
}

/** Point rate of segments: sum of hit points / sum of scored points (null when there are no points). */
export const pointRate = (us: readonly SegmentTally[]): number | null => {
  const n = us.reduce((a, u) => a + u.n, 0);
  return n ? us.reduce((a, u) => a + u.hit, 0) / n : null;
};
/** Point count of segments: sum of hit points. */
export const pointSum = (us: readonly SegmentTally[]): number => us.reduce((a, u) => a + u.hit, 0);

/**
 * Percentile interval of `stat` over `reps` resamples of the segments (each resample = as many segments as given,
 * drawn with replacement). Resamples where `stat` is null are left out; null when there is no segment or no value.
 */
export function segmentBootstrap<T>(units: readonly T[], stat: (sample: readonly T[]) => number | null, o: BootstrapOptions = {}): Interval | null {
  const reps = o.reps ?? 2000;
  const level = o.level ?? 0.95;
  if (!units.length || reps < 1) return null;
  const rnd = prng(o.seed ?? 1);
  const vals: number[] = [];
  const sample: T[] = new Array(units.length);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < units.length; i++) sample[i] = units[Math.floor(rnd() * units.length)];
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return { lo: q((1 - level) / 2), hi: q(1 - (1 - level) / 2) };
}

/* ------------------------------------------------------------ paired with a base row (spike 8 T7) */

/** One truth segment carrying a row (`a`) and the base row (`b`) on it; a row without points there has { hit 0, n 0 }. */
export interface PairedUnit {
  a: SegmentTally;
  b: SegmentTally;
}

/**
 * Pairs two rows' segment units of the same files (one entry per file) by segment (`seg` from score.ts segmentUnits). The union of both rows' segments is kept, so a measure whose scope depends on the result (precision)
 * pairs too. Order: by file, then segment.
 */
export function pairUnits(files: readonly { a: readonly SegmentUnit[]; b: readonly SegmentUnit[] }[]): PairedUnit[] {
  const out: PairedUnit[] = [];
  const zero = (): SegmentTally => ({ hit: 0, n: 0 });
  for (const f of files) {
    const m = new Map<number, PairedUnit>();
    for (const u of f.a) (m.get(u.seg) ?? m.set(u.seg, { a: zero(), b: zero() }).get(u.seg)!).a = { hit: u.hit, n: u.n };
    for (const u of f.b) (m.get(u.seg) ?? m.set(u.seg, { a: zero(), b: zero() }).get(u.seg)!).b = { hit: u.hit, n: u.n };
    out.push(...[...m.entries()].sort((x, y) => x[0] - y[0]).map(([, u]) => u));
  }
  return out;
}

const sideA = (us: readonly PairedUnit[]) => us.map((u) => u.a);
const sideB = (us: readonly PairedUnit[]) => us.map((u) => u.b);
/** Point rate of the row minus the base's on the same segments (null when either has no points). */
export const rateDiff = (us: readonly PairedUnit[]): number | null => {
  const x = pointRate(sideA(us));
  const y = pointRate(sideB(us));
  return x === null || y === null ? null : x - y;
};
/** Point count of the row over the base's on the same segments (null when the base has none): decision 9's statistic. */
export const sumRatio = (us: readonly PairedUnit[]): number | null => {
  const d = pointSum(sideB(us));
  return d ? pointSum(sideA(us)) / d : null;
};
/** The row's side alone (a point-rate line that has no base, e.g. precision >= .80). */
export const rateOfA = (us: readonly PairedUnit[]): number | null => pointRate(sideA(us));
