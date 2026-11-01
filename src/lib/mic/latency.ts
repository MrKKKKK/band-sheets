/**
 * Input-latency measurement for the microphone recording (docs/mic-recording-plan.md §1, §2.4). Ported
 * from the spike's `micCheck.ts` (research/audio-analysis, T13) — detection and stats unchanged. The
 * page plays short clicks at known AudioContext times and records the mic through an AudioWorklet; the
 * caller passes one contiguous Float32Array of the capture on the context's frame axis (from takeBuffer.ts) and the expected frames here.
 *
 * Round trip = when the click shows up in the recording - when it was scheduled = output latency +
 * input latency (+ the air path, ~0 for headphones on the mic). The browser reports part of it
 * (`baseLatency` + `outputLatency`); the rest is the "remainder" we measure once per microphone and
 * remember. The remainder can be negative (a device that over-reports `outputLatency`, Bluetooth…).
 *
 * Onset detection per click (never throws, a click it cannot see is `missing`):
 * - a first-order high-pass (~1 kHz) removes DC and mains hum; the click is a short burst at a few
 *   kHz, so it survives;
 * - search window = [expected - before, expected + after] on the high-passed signal;
 * - noise = median |x| of the window (the click covers a few ms of hundreds, so the median is the
 *   floor), peak = max |x|; the click counts only if peak >= minSnr * noise and >= minPeak;
 * - onset = the first sample with |x| >= max(thresholdRatio * peak, minSnr * noise) (clipping does
 *   not move the first crossing).
 */

export interface DetectOptions {
  /** search starts this long before the expected time (ms) */
  beforeMs: number;
  /** ... and ends this long after it (ms); keep below the click spacing */
  afterMs: number;
  /** high-pass corner (Hz) */
  highPassHz: number;
  thresholdRatio: number;
  minSnr: number;
  /** absolute floor for the peak (full scale = 1) */
  minPeak: number;
}

export const DEFAULT_DETECT: DetectOptions = {
  beforeMs: 5,
  afterMs: 400,
  highPassHz: 1000,
  thresholdRatio: 0.3,
  minSnr: 8,
  minPeak: 0.002,
};

export interface ClickDetection {
  /** index of the click (0-based) */
  index: number;
  /** expected sample index in the recording (may be fractional) */
  expected: number;
  /** onset sample index, null = missing */
  onset: number | null;
  /** onset - expected in ms, null = missing */
  delayMs: number | null;
  peak: number;
  noise: number;
}

/** First-order high-pass (RC), a new array. */
export function highPass(
  x: Float32Array,
  sampleRate: number,
  cornerHz: number,
): Float32Array {
  const y = new Float32Array(x.length);
  if (x.length === 0) return y;
  const rc = 1 / (2 * Math.PI * cornerHz);
  const a = rc / (rc + 1 / sampleRate);
  let prevX = x[0];
  let prevY = 0;
  for (let i = 1; i < x.length; i++) {
    const v = a * (prevY + x[i] - prevX);
    y[i] = v;
    prevY = v;
    prevX = x[i];
  }
  return y;
}

