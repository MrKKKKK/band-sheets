import { describe, expect, it } from 'vitest';
import { bandBins, bandFeatures } from './bands';
import { DEFAULT_DRUM_CONFIG } from './config';
import { adaptiveThreshold, detectOnsets, localThreshold, mergePeaks, pickPeaks, quantile, refineOnset, smooth } from './onset';
import { assertNoHeldOut, mergeTimes, selectVariants, type EvalVariant } from './onset_eval';

const SR = 44100;

/** Seeded LCG noise in [-1, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

type Kind = 'low' | 'mid' | 'high';
/** A drum-like hit: decaying sine (low, ~60 Hz), band noise around 1-4 kHz (mid) or high-passed noise (high). */
function addHit(y: Float32Array, at: number, kind: Kind, amp: number, r: () => number) {
  const n = Math.round(0.8 * SR); // long enough to decay below -80 dB: no cut-off click
  let prev = 0;
  let lp = 0;
  for (let i = 0; i < n && at + i < y.length; i++) {
    const env = Math.exp(-i / (SR * (kind === 'low' ? 0.08 : kind === 'mid' ? 0.05 : 0.02)));
    let v: number;
    if (kind === 'low') v = Math.sin((2 * Math.PI * 60 * i) / SR);
    else {
      const w = r();
      if (kind === 'high') {
        v = w - prev; // first difference: high-passed
        prev = w;
      } else {
        lp += 0.3 * (w - lp); // low-passed noise minus its slower part: a mid band
        v = lp - prev;
        prev += 0.05 * (lp - prev);
      }
    }
    y[at + i] += amp * env * v;
  }
}

function render(hits: { t: number; kinds: Kind[]; amp?: number }[], sec = 4, seed = 1) {
  const y = new Float32Array(Math.round(sec * SR));
  const r = rng(seed);
  for (const h of hits) for (const k of h.kinds) addHit(y, Math.round(h.t * SR), k, h.amp ?? 0.5, r);
  return y;
}

describe('bands', () => {
  it('bandBins maps Hz edges to [lo, hi) bins and clips at Nyquist', () => {
    expect(bandBins([0, 1000, 2000], 1024, 1024 * 10)).toEqual([
      [0, 100],
      [100, 200],
    ]);
    expect(bandBins([30, 250, 5000, 16000], 2048, 44100)).toEqual([
      [2, 12],
      [12, 233],
      [233, 744],
    ]);
    expect(bandBins([100, 50000], 1024, 22050)[0][1]).toBe(513);
    expect(() => bandBins([100], 1024, 22050)).toThrow();
    expect(() => bandBins([200, 100], 1024, 22050)).toThrow(/increase/);
  });
  it('a low hit raises the low band flux, a high hit the high band', () => {
    const lowY = render([{ t: 1, kinds: ['low'] }], 2);
    const highY = render([{ t: 1, kinds: ['high'] }], 2);
    const fl = bandFeatures(lowY, SR, DEFAULT_DRUM_CONFIG);
    const fh = bandFeatures(highY, SR, DEFAULT_DRUM_CONFIG);
    const mx = (a: Float32Array) => a.reduce((m, v) => Math.max(m, v), 0);
    expect(mx(fl.flux[0])).toBeGreaterThan(5 * mx(fl.flux[2]));
    expect(mx(fh.flux[2])).toBeGreaterThan(5 * mx(fh.flux[0]));
    expect(fl.frames).toBe(1 + Math.floor(lowY.length / DEFAULT_DRUM_CONFIG.onset.hop));
    expect(() => bandFeatures(lowY, SR, { ...DEFAULT_DRUM_CONFIG, onset: { ...DEFAULT_DRUM_CONFIG.onset, lag: 0 } })).toThrow(/lag/);
  });
});

describe('onset helpers', () => {
  it('quantile interpolates like numpy', () => {
    expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3], 1)).toBe(3);
    expect(quantile([], 0.5)).toBe(0);
  });
  it('adaptiveThreshold = median + n * 1.4826 * MAD, floored by relFloor * p99', () => {
    const f = [0, 1, 2, 3, 4];
    expect(adaptiveThreshold(f, 2, 0)).toBeCloseTo(2 + 2 * 1.4826 * 1, 9);
    expect(adaptiveThreshold([0, 0, 0, 0, 10], 3, 0.5)).toBeCloseTo(0.5 * quantile([0, 0, 0, 0, 10], 0.99), 9);
  });
  it('smooth averages a centred window (edges: the frames that exist)', () => {
    expect([...smooth(Float32Array.from([0, 3, 0, 0]), 3)]).toEqual([1.5, 1, 1, 0]);
    const a = Float32Array.from([1, 2]);
    expect(smooth(a, 1)).toBe(a);
  });
  it('localThreshold = max(global, mult * local mean)', () => {
    expect([...localThreshold([0, 0, 6, 0, 0], 1, 1, 0.5)]).toEqual([0.5, 2, 2, 2, 0.5]);
  });
  it('pickPeaks: local maxima above the threshold, minimum distance keeps the larger', () => {
    const f = [0, 1, 0, 0, 3, 0, 2.5, 0, 0, 0.5, 0];
    expect(pickPeaks(f, 0.6, 1, 0)).toEqual([1, 4, 6]);
    expect(pickPeaks(f, 0.6, 1, 3)).toEqual([1, 4]);
    expect(pickPeaks([0, 2, 2, 0], 1, 1, 0)).toEqual([1]); // plateau: first frame
    expect(pickPeaks(f, Float32Array.from(f.map((_, i) => (i === 4 ? 5 : 0.6))), 1, 0)).toEqual([1, 6]);
  });
  it('mergePeaks groups band peaks near the first peak of a group', () => {
    expect(
      mergePeaks(
        [
          { frame: 10, band: 2 },
          { frame: 11, band: 0 },
          { frame: 12, band: 2 },
          { frame: 14, band: 1 },
          { frame: 30, band: 1 },
        ],
        2,
      ),
    ).toEqual([
      { frame: 10, bands: [0, 2] },
      { frame: 14, bands: [1] },
      { frame: 30, bands: [1] },
    ]);
  });
  it('refineOnset finds the rise to within a millisecond, also under a louder decay', () => {
    const o = { radius: Math.round(0.025 * SR), block: 22, riseBlocks: 4, minRiseDb: 6, relDb: -30, preEmph: Math.exp((-2 * Math.PI * 1500) / SR) };
    const at = Math.round(1.0 * SR);
    const y = render([{ t: 1.0, kinds: ['mid'] }], 2);
    const r = refineOnset(y, at + 300, o);
    expect(r).not.toBeNull();
    expect(Math.abs((r! - at) / SR)).toBeLessThan(0.001);
    // high hit 60 ms after a loud low hit
    const y2 = render(
      [
        { t: 0.94, kinds: ['low'], amp: 0.9 },
        { t: 1.0, kinds: ['high'], amp: 0.2 },
      ],
      2,
    );
    const r2 = refineOnset(y2, at - 200, o);
    expect(Math.abs((r2! - at) / SR)).toBeLessThan(0.002); // the -30 dB point sits above the decay: a little later
    expect(refineOnset(new Float32Array(SR), SR / 2, o)).toBeNull(); // silence: no rise
  });
});

