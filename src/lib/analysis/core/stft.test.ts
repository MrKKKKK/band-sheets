import { describe, expect, it } from 'vitest';
import { signalToErrorDb } from '../../../test/signalError';
import { MemTracker } from './mem';
import { frameCount, hannPeriodic, istft, stft } from './stft';

describe('hannPeriodic', () => {
  it('is the periodic (fftbins=True) window', () => {
    const w = hannPeriodic(4);
    expect(Array.from(w).map((v) => +v.toFixed(12))).toEqual([0, 0.5, 1, 0.5]);
  });
});

describe('stft (n_fft 2048, hop 512, centred, zero padding)', () => {
  it('frame count is 1 + floor(n / hop)', () => {
    expect(frameCount(22050, 512)).toBe(44);
    expect(frameCount(511, 512)).toBe(1);
    expect(frameCount(512, 512)).toBe(2);
  });

  it('a bin-centred sine peaks at its bin with |X| = A N / 4 (neighbours A N / 8)', () => {
    // f = 100 * sr / 2048 -> exactly bin 100. Periodic Hann: sum w = N/2, so a full interior
    // frame of A sin gives |X[100]| = A * (N/2) / 2 = 512 A, and the window's +-1 bin
    // side lobes are half of that.
    const sr = 22050;
    const A = 0.5;
    const n = sr;
    const y = Float32Array.from(
      { length: n },
      (_, i) => A * Math.sin((2 * Math.PI * 100 * i) / 2048),
    );
    const mem = new MemTracker();
    const s = stft(y, { nFft: 2048, hop: 512 }, mem);
    expect(s.frames).toBe(44);
    expect(s.bins).toBe(1025);
    const t = 20; // interior frame
    const mag = (k: number) =>
      Math.hypot(s.re[t * 1025 + k], s.im[t * 1025 + k]);
    let peak = 0;
    for (let k = 1; k < 1025; k++) if (mag(k) > mag(peak)) peak = k;
    expect(peak).toBe(100);
    expect(mag(100)).toBeCloseTo(512 * A, 2);
    expect(mag(99)).toBeCloseTo(256 * A, 2);
    expect(mag(101)).toBeCloseTo(256 * A, 2);
    expect(mag(300)).toBeLessThan(1e-3);
    // memory: re + im float32 [44 x 1025]
    expect(mem.total).toBeGreaterThanOrEqual(2 * 44 * 1025 * 4);
  });

  it('pads with zeros, not reflection (first frame of a constant signal)', () => {
    // y = 1: frame 0 sees y only on the window's second half. DC bin = sum_{i>=1024} w[i]
    // = 512 + 0.5 (with reflect padding it would be 1024).
    const y = new Float32Array(8192).fill(1);
    const s = stft(y);
    expect(s.re[0]).toBeCloseTo(512.5, 3);
    expect(s.re[8 * 1025]).toBeCloseTo(1024, 3); // interior frame: sum w = N/2
  });

  it('istft(stft(y)) reconstructs y (> 100 dB), edges included', () => {
    let s = 3;
    for (const n of [5000, 22050, 22051 + 300]) {
      const y = Float32Array.from({ length: n }, () => {
        s = (s * 48271) % 2147483647;
        return s / 2147483647 - 0.5;
      });
      const back = istft(stft(y), n);
      expect(back.length).toBe(n);
      expect(signalToErrorDb(back, y)).toBeGreaterThan(100);
    }
  });
});
