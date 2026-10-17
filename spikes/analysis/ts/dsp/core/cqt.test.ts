import { describe, expect, it } from 'vitest';
import {
  cqtFrequencies,
  cqtMagnitude,
  cqtPlan,
  earlyDownsampleCount,
  estimateTuning,
  kernelBank,
  pitchTuning,
  relativeBandwidth,
  waveletLengths,
} from './cqt';

const SR = 22050;
const sine = (f: number, n: number, amp = 1) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));

describe('CQT parameters (librosa notes section 7 table)', () => {
  it('frequencies: fmin * 2^(j/36), tuning in fractions of a bin', () => {
    const f = cqtFrequencies(216, 32.7, 36);
    expect(f[0]).toBe(32.7);
    expect(f[36]).toBeCloseTo(65.4, 12);
    expect(f[215]).toBeCloseTo(2052.9, 1);
    const t = cqtFrequencies(216, 32.7, 36, 0.5);
    expect(t[0] / f[0]).toBeCloseTo(2 ** (0.5 / 36), 14);
  });

  it('relative bandwidth is (2^(2/36) - 1) / (2^(2/36) + 1) for equal spacing', () => {
    const a = relativeBandwidth(cqtFrequencies(216, 32.7, 36));
    for (const x of a) expect(x).toBeCloseTo(0.0192517, 6);
  });

  it('early downsample: full 2:1 once, bass 16:1 once; hop / sr per octave', () => {
    const full = cqtPlan(100000, { sr: SR, hop: 512, fmin: 32.7, nBins: 216, bpo: 36, tuning: 0 });
    expect(full.early).toBe(1);
    expect(full.sr).toBe(11025);
    expect(full.octaves.map((o) => o.hop)).toEqual([256, 128, 64, 32, 16, 8]);
    expect(full.octaves[5].sr).toBeCloseTo(344.53125, 9);
    expect(full.cols).toBe(1 + Math.floor(100000 / 512));
    const bass = cqtPlan(100000, { sr: SR, hop: 512, fmin: 32.7, nBins: 108, bpo: 36, tuning: 0 });
    expect(bass.early).toBe(4);
    expect(bass.sr).toBe(1378.125);
    expect(bass.octaves.map((o) => o.hop)).toEqual([32, 16, 8]);
    expect(bass.cols).toBe(full.cols);
    expect(earlyDownsampleCount(11025, 2082.5, 512, 6)).toBe(1);
    expect(earlyDownsampleCount(11025, 260.3, 512, 3)).toBe(4);
  });

  it('cutoff of the full CQT ~2082.5 Hz, bass ~260.3 Hz', () => {
    const f = cqtFrequencies(216, 32.7, 36);
    expect(waveletLengths(f, SR, relativeBandwidth(f)).cutoff).toBeCloseTo(2082.5, 0);
    const b = cqtFrequencies(108, 32.7, 36);
    expect(waveletLengths(b, SR, relativeBandwidth(b)).cutoff).toBeCloseTo(260.3, 0);
  });

  it('kernel bank: n_fft 1024, ~16.5 coefficients per filter, peak at f / sr * n_fft', () => {
    const f = cqtFrequencies(216, 32.7, 36);
    const a = relativeBandwidth(f);
    const sr = 11025;
    const bank = kernelBank(f.subarray(180, 216), a.subarray(180, 216), sr, sr);
    expect(bank.nFft).toBe(1024);
    let total = 0;
    for (let b = 0; b < 36; b++) {
      const row = bank.rows[b];
      total += row.idx.length;
      let best = 0;
      for (let m = 1; m < row.idx.length; m++) {
        if (Math.hypot(row.re[m], row.im[m]) > Math.hypot(row.re[best], row.im[best])) best = m;
      }
      expect(Math.abs(row.idx[best] - (f[180 + b] / sr) * 1024)).toBeLessThanOrEqual(1);
    }
    expect(total / 36).toBeGreaterThan(14);
    expect(total / 36).toBeLessThan(19);
  });
});

describe('cqtMagnitude', () => {
  it('a 440 Hz sine peaks at bin 36 log2(440 / 32.7) ~ 135 in the full and its octave in the bass CQT', () => {
    const y = sine(440, SR * 3);
    const { mag, cols } = cqtMagnitude(y, { sr: SR, hop: 512, fmin: 32.7, nBins: 216, bpo: 36, tuning: 0 });
    const t = Math.floor(cols / 2);
    let best = 0;
    for (let b = 1; b < 216; b++) if (mag[b * cols + t] > mag[best * cols + t]) best = b;
    expect(best).toBe(Math.round(36 * Math.log2(440 / 32.7)));
    const low = sine(110, SR * 3);
    const bass = cqtMagnitude(low, { sr: SR, hop: 512, fmin: 32.7, nBins: 108, bpo: 36, tuning: 0 });
    let bb = 0;
    for (let b = 1; b < 108; b++) if (bass.mag[b * bass.cols + t] > bass.mag[bb * bass.cols + t]) bb = b;
    expect(bb).toBe(Math.round(36 * Math.log2(110 / 32.7)));
  });
});

describe('tuning', () => {
  it('pitchTuning: empty -> 0; histogram peak left edge in 1/36 octave', () => {
    expect(pitchTuning([])).toBe(0);
    expect(pitchTuning([0, -1])).toBe(0);
    const shifted = [440, 523.25, 659.26].map((f) => f * 2 ** (0.105 / 36));
    expect(pitchTuning(shifted, 0.01, 36)).toBeCloseTo(0.1, 9);
  });

  it('estimateTuning of unit sines equals librosa (values from out/t6/sine_ref.py)', () => {
    const cases: [number, number][] = [
      [65.40639132514966, 0.0],
      [261.6255653005986, -0.12],
      [523.2511306011972, 0.040000000000000036],
      [329.6275569128699, 0.07000000000000006],
      [783.9908719634985, 0.020000000000000018],
    ];
    for (const [f, t] of cases) expect(estimateTuning(sine(f, SR * 5))).toBe(t);
  });
});