function median(values: Float32Array): number {
  if (values.length === 0) return 0;
  const s = Float32Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Finds each click near `expected[i]` (sample indexes into `samples`, may be fractional or outside
 * the recording). Non-finite samples are read as 0.
 */
export function detectClicks(
  samples: Float32Array,
  sampleRate: number,
  expected: readonly number[],
  options: Partial<DetectOptions> = {},
): ClickDetection[] {
  const o = { ...DEFAULT_DETECT, ...options };
  const clean = samples.map((v) => (Number.isFinite(v) ? v : 0));
  const hp = highPass(clean, sampleRate, o.highPassHz);
  return expected.map((exp, index) => {
    const missing: ClickDetection = {
      index,
      expected: exp,
      onset: null,
      delayMs: null,
      peak: 0,
      noise: 0,
    };
    const from = Math.max(
      0,
      Math.floor(exp - (o.beforeMs / 1000) * sampleRate),
    );
    const to = Math.min(
      hp.length,
      Math.ceil(exp + (o.afterMs / 1000) * sampleRate),
    );
    if (!Number.isFinite(exp) || to - from < 16) return missing;
    const win = hp.subarray(from, to).map(Math.abs);
    let peak = 0;
    for (const v of win) if (v > peak) peak = v;
    const noise = median(win);
    if (peak < o.minPeak || peak < o.minSnr * noise)
      return { ...missing, peak, noise };
    const threshold = Math.max(o.thresholdRatio * peak, o.minSnr * noise);
    let i = 0;
    while (win[i] < threshold) i++;
    const onset = from + i;
    return {
      index,
      expected: exp,
      onset,
      delayMs: ((onset - exp) / sampleRate) * 1000,
      peak,
      noise,
    };
  });
}

export interface Stats {
  count: number;
  mean: number;
  /** sample standard deviation (n - 1); 0 for one value */
  stdev: number;
  min: number;
  max: number;
}

/** Stats of the non-null values; null when there are none. */
export function stats(values: readonly (number | null)[]): Stats | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const varSum = v.reduce((a, b) => a + (b - mean) ** 2, 0);
  return {
    count: v.length,
    mean,
    stdev: v.length > 1 ? Math.sqrt(varSum / (v.length - 1)) : 0,
    min: Math.min(...v),
    max: Math.max(...v),
  };
}

/** The measurement plays this many clicks; at least `MIN_FOUND` must be seen. */
export const MEASURE_CLICKS = 4;
export const MIN_FOUND = 3;
/** Largest allowed max - min of the found round trips (ms), ends included. */
export const MAX_SPREAD_MS = 5;
/** A round trip outside this (ms, ends included) is not a latency of this mic. */
export const MIN_ROUND_TRIP_MS = 0;
export const MAX_ROUND_TRIP_MS = 300;

/** What the browser reports while the clicks sound (seconds); invalid values count as 0. */
export interface ReportedLatency {
  baseLatencySec: number;
  outputLatencySec: number;
}

export type LatencyVerdict =
  | {
      ok: true;
      /** median of the found round trips (ms) */
      roundTripMs: number;
      /** max - min of the found round trips (ms) */
      spreadMs: number;
      /** roundTripMs - (base + output); may be negative */
      remainderMs: number;
      found: number;
    }
  | { ok: false; reason: 'tooFew' | 'unstable' | 'outOfRange' };

const nonNeg = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

function medianOf(sorted: readonly number[]): number {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * Decides whether a measurement counts: >= 3 clicks found, spread <= 5 ms, median round trip within
 * 0-300 ms. The range is checked on the ROUND TRIP, not on the remainder (which can be negative).
 */
export function judgeLatency(
  detections: readonly ClickDetection[],
  reported: ReportedLatency,
): LatencyVerdict {
  const delays = detections
    .map((d) => d.delayMs)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (delays.length < MIN_FOUND) return { ok: false, reason: 'tooFew' };
  const spreadMs = delays[delays.length - 1] - delays[0];
  if (spreadMs > MAX_SPREAD_MS) return { ok: false, reason: 'unstable' };
  const roundTripMs = medianOf(delays);
  if (roundTripMs < MIN_ROUND_TRIP_MS || roundTripMs > MAX_ROUND_TRIP_MS)
    return { ok: false, reason: 'outOfRange' };
  const reportedMs =
    (nonNeg(reported.baseLatencySec) + nonNeg(reported.outputLatencySec)) *
    1000;
  return {
    ok: true,
    roundTripMs,
    spreadMs,
    remainderMs: roundTripMs - reportedMs,
    found: delays.length,
  };
}

export interface CompensationInput extends ReportedLatency {
  /** the remembered remainder of this microphone; null = not measured (counts as 0) */
  remainderMs: number | null;
}

/** Seconds to shift a take by: base + output (read while the clicks sound) + the remainder. Never negative. */
export function compensationSec(c: CompensationInput): number {
  const remainder =
    c.remainderMs !== null && Number.isFinite(c.remainderMs)
      ? c.remainderMs / 1000
      : 0;
  return Math.max(
    0,
    nonNeg(c.baseLatencySec) + nonNeg(c.outputLatencySec) + remainder,
  );
}

export function compensationFrames(sec: number, sampleRate: number): number {
  return Math.round(sec * sampleRate);
}
