import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG, resolveHumConfig } from './config';
import { DEFAULT_OCTAVE_CHECK, differenceDirect, estimateF0, NO_OCTAVE_CHECK, octaveCheck, parabolicLag, voicingDecision, yinGeometry, YinFrameAnalyzer, yinPick, yinProb } from './f0';

const SR = 22050;
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function tone(hz: number, sec: number, sr: number, kind: 'sine' | 'saw', amp = 0.5): Float32Array {
  const n = Math.round(sec * sr);
  const y = new Float32Array(n);
  const nh = kind === 'sine' ? 1 : Math.floor(sr / 2 / hz);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= nh; h++) s += Math.sin(2 * Math.PI * h * hz * (i / sr)) / h;
    y[i] = amp * (kind === 'sine' ? s : (2 / Math.PI) * s);
  }
  return y;
}

/** Median cents error of the voiced frames away from the edges. */
function centsError(hz: number[], voiced: number[], f: number): { median: number; max: number; voicedShare: number } {
  const errs: number[] = [];
  const lo = 8;
  const hi = hz.length - 8;
  let v = 0;
  for (let i = lo; i < hi; i++) {
    if (voiced[i]) v++;
    if (voiced[i] && hz[i] > 0) errs.push(1200 * Math.log2(hz[i] / f));
  }
  errs.sort((a, b) => a - b);
  return { median: errs[Math.floor(errs.length / 2)] ?? NaN, max: Math.max(...errs.map(Math.abs)), voicedShare: v / (hi - lo) };
}

describe('YIN difference function', () => {
  it('the FFT difference equals the direct definition', () => {
    const g = yinGeometry();
    const an = new YinFrameAnalyzer(g);
    const y = tone(197.3, 0.2, SR, 'saw');
    for (let k = 0; k < y.length; k++) y[k] += 0.05 * Math.sin(k * 0.37) * Math.cos(k * 0.011);
    const centre = 2000;
    an.analyze(y, centre);
    const frame = Array.from({ length: g.win }, (_, j) => y[centre - g.win / 2 + j]);
    const d = differenceDirect(frame, g.w, g.tauMax + 1);
    let maxD = 0;
    for (let t = 0; t <= g.tauMax + 1; t++) maxD = Math.max(maxD, d[t]);
    for (let t = 0; t <= g.tauMax + 1; t++) expect(Math.abs(an.diff[t] - d[t])).toBeLessThan(1e-9 * maxD);
    // CMND: d'(0) = 1, and the definition
    expect(an.cmnd[0]).toBe(1);
    let cum = 0;
    for (let t = 1; t <= g.tauMax + 1; t++) {
      cum += d[t];
      expect(an.cmnd[t]).toBeCloseTo((d[t] * t) / cum, 9);
    }
  });

  it('corrAt at an integer lag equals d via the energies; refineLag finds a fractional period', () => {
    const g = yinGeometry();
    const an = new YinFrameAnalyzer(g);
    const f = 22050 / 37.3;
    const y = tone(f, 0.2, SR, 'saw');
    an.analyze(y, 2000);
    for (const t of [21, 37, 100, 300]) {
      const d = an.energy[0] + an.energy[t] - 2 * an.corrAt(t)[0];
      expect(Math.abs(d - an.diff[t])).toBeLessThan(1e-9 * an.energy[0]);
    }
    // derivative check by finite differences
    const [, r1, r2] = an.corrAt(37.2);
    const h = 1e-4;
    expect(r1).toBeCloseTo((an.corrAt(37.2 + h)[0] - an.corrAt(37.2 - h)[0]) / (2 * h), 4);
    expect(r2).toBeCloseTo((an.corrAt(37.2 + h)[1] - an.corrAt(37.2 - h)[1]) / (2 * h), 2);
    expect(an.refineLag(37)).toBeCloseTo(37.3, 2);
    expect(an.refinedDepth(37)).toBeLessThanOrEqual(an.cmnd[37]);
  });

  it('geometry: 22050 Hz, 65..1050 Hz -> lags 21..340, integration window 683', () => {
    const g = yinGeometry();
    expect([g.tauMin, g.tauMax, g.w]).toEqual([21, 340, 683]);
  });

  it('yinPick takes the first dip below the threshold, not the global minimum (no octave-down)', () => {
    const dp = new Float64Array(60).fill(0.9);
    dp[19] = 0.2;
    dp[20] = 0.1;
    dp[21] = 0.12;
    dp[39] = 0.06;
    dp[40] = 0.02;
    dp[41] = 0.05;
    const pk = yinPick(dp, 5, 55, 0.15);
    expect(pk.below).toBe(true);
    expect(Math.round(pk.lag)).toBe(20);
    expect(pk.lag).toBeCloseTo(parabolicLag(dp, 20), 12);
    // none below: global minimum, not below
    const pk2 = yinPick(dp, 5, 55, 0.01);
    expect(pk2.below).toBe(false);
    expect(Math.round(pk2.lag)).toBe(40);
  });

  it('yinProb maps the threshold to 0.5', () => {
    expect(yinProb(0, 0.15)).toBe(1);
    expect(yinProb(0.15, 0.15)).toBeCloseTo(0.5, 12);
    expect(yinProb(0.4, 0.15)).toBe(0);
  });
});

