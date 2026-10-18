/**
 * Parity comparison helpers (plan section 4). All take (actual, expected): `expected` is the
 * Python value. Arrays are compared in float64 arithmetic.
 */

type Vec = ArrayLike<number>;

function checkLen(a: Vec, b: Vec): void {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`);
}

/**
 * Max over i of |a_i - e_i| / max(|e_i|, floor). `floor` keeps near-zero expected values
 * from blowing the ratio up (default 1e-12).
 */
export function maxRelativeError(actual: Vec, expected: Vec, floor = 1e-12): number {
  checkLen(actual, expected);
  let m = 0;
  for (let i = 0; i < actual.length; i++) {
    const r = Math.abs(actual[i] - expected[i]) / Math.max(Math.abs(expected[i]), floor);
    if (r > m || Number.isNaN(r)) m = r;
  }
  return m;
}

/** Max |a_i - e_i| / max_j |e_j| (scale-relative; robust for STFT bins near zero). */
export function maxErrorOverPeak(actual: Vec, expected: Vec): number {
  checkLen(actual, expected);
  let peak = 0;
  let err = 0;
  for (let i = 0; i < actual.length; i++) {
    peak = Math.max(peak, Math.abs(expected[i]));
    err = Math.max(err, Math.abs(actual[i] - expected[i]));
  }
  return peak === 0 ? (err === 0 ? 0 : Infinity) : err / peak;
}

/** Cosine similarity; 1 for two zero vectors, 0 if exactly one is zero. */
export function cosineSimilarity(a: Vec, b: Vec): number {
  checkLen(a, b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 && nb === 0) return 1;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Pearson correlation; NaN when either side is constant. */
export function correlation(a: Vec, b: Vec): number {
  checkLen(a, b);
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += (a[i] - ma) * (b[i] - mb);
    na += (a[i] - ma) ** 2;
    nb += (b[i] - mb) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * Cosine per column of a row-major [rows, cols] matrix (e.g. chroma [12, frames]).
 */
export function columnCosines(
  actual: Vec,
  expected: Vec,
  rows: number,
  cols: number,
): Float64Array {
  checkLen(actual, expected);
  if (actual.length !== rows * cols) throw new Error('shape does not match length');
  const out = new Float64Array(cols);
  const ca = new Float64Array(rows);
  const cb = new Float64Array(rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      ca[r] = actual[r * cols + c];
      cb[r] = expected[r * cols + c];
    }
    out[c] = cosineSimilarity(ca, cb);
  }
  return out;
}

/** Fraction of values >= threshold. */
export function fractionAtLeast(values: Vec, threshold: number): number {
  let k = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= threshold) k++;
  return values.length === 0 ? 1 : k / values.length;
}

/**
 * Signal-to-error ratio in dB: 10 log10(sum e^2 / sum (a-e)^2).
 * Infinity when identical; -Infinity when expected is all zero but actual is not.
 */
export function signalToErrorDb(actual: Vec, expected: Vec): number {
  checkLen(actual, expected);
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

export interface ShiftRow {
  /** actual[i + lag] is compared with expected[i]. */
  lag: number;
  /** Signal-to-error ratio (dB) over the overlapping part. */
  snrDb: number;
  /** Cosine over the overlapping part. */
  cosine: number;
}

/**
 * Offset/shift table for 1-D signals: for each lag in [-maxLag, maxLag], compare the
 * overlap of actual shifted by `lag` against expected. `best` is the row with max cosine
 * (ties: smallest |lag|). Use it to tell "slightly shifted" from "wrong".
 */
export function shiftTable(
  actual: Vec,
  expected: Vec,
  maxLag: number,
): { rows: ShiftRow[]; best: ShiftRow } {
  const rows: ShiftRow[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const start = Math.max(0, -lag);
    const end = Math.min(expected.length, actual.length - lag);
    const a: number[] = [];
    const e: number[] = [];
    for (let i = start; i < end; i++) {
      a.push(actual[i + lag]);
      e.push(expected[i]);
    }
    rows.push({ lag, snrDb: signalToErrorDb(a, e), cosine: cosineSimilarity(a, e) });
  }
  let best = rows[0];
  for (const r of rows) {
    if (
      r.cosine > best.cosine + 1e-15 ||
      (Math.abs(r.cosine - best.cosine) <= 1e-15 && Math.abs(r.lag) < Math.abs(best.lag))
    ) {
      best = r;
    }
  }
  return { rows, best };
}

export interface TimeOffsets {
  /** false when the counts differ (no pairing is attempted then). */
  sameCount: boolean;
  nActual: number;
  nExpected: number;
  /** actual[i] - expected[i], in input units (seconds). Empty when counts differ. */
  offsets: number[];
  maxAbs: number;
  meanSigned: number;
  /** Fraction of pairs with |offset| <= tol. */
  withinTol: number;
}

/** Compare event times (beats, boundaries) pairwise; they must have the same count. */
export function timeOffsets(actual: Vec, expected: Vec, tol: number): TimeOffsets {
  const base = { nActual: actual.length, nExpected: expected.length };
  if (actual.length !== expected.length) {
    return {
      ...base,
      sameCount: false,
      offsets: [],
      maxAbs: NaN,
      meanSigned: NaN,
      withinTol: NaN,
    };
  }
  const offsets: number[] = [];
  let maxAbs = 0;
  let sum = 0;
  let ok = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = actual[i] - expected[i];
    offsets.push(d);
    maxAbs = Math.max(maxAbs, Math.abs(d));
    sum += d;
    if (Math.abs(d) <= tol) ok++;
  }
  const n = actual.length;
  return {
    ...base,
    sameCount: true,
    offsets,
    maxAbs,
    meanSigned: n ? sum / n : 0,
    withinTol: n ? ok / n : 1,
  };
}
