import { describe, expect, it } from 'vitest';
import { chromaFilterBank, novelty, peaks, tempoEventTimes } from './tempo';

describe('chromaFilterBank', () => {
  it('has the librosa shape and C-based rows', () => {
    const fb = chromaFilterBank(22050, 4096);
    expect(fb.length).toBe(12 * 2049);
    // 261.63 Hz (C4) bin 49 (5.38 Hz/bin): the C row must dominate there
    const k = Math.round(261.63 / (22050 / 4096));
    let best = 0;
    for (let c = 1; c < 12; c++)
      if (fb[c * 2049 + k] > fb[best * 2049 + k]) best = c;
    expect(best).toBe(0);
    for (const v of fb) expect(Number.isFinite(v) && v >= 0).toBe(true);
  });
});

describe('peaks / novelty', () => {
  it('peaks follows localmax (never index 0) and the relative threshold', () => {
    expect(peaks([3, 1, 2, 2, 1, 5], 0.3, false)).toEqual([2, 5]);
    expect(peaks([3, 1, 2, 2, 1, 5], 0.5, false)).toEqual([5]);
    expect(peaks([0, 0, 0], 0.3, false)).toEqual([]);
  });
  it('novelty is 0 for constant chroma and positive at a change', () => {
    const n = 8;
    const ch = new Float32Array(n * 12);
    for (let t = 0; t < n; t++) ch[t * 12 + (t < 4 ? 0 : 5)] = 1;
    const nov = novelty(ch, n);
    expect(nov[1]).toBeCloseTo(0, 12);
    expect(nov[4]).toBeGreaterThan(0.1);
  });
});

describe('tempoEventTimes', () => {
  it('returns onset peaks only for an empty yHarm and is sorted and spaced', () => {
    const env = new Float32Array([0, 1, 0, 0, 2, 0, 3, 0]);
    const t = tempoEventTimes({ onsetEnv: env, yHarm: new Float32Array(0) });
    expect(Array.from(t, (v) => Math.round((v * 22050) / 512))).toEqual([
      1, 4, 6,
    ]);
  });
  it('finds a chord change in a synthetic tone sequence', () => {
    const sr = 22050;
    const y = new Float32Array(sr * 2);
    for (let i = 0; i < y.length; i++) {
      const f = i < sr ? 261.63 : 392.0;
      y[i] = 0.3 * Math.sin((2 * Math.PI * f * i) / sr);
    }
    const t = tempoEventTimes({ onsetEnv: new Float32Array(87), yHarm: y });
    expect(t.length).toBeGreaterThan(0);
    expect(t.some((v) => Math.abs(v - 1.0) < 0.15)).toBe(true);
  });
});
