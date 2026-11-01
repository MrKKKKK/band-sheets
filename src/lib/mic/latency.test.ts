import { describe, expect, it } from 'vitest';
import {
  compensationFrames,
  compensationSec,
  detectClicks,
  judgeLatency,
  MAX_SPREAD_MS,
  stats,
  type ClickDetection,
} from './latency';
import { softClickSamples } from './clickTrack';

const SR = 48000;

/**
 * The spike's sharp click (a 2 ms square burst at 4 kHz with a fade), kept here only so the spike's
 * detector tests below still check the onset of an impulsive click to a sample or two; the app plays
 * `softClickSamples` (tested further down).
 */
function sharpClick(amplitude: number): Float32Array {
  const n = Math.round(SR * 0.002);
  const period = Math.round(SR / 4000);
  return Float32Array.from({ length: n }, (_, i) => {
    const fade = Math.min(1, (n - i) / (n * 0.3));
    return (Math.floor((2 * i) / period) % 2 ? -1 : 1) * amplitude * fade;
  });
}

/** Deterministic noise (LCG), uniform in [-amp, amp]. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 2 ** 32) * 2 - 1) * amp;
  }
  return out;
}

/** 5 s of noise with clicks at expected + delay; returns signal and expected sample indexes. */
function scene(opts: {
  delaysMs: (number | null)[];
  noiseAmp?: number;
  gain?: number;
  extra?: (i: number) => number;
  /** the click wave at `gain` (default: the sharp click) */
  click?: (gain: number) => Float32Array;
  /** applied to the clicks before the noise (the headphones → mic path) */
  path?: (x: Float32Array) => Float32Array;
  seed?: number;
}) {
  const n = SR * 5;
  let x: Float32Array = new Float32Array(n);
  const click = (opts.click ?? sharpClick)(opts.gain ?? 0.5);
  const expected: number[] = [];
  opts.delaysMs.forEach((d, k) => {
    const exp = Math.round(SR * (0.5 + k * 0.5));
    expected.push(exp);
    if (d === null) return;
    const at = exp + Math.round((d / 1000) * SR);
    for (let i = 0; i < click.length; i++) x[at + i] += click[i];
  });
  if (opts.path) x = opts.path(x);
  const nz = noise(n, opts.noiseAmp ?? 0.002, opts.seed);
  for (let i = 0; i < n; i++) x[i] += nz[i];
  if (opts.extra) for (let i = 0; i < n; i++) x[i] += opts.extra(i);
  return { x, expected };
}

describe('detectClicks', () => {
  it('finds clicks at known delays within a sample or two', () => {
    const delays = [40, 41, 42.5, 39, 60, 40, 40, 45];
    const { x, expected } = scene({ delaysMs: delays });
    const r = detectClicks(x, SR, expected);
    r.forEach((c, i) => {
      expect(c.onset).not.toBeNull();
      expect(Math.abs(c.delayMs! - delays[i])).toBeLessThan(0.1);
    });
  });

  it('marks a missing click and keeps the others', () => {
    const { x, expected } = scene({ delaysMs: [30, null, 30, 30] });
    const r = detectClicks(x, SR, expected);
    expect(r[1].onset).toBeNull();
    expect(r[1].delayMs).toBeNull();
    expect(r.filter((c) => c.onset !== null)).toHaveLength(3);
  });

  it('ignores DC offset and mains hum', () => {
    const { x, expected } = scene({
      delaysMs: [25, 25, 25],
      extra: (i) => 0.2 + 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR),
    });
    for (const c of detectClicks(x, SR, expected))
      expect(Math.abs(c.delayMs! - 25)).toBeLessThan(0.1);
  });

  it('handles clipped clicks', () => {
    const { x, expected } = scene({ delaysMs: [80, 80], gain: 3 });
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
    for (const c of detectClicks(x, SR, expected))
      expect(Math.abs(c.delayMs! - 80)).toBeLessThan(0.1);
  });

  it('finds quiet clicks in moderate noise', () => {
    const { x, expected } = scene({
      delaysMs: [50, 50, 50],
      noiseAmp: 0.01,
      gain: 0.15,
    });
    for (const c of detectClicks(x, SR, expected))
      expect(Math.abs(c.delayMs! - 50)).toBeLessThan(0.3);
  });

  it('reports missing for silence, a steady tone, out-of-range times and NaN, without throwing', () => {
    const silent = new Float32Array(SR);
    expect(detectClicks(silent, SR, [1000])[0].onset).toBeNull();
    const tone = Float32Array.from(
      { length: SR * 2 },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR),
    );
    expect(detectClicks(tone, SR, [SR * 0.5])[0].onset).toBeNull();
    expect(
      detectClicks(silent, SR, [-SR, SR * 10, NaN]).every(
        (c) => c.onset === null,
      ),
    ).toBe(true);
    const nan = new Float32Array(SR).fill(NaN);
    expect(detectClicks(nan, SR, [1000])[0].onset).toBeNull();
    expect(detectClicks(new Float32Array(0), SR, [0])[0].onset).toBeNull();
  });
});