describe('estimateF0 on sine and sawtooth C2..C6 (+-5 cents)', () => {
  const notes = Array.from({ length: 49 }, (_, i) => 36 + i); // every semitone C2 .. C6
  for (const mode of ['yin', 'pyin'] as const) {
    const cfg = resolveHumConfig({ f0: { pyin: mode === 'pyin' } });
    for (const kind of ['sine', 'saw'] as const) {
      it(`${mode} ${kind}`, () => {
        for (const m of notes) {
          const f = midiHz(m);
          const r = estimateF0(tone(f, 0.5, SR, kind), SR, cfg);
          const e = centsError(r.track.hz, r.track.voiced, f);
          expect(e.voicedShare, `${mode} ${kind} midi ${m}`).toBeGreaterThan(0.95);
          expect(e.max, `${mode} ${kind} midi ${m}`).toBeLessThan(5);
        }
      });
    }
  }
});

describe('estimateF0 input handling and voicing', () => {
  it('resamples 44.1 kHz input; frame count floor(len / hop) + 1 at 22050', () => {
    const f = midiHz(57);
    const y = tone(f, 0.6, 44100, 'saw');
    const r = estimateF0(y, 44100);
    expect(r.track.hz.length).toBe(Math.floor(Math.ceil(y.length / 2) / 256) + 1);
    expect(r.track.hopSec).toBeCloseTo(256 / 22050, 12);
    expect(r.track.t0).toBe(0);
    const e = centsError(r.track.hz, r.track.voiced, f);
    expect(e.max).toBeLessThan(5);
  });

  it('silence and white noise are unvoiced; a tone after silence is voiced', () => {
    const n = SR;
    const y = new Float32Array(2 * n);
    let s = 12345;
    for (let i = 0; i < n / 2; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      y[n / 2 + i] = 0.3 * (s / 2 ** 32 - 0.5);
    }
    y.set(tone(220, 1, SR, 'saw'), n);
    for (const pyin of [false, true]) {
      const r = estimateF0(y, SR, resolveHumConfig({ f0: { pyin } }));
      const fr = (sec: number) => Math.round(sec / r.track.hopSec);
      const share = (a: number, b: number) => r.track.voiced.slice(fr(a), fr(b)).reduce((x, v) => x + v, 0) / (fr(b) - fr(a));
      expect(share(0.05, 0.45), `pyin ${pyin} silence`).toBe(0);
      expect(share(0.55, 0.95), `pyin ${pyin} noise`).toBeLessThan(0.05);
      expect(share(1.1, 1.9), `pyin ${pyin} tone`).toBeGreaterThan(0.98);
    }
  });

  it('voicingDecision: level gate against the noise floor and gap bridging', () => {
    const cfg = DEFAULT_HUM_CONFIG;
    const hz = new Array(20).fill(200);
    const level = new Array(20).fill(-20);
    for (let i = 0; i < 6; i++) level[i] = -60; // noise floor -60
    level[6] = -55; // only 5 dB above the floor: gated
    const cand = new Array(20).fill(true);
    cand[10] = false; // one-frame gap: bridged
    cand[11] = false;
    cand[15] = cand[16] = cand[17] = false; // 3-frame gap (35 ms > 30 ms): kept
    const { voiced, noiseFloorDb } = voicingDecision(cand, hz, level, cfg);
    expect(noiseFloorDb).toBeCloseTo(-60, 9);
    expect(voiced.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(voiced.slice(7, 15)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(voiced.slice(15, 18)).toEqual([0, 0, 0]);
    // a gap whose pitch jumps is not bridged
    const hz2 = hz.slice();
    hz2[12] = 300;
    expect(voicingDecision(cand, hz2, level, cfg).voiced.slice(10, 12)).toEqual([0, 0]);
  });
});

describe('sub-octave check (weak fundamental)', () => {
  it('octaveCheck moves to the much deeper dip near 2 tau only', () => {
    const dp = new Float64Array(120).fill(0.9);
    dp[40] = 0.08;
    dp[81] = 0.01;
    expect(octaveCheck(dp, 40, 118, DEFAULT_OCTAVE_CHECK)).toBe(81);
    dp[81] = 0.06; // ratio .75: a real tau-periodic signal
    expect(octaveCheck(dp, 40, 118, DEFAULT_OCTAVE_CHECK)).toBe(40);
    expect(octaveCheck(dp, 40, 118, NO_OCTAVE_CHECK)).toBe(40);
    dp[40] = 0.01; // below minD: unchanged
    dp[81] = 0.001;
    expect(octaveCheck(dp, 40, 118, DEFAULT_OCTAVE_CHECK)).toBe(40);
    expect(octaveCheck(dp, 60, 118, DEFAULT_OCTAVE_CHECK)).toBe(60); // 2 tau out of range
  });

  it('a 130 Hz voice with the fundamental at -25 dB and strong even harmonics is read at 130 Hz, not 260 Hz', () => {
    const f = 130;
    const n = Math.round(0.6 * SR);
    const y = new Float32Array(n);
    const amps = [Math.pow(10, -25 / 20), 1, 0.15, 0.8, 0.1, 0.5, 0.05, 0.3];
    for (let i = 0; i < n; i++) for (let h = 0; h < amps.length; h++) y[i] += 0.1 * amps[h] * Math.sin(2 * Math.PI * (h + 1) * f * (i / SR) + h);
    for (const pyin of [false, true]) {
      const cfg = resolveHumConfig({ f0: { pyin } });
      const on = centsError(estimateF0(y, SR, cfg).track.hz, estimateF0(y, SR, cfg).track.voiced, f);
      expect(Math.abs(on.median), `pyin ${pyin}`).toBeLessThan(5);
      const off = estimateF0(y, SR, cfg, NO_OCTAVE_CHECK);
      expect(Math.abs(centsError(off.track.hz, off.track.voiced, f).median - 1200), `pyin ${pyin} without the check`).toBeLessThan(5);
    }
  });
});