describe('detectOnsets', () => {
  it('finds isolated and simultaneous hits with ms accuracy and reports the bands', () => {
    const hits: { t: number; kinds: Kind[]; amp?: number }[] = [
      { t: 0.5, kinds: ['low'] },
      { t: 0.8, kinds: ['high'], amp: 0.3 },
      { t: 1.1, kinds: ['mid'] },
      { t: 1.4, kinds: ['low', 'high'] },
      { t: 1.7, kinds: ['mid', 'high'] },
      { t: 2.0, kinds: ['high'], amp: 0.05 }, // ghost-level
      { t: 2.3, kinds: ['low', 'mid', 'high'] },
    ];
    const d = detectOnsets(render(hits, 3), SR);
    expect(d.sr).toBe(DEFAULT_DRUM_CONFIG.audio.sr);
    expect(d.onsets.map((o) => o.t)).toHaveLength(hits.length);
    d.onsets.forEach((o, i) => {
      expect(Math.abs(o.t - hits[i].t)).toBeLessThan(0.002);
      expect(o.flux).toHaveLength(3);
      expect(o.energyDb).toHaveLength(3);
    });
    expect(d.onsets[0].bands).toContain(0);
    expect(d.onsets[1].bands).toContain(2);
    expect(d.onsets[3].bands).toEqual(expect.arrayContaining([0, 2]));
    // per-band strength: the low hit has its largest flux in the low band, the high hit in the high band
    const argmax = (a: number[]) => a.indexOf(Math.max(...a));
    expect(argmax(d.onsets[0].flux)).toBe(0);
    expect(argmax(d.onsets[1].flux)).toBe(2);
  });
  it('resamples other input rates (48 kHz) without shifting times', () => {
    const y = render([{ t: 1.0, kinds: ['mid'] }], 2);
    // crude 44.1 -> 48 kHz by linear interpolation is enough for the timing check
    const n = Math.round((y.length * 48000) / SR);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * SR) / 48000;
      const j = Math.floor(x);
      z[i] = j + 1 < y.length ? y[j] + (y[j + 1] - y[j]) * (x - j) : 0;
    }
    const d = detectOnsets(z, 48000);
    expect(d.onsets).toHaveLength(1);
    expect(Math.abs(d.onsets[0].t - 1.0)).toBeLessThan(0.002);
  });
  it('stationary noise alone: only its start and at most one spurious onset', () => {
    const r = rng(7);
    const y = Float32Array.from({ length: 3 * SR }, () => 0.01 * r());
    const d = detectOnsets(y, SR);
    expect(d.onsets[0].t).toBeLessThan(0.05); // the noise starts at sample 0
    expect(d.onsets.length).toBeLessThanOrEqual(2);
  });
});

describe('onset_eval', () => {
  const v = (name: string, split: string, heldOut: boolean): EvalVariant => ({ name, split, heldOut, level: 'D0', kit: 'A', ext: false, wav: `${name}.wav`, truth: `${name}.truth.json`, audioSec: 1 });
  it('mergeTimes keeps the first time of each group', () => {
    expect(mergeTimes([1.02, 1, 1.5, 1.025, 1.04], 0.03)).toEqual([1, 1.04, 1.5]);
  });
  it('never selects held-out variants and refuses a held-out request', () => {
    const all = [v('a', 'tuning', false), v('b', 'dev', false), v('c', 'heldOut', true), v('d', 'dev', true)];
    expect(selectVariants(all, ['tuning', 'dev']).map((x) => x.name)).toEqual(['a', 'b']);
    expect(selectVariants(all, ['tuning', 'dev'], 'c')).toEqual([]);
    expect(() => selectVariants(all, ['heldOut'])).toThrow(/held-out/);
    expect(() => assertNoHeldOut([v('c', 'heldOut', false)])).toThrow(/held-out/);
    expect(() => assertNoHeldOut([v('d', 'dev', true)])).toThrow(/held-out/);
  });
});
