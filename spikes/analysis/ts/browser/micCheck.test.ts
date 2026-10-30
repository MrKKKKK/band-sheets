import { describe, expect, it } from 'vitest';
import { assembleBlocks, clickSamples, detectClicks, stats } from './micCheck';

const SR = 48000;

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
function scene(opts: { delaysMs: (number | null)[]; noiseAmp?: number; gain?: number; extra?: (i: number) => number }) {
  const n = SR * 5;
  const x = noise(n, opts.noiseAmp ?? 0.002);
  const click = clickSamples(SR, opts.gain ?? 0.5);
  const expected: number[] = [];
  opts.delaysMs.forEach((d, k) => {
    const exp = Math.round(SR * (0.5 + k * 0.5));
    expected.push(exp);
    if (d === null) return;
    const at = exp + Math.round((d / 1000) * SR);
    for (let i = 0; i < click.length; i++) x[at + i] += click[i];
  });
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
    for (const c of detectClicks(x, SR, expected)) expect(Math.abs(c.delayMs! - 25)).toBeLessThan(0.1);
  });

  it('handles clipped clicks', () => {
    const { x, expected } = scene({ delaysMs: [80, 80], gain: 3 });
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
    for (const c of detectClicks(x, SR, expected)) expect(Math.abs(c.delayMs! - 80)).toBeLessThan(0.1);
  });

  it('finds quiet clicks in moderate noise', () => {
    const { x, expected } = scene({ delaysMs: [50, 50, 50], noiseAmp: 0.01, gain: 0.15 });
    for (const c of detectClicks(x, SR, expected)) expect(Math.abs(c.delayMs! - 50)).toBeLessThan(0.3);
  });

  it('reports missing for silence, a steady tone, out-of-range times and NaN, without throwing', () => {
    const silent = new Float32Array(SR);
    expect(detectClicks(silent, SR, [1000])[0].onset).toBeNull();
    const tone = Float32Array.from({ length: SR * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR));
    expect(detectClicks(tone, SR, [SR * 0.5])[0].onset).toBeNull();
    expect(detectClicks(silent, SR, [-SR, SR * 10, NaN]).every((c) => c.onset === null)).toBe(true);
    const nan = new Float32Array(SR).fill(NaN);
    expect(detectClicks(nan, SR, [1000])[0].onset).toBeNull();
    expect(detectClicks(new Float32Array(0), SR, [0])[0].onset).toBeNull();
  });
});

describe('assembleBlocks', () => {
  it('places blocks on the frame axis, out of order, and counts gaps', () => {
    const b = (frame: number, v: number) => ({ frame, data: new Float32Array(4).fill(v) });
    const r = assembleBlocks([b(108, 2), b(100, 1)]);
    expect(r.startFrame).toBe(100);
    expect(Array.from(r.samples)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2]);
    expect(r.gapFrames).toBe(4);
  });

  it('returns an empty recording for no blocks', () => {
    expect(assembleBlocks([]).samples.length).toBe(0);
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
