import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalToErrorDb } from '../../../test/signalError';
import { stubNoNetwork } from '../../../test/noNetwork';
import { hpss, loadFeatures, onsetStrength } from './audio';
import { MemTracker } from '../core/mem';

const SR = 22050;

/** 2 s: a 440 Hz sine plus short clicks every 0.5 s (from 0.25 s). */
function sineAndClicks() {
  const n = 2 * SR;
  const sine = Float32Array.from(
    { length: n },
    (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR),
  );
  const clicks = new Float32Array(n);
  const clickAt = [0.25, 0.75, 1.25, 1.75].map((t) => Math.round(t * SR));
  for (const c of clickAt)
    for (let i = 0; i < 32; i++)
      clicks[c + i] = (i % 2 ? -0.8 : 0.8) * (1 - i / 32);
  const y = Float32Array.from(sine, (v, i) => v + clicks[i]);
  return { y, sine, clicks, clickAt };
}

describe('hpss', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts the sine in y_harm and the clicks in y_perc; y_harm + y_perc ~ y', () => {
    stubNoNetwork();
    const { y, sine, clickAt } = sineAndClicks();
    const mem = new MemTracker();
    const r = hpss(y, mem);
    expect(r.frames).toBe(1 + Math.floor(y.length / 512));
    expect(r.yHarm.length).toBe(y.length);
    expect(signalToErrorDb(r.yHarm, sine)).toBeGreaterThan(10);
    // percussive energy sits at the clicks
    let atClicks = 0;
    let total = 0;
    for (let i = 0; i < y.length; i++) {
      total += r.yPerc[i] ** 2;
      if (clickAt.some((c) => Math.abs(i - c) <= 1024))
        atClicks += r.yPerc[i] ** 2;
    }
    expect(atClicks / total).toBeGreaterThan(0.8);
    const sum = Float32Array.from(r.yHarm, (v, i) => v + r.yPerc[i]);
    expect(signalToErrorDb(sum, y)).toBeGreaterThan(60);
    // memory: no complex STFT is stored. |S| (frames x 1025 f32) + outputs dominate.
    const sBytes = r.frames * 1025 * 4;
    expect(mem.peak).toBeGreaterThan(sBytes + 2 * y.length * 4);
    expect(mem.peak).toBeLessThan(sBytes + 2 * y.length * 4 + 2_000_000);
  });

  it('handles a signal shorter than one hop', () => {
    const r = hpss(new Float32Array(100).fill(0.1));
    expect(r.frames).toBe(1);
    expect(r.yHarm.length).toBe(100);
  });
});

describe('onsetStrength', () => {
  it('has 3 leading zeros, frame-count length and peaks at the clicks', () => {
    const { y, clickAt } = sineAndClicks();
    const env = onsetStrength(y);
    expect(env.length).toBe(1 + Math.floor(y.length / 512));
    expect(Array.from(env.slice(0, 3))).toEqual([0, 0, 0]);
    let max = 0;
    for (const v of env) max = Math.max(max, v);
    for (const c of clickAt) {
      const f = Math.round(c / 512);
      let local = 0;
      for (let t = f - 2; t <= f + 2; t++) local = Math.max(local, env[t]);
      expect(local).toBeGreaterThan(0.5 * max);
    }
  });

  it('is zero for silence (all bands clamp to the same floor)', () => {
    expect(Math.max(...onsetStrength(new Float32Array(4096)))).toBe(0);
  });
});

describe('loadFeatures', () => {
  it('reports memory', () => {
    const { y } = sineAndClicks();
    const f = loadFeatures(y);
    expect(f.duration).toBeCloseTo(2, 9);
    expect(f.mem.peak).toBeGreaterThan(y.length * 4 * 3);
    expect(f.onsetEnv.length).toBe(1 + Math.floor(y.length / 512));
  });
});
