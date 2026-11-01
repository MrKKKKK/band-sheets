/**
 * Spike 4 T13 mic check: pure logic of the measurement page (micCheckPage.ts). The page plays short
 * clicks at known AudioContext times and records the mic through an AudioWorklet that stamps every
 * block with the context frame it starts at; here we put those blocks back on the context's frame
 * axis, find each click's onset near its expected frame and summarize the delays (ms).
 *
 * Delay = when the click shows up in the recording - when it was scheduled = output latency + input
 * latency (+ the air path, ~0 for headphones on the mic, ~1 ms per 34 cm for speakers).
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

/** One block posted by the capture worklet: `frame` = the context frame of data[0]. */
export interface CapturedBlock {
  frame: number;
  data: Float32Array;
}

export interface Recording {
  /** context frame of samples[0] */
  startFrame: number;
  samples: Float32Array;
  /** frames with no block (worklet dropped / late), filled with 0 */
  gapFrames: number;
}

/** Blocks (any order, possibly with gaps or overlap) -> one buffer on the context frame axis. */
export function assembleBlocks(blocks: readonly CapturedBlock[]): Recording {
  if (blocks.length === 0) return { startFrame: 0, samples: new Float32Array(0), gapFrames: 0 };
  let start = Infinity;
  let end = -Infinity;
  for (const b of blocks) {
    start = Math.min(start, b.frame);
    end = Math.max(end, b.frame + b.data.length);
  }
  const samples = new Float32Array(end - start);
  const covered = new Uint8Array(end - start);
  for (const b of blocks) {
    samples.set(b.data, b.frame - start);
    covered.fill(1, b.frame - start, b.frame - start + b.data.length);
  }
  let gapFrames = 0;
  for (const c of covered) if (!c) gapFrames++;
  return { startFrame: start, samples, gapFrames };
}

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
export function highPass(x: Float32Array, sampleRate: number, cornerHz: number): Float32Array {
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
    const missing: ClickDetection = { index, expected: exp, onset: null, delayMs: null, peak: 0, noise: 0 };
    const from = Math.max(0, Math.floor(exp - (o.beforeMs / 1000) * sampleRate));
    const to = Math.min(hp.length, Math.ceil(exp + (o.afterMs / 1000) * sampleRate));
    if (!Number.isFinite(exp) || to - from < 16) return missing;
    const win = hp.subarray(from, to).map(Math.abs);
    let peak = 0;
    for (const v of win) if (v > peak) peak = v;
    const noise = median(win);
    if (peak < o.minPeak || peak < o.minSnr * noise) return { ...missing, peak, noise };
    const threshold = Math.max(o.thresholdRatio * peak, o.minSnr * noise);
    let i = 0;
    while (win[i] < threshold) i++;
    const onset = from + i;
    return { index, expected: exp, onset, delayMs: ((onset - exp) / sampleRate) * 1000, peak, noise };
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

/** The click the page plays: a 2 ms burst of a 4 kHz-ish square wave with a short fade. */
export function clickSamples(sampleRate: number, amplitude = 0.9): Float32Array<ArrayBuffer> {
  const n = Math.max(8, Math.round(sampleRate * 0.002));
  const period = Math.max(2, Math.round(sampleRate / 4000));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - i) / (n * 0.3));
    out[i] = (Math.floor((2 * i) / period) % 2 ? -1 : 1) * amplitude * fade;
  }
  return out;
}
