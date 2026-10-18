import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG, resolveHumConfig } from './config';
import { betaCdf, binHz, binPos, pitchBins, pyinDecode, pyinWeights, type PyinFrame } from './pyin';
import { pyinFrameFrom, yinGeometry, PYIN_PA } from './f0';

describe('pYIN prior', () => {
  it('Beta(2, 18) CDF matches the closed form 1 - (1 - x)^18 (1 + 18 x)', () => {
    for (const x of [0.01, 0.05, 0.1, 0.2, 0.5]) expect(betaCdf(x)).toBeCloseTo(1 - Math.pow(1 - x, 18) * (1 + 18 * x), 8);
  });
  it('threshold weights sum to 1 and peak near the Beta mode', () => {
    const w = pyinWeights(DEFAULT_HUM_CONFIG.f0.pyinThresholds);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(w.every((x) => x > 0)).toBe(true);
    expect(() => pyinWeights([0.2, 0.1])).toThrow();
  });
});

describe('pYIN frame candidates', () => {
  it('thresholds that find no dip give the global minimum with mass * PA', () => {
    const g = yinGeometry();
    const dp = new Float64Array(g.tauMax + 2).fill(0.9);
    // dip of 0.12 at lag 50 (found by thresholds .15, .2, .3), deeper 0.08 at lag 100 (found by .1 only after 50 fails)
    dp[49] = 0.3;
    dp[50] = 0.12;
    dp[51] = 0.3;
    dp[99] = 0.2;
    dp[100] = 0.08;
    dp[101] = 0.2;
    const th = [0.05, 0.1, 0.15, 0.2, 0.3];
    const w = pyinWeights(th);
    const f = pyinFrameFrom(dp, g, th, w);
    const at = (lag: number) => f.p[f.hz.findIndex((h) => Math.abs(g.sr / h - lag) < 0.5)];
    expect(at(50)).toBeCloseTo(w[2] + w[3] + w[4], 12);
    expect(at(100)).toBeCloseTo(w[1] + w[0] * PYIN_PA, 12);
  });
});

describe('pitch HMM Viterbi', () => {
  const cfg = DEFAULT_HUM_CONFIG;
  const bins = pitchBins(cfg);
  it('bins: 20 cents from fmin', () => {
    expect(bins.count).toBe(Math.floor(12 * Math.log2(1050 / 65) * 5) + 1);
    expect(binPos(bins, binHz(bins, 37))).toBeCloseTo(37, 9);
  });

  it('follows the smooth candidate and ignores a one-frame octave candidate with higher mass', () => {
    const frames: PyinFrame[] = [];
    for (let t = 0; t < 40; t++) {
      if (t === 20) frames.push({ hz: [440, 220], p: [0.6, 0.35] });
      else frames.push({ hz: [220 * Math.pow(2, (t * 2) / 1200)], p: [0.95] });
    }
    const d = pyinDecode(frames, cfg);
    expect(d.voiced.every((v) => v)).toBe(true);
    expect(d.hz[20]).toBe(220);
    expect(d.hz[30]).toBeCloseTo(220 * Math.pow(2, 60 / 1200), 9); // exact candidate Hz, not the bin centre
  });

  it('low Pv frames decode as unvoiced; silence (no candidates) is unvoiced with hz 0', () => {
    const frames: PyinFrame[] = [];
    for (let t = 0; t < 30; t++) frames.push({ hz: [300], p: [0.97] });
    for (let t = 0; t < 30; t++) frames.push({ hz: [300], p: [0.004] });
    for (let t = 0; t < 10; t++) frames.push({ hz: [], p: [] });
    const d = pyinDecode(frames, cfg);
    expect(d.voiced.slice(0, 29).every((v) => v)).toBe(true);
    expect(d.voiced.slice(31, 60).some((v) => v)).toBe(false);
    expect(d.hz.slice(60)).toEqual(new Array(10).fill(0));
    expect(d.prob[0]).toBeCloseTo(0.97, 12);
  });

  it('a wider maxJump lets the path jump further per frame', () => {
    const frames: PyinFrame[] = [];
    for (let t = 0; t < 20; t++) frames.push({ hz: [200], p: [0.98] });
    for (let t = 0; t < 20; t++) frames.push({ hz: [200 * Math.pow(2, 4 / 12)], p: [0.98] }); // +4 semitones, no glide
    const narrow = pyinDecode(frames, cfg);
    const wide = pyinDecode(frames, resolveHumConfig({ f0: { maxJumpSemitones: 5 } }));
    expect(wide.voiced.every((v) => v)).toBe(true);
    expect(narrow.voiced.filter((v) => !v).length).toBeGreaterThan(0); // has to pass through unvoiced states
  });
});