/** Two first-order low-passes at `hz`: headphones held to a microphone lose the highs. */
const muffled = (hz: number) => (x: Float32Array) => {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  let y = x;
  for (let k = 0; k < 2; k++) {
    const o = new Float32Array(y.length);
    let p = 0;
    for (let i = 0; i < y.length; i++) o[i] = p += a * (y[i] - p);
    y = o;
  }
  return y;
};

describe('detectClicks on the soft click (what the app plays)', () => {
  const soft = (strong: boolean) => (g: number) =>
    softClickSamples(SR, strong, g);
  /** detected onset - true start of each click (ms); null = missing */
  const bias = (opts: Parameters<typeof scene>[0]) => {
    const { x, expected } = scene(opts);
    return detectClicks(x, SR, expected).map((c, i) =>
      c.delayMs === null ? null : c.delayMs - opts.delaysMs[i]!,
    );
  };
  const D = [40, 40, 40, 40];

  // Without noise ~0.69 ms (16-96 kHz), up to ~4 ms near the detection limit. The take is shifted
  // early by that much, far below the 10 ms target.
  it('finds the onset a constant ~0.7 ms after the start', () => {
    for (const strong of [false, true])
      for (const b of bias({ delaysMs: D, noiseAmp: 0, click: soft(strong) })) {
        expect(b).toBeGreaterThan(0.5);
        expect(b).toBeLessThan(0.8);
      }
  });

  it('keeps the delay under 1.5 ms with noise, a muffled path, DC + hum and clipping', () => {
    const scenes: Parameters<typeof scene>[0][] = [
      { delaysMs: D, gain: 0.1, noiseAmp: 0.03 },
      { delaysMs: D, gain: 0.03, noiseAmp: 0.01, seed: 7 },
      { delaysMs: D, gain: 0.1, path: muffled(2000) },
      {
        delaysMs: D,
        extra: (i) => 0.2 + 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR),
      },
    ];
    for (const sc of scenes)
      for (const b of bias({ ...sc, click: soft(false) })) {
        expect(b).not.toBeNull();
        expect(b!).toBeGreaterThan(0);
        expect(b!).toBeLessThan(1.5);
      }
    const { x, expected } = scene({ delaysMs: D, gain: 6, click: soft(false) });
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
    for (const c of detectClicks(x, SR, expected))
      expect(Math.abs(c.delayMs! - 40)).toBeLessThan(1);
  });

  it('finds every click in white noise down to click = noise amplitude', () => {
    // With the spike's detector (one high-pass only) the sharp click was found 4/4 down to click/noise
    // amplitude 3 and lost at 1; the soft click was already lost at 3.
    for (const [gain, noiseAmp, max] of [
      [0.1, 0.03, 1.5],
      [0.03, 0.01, 1.5],
      [0.03, 0.03, 4], // marginal: later and less steady, still within the spread limit
    ]) {
      const found = bias({ delaysMs: D, gain, noiseAmp, click: soft(false) });
      expect(found.every((b) => b !== null && b > 0 && b < max)).toBe(true);
      const v = found as number[];
      // the spread stays within judgeLatency's limit
      expect(Math.max(...v) - Math.min(...v)).toBeLessThan(MAX_SPREAD_MS);
    }
  });
});

describe('stats', () => {
  it('ignores nulls and computes the sample stdev', () => {
    const s = stats([10, null, 12, 14]);
    expect(s).toEqual({ count: 3, mean: 12, stdev: 2, min: 10, max: 14 });
  });

  it('is null without values and stdev 0 for one', () => {
    expect(stats([null])).toBeNull();
    expect(stats([5])!.stdev).toBe(0);
  });
});

const det = (delays: (number | null)[]): ClickDetection[] =>
  delays.map((d, index) => ({
    index,
    expected: index * 1000,
    onset: d === null ? null : index * 1000 + d,
    delayMs: d,
    peak: 0.5,
    noise: 0.001,
  }));

const reported = { baseLatencySec: 0.01, outputLatencySec: 0.04 }; // 50 ms

describe('judgeLatency', () => {
  it('takes the median round trip minus base + output as the remainder', () => {
    const r = judgeLatency(det([100, 101, 99, 100]), reported);
    expect(r).toEqual({
      ok: true,
      roundTripMs: 100,
      spreadMs: 2,
      remainderMs: 50,
      found: 4,
    });
  });

  it('accepts 3 of 4 clicks, rejects 2 of 4', () => {
    const three = judgeLatency(det([100, null, 102, 101]), reported);
    expect(three.ok && three.found).toBe(3);
    expect(judgeLatency(det([100, null, null, 101]), reported)).toEqual({
      ok: false,
      reason: 'tooFew',
    });
    expect(judgeLatency([], reported)).toEqual({ ok: false, reason: 'tooFew' });
  });

  it('allows a spread of exactly 5 ms and rejects more', () => {
    expect(judgeLatency(det([100, 105, 102, 103]), reported).ok).toBe(true);
    expect(judgeLatency(det([100, 105.1, 102, 103]), reported)).toEqual({
      ok: false,
      reason: 'unstable',
    });
  });

  it('checks the round trip, not the remainder, against 0-300 ms (ends included)', () => {
    expect(judgeLatency(det([0, 0, 0, 0]), reported).ok).toBe(true);
    expect(judgeLatency(det([300, 300, 300, 300]), reported).ok).toBe(true);
    expect(judgeLatency(det([301, 301, 301, 301]), reported)).toEqual({
      ok: false,
      reason: 'outOfRange',
    });
    expect(judgeLatency(det([-1, -1, -1, -1]), reported)).toEqual({
      ok: false,
      reason: 'outOfRange',
    });
  });

  it('keeps a negative remainder (the device over-reports its latency)', () => {
    const r = judgeLatency(det([30, 30, 31, 30]), reported);
    expect(r.ok && r.remainderMs).toBe(-20);
  });

  it('reads missing / invalid reported latencies as 0', () => {
    const r = judgeLatency(det([100, 100, 100, 100]), {
      baseLatencySec: NaN,
      outputLatencySec: -1,
    });
    expect(r.ok && r.remainderMs).toBe(100);
  });
});

describe('compensationSec / compensationFrames', () => {
  it('adds base + output + the remembered remainder', () => {
    expect(compensationSec({ ...reported, remainderMs: 44 })).toBeCloseTo(
      0.094,
      9,
    );
  });

  it('uses 0 for an unmeasured microphone', () => {
    expect(compensationSec({ ...reported, remainderMs: null })).toBeCloseTo(
      0.05,
      9,
    );
  });

  it('takes a negative remainder off, but never goes below 0', () => {
    expect(compensationSec({ ...reported, remainderMs: -20 })).toBeCloseTo(
      0.03,
      9,
    );
    expect(compensationSec({ ...reported, remainderMs: -500 })).toBe(0);
  });

  it('treats an unavailable outputLatency (NaN / 0) as 0', () => {
    expect(
      compensationSec({
        baseLatencySec: 0.01,
        outputLatencySec: NaN,
        remainderMs: 10,
      }),
    ).toBeCloseTo(0.02, 9);
  });

  it('rounds to whole frames', () => {
    expect(compensationFrames(0.094, 48000)).toBe(4512);
    expect(compensationFrames(0.0000104, 48000)).toBe(0);
  });
});
