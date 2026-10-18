import { describe, expect, it } from 'vitest';
import { DEFAULT_CHORDS_CONFIG, estimateChords } from './chords';
import { MemTracker } from '../core/mem';
import {
  colKeys,
  estimateChordsPass2,
  NQ,
  normalizeRows,
  QUALITIES,
  TheoryPrior,
  tierMatrix,
} from './harmony';
import type { BarKey } from './keytrack';
import * as vocab from './vocab';

const cfg = DEFAULT_CHORDS_CONFIG;
const states = vocab.states(cfg);
const S = states.length;
const N = 12 * NQ;
const qi = (q: string) => (QUALITIES as readonly string[]).indexOf(q);
const tier = (T: Float64Array, a: [number, string], b: [number, string]) =>
  T[(a[0] * NQ + qi(a[1])) * N + b[0] * NQ + qi(b[1])];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Straightforward dense harmony.transition (the reference the lazy rows must equal bit for bit). */
function denseTransition(
  barKeys: BarKey[],
  barOfBeat: number[],
  strength = 1,
): Float64Array {
  const k = S;
  const n = barOfBeat.length;
  const out = new Float64Array(n * k * k);
  if (strength <= 0 || barKeys.length === 0 || n < 2) return out;
  const keys = colKeys(barKeys, barOfBeat);
  const tiers = (key: BarKey) => {
    const T = tierMatrix(key.mode);
    const b = new Float64Array(k * k);
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        const a = (((states[i].root - key.tonic) % 12) + 12) % 12;
        const c = (((states[j].root - key.tonic) % 12) + 12) % 12;
        b[i * k + j] =
          T[
            (a * NQ + qi(states[i].quality)) * N +
              c * NQ +
              qi(states[j].quality)
          ];
      }
    }
    return b;
  };
  for (let t = 1; t < n; t++) {
    const cur = keys[t];
    const prev = keys[t - 1];
    const same = cur.tonic % 12 === prev.tonic % 12 && cur.mode === prev.mode;
    const f = strength * Math.max(cur.confidence, 0);
    const tc = tiers(cur);
    const b = tc.map((v) => f * v);
    if (!same) {
      const fp = strength * Math.max(prev.confidence, 0);
      const tp = tiers(prev);
      for (let i = 0; i < b.length; i++) b[i] = Math.max(b[i], fp * tp[i]);
    }
    if (b.some((v) => v !== 0)) normalizeRows(b, k);
    out.set(b, t * k * k);
  }
  return out;
}

function randomChroma(n: number, seed: number): Float64Array {
  const r = rng(seed);
  const c = new Float64Array(12 * n);
  // a few chord templates held for a while + noise, so Viterbi has real decisions to make
  let root = 0;
  for (let t = 0; t < n; t++) {
    if (t % 8 === 0) root = Math.floor(r() * 12);
    const third = r() < 0.5 ? 3 : 4;
    for (let p = 0; p < 12; p++) c[p * n + t] = 0.05 * r();
    for (const iv of [0, third, 7])
      c[((root + iv) % 12) * n + t] += 0.3 + 0.2 * r();
    if (r() < 0.3) c[((root + 10) % 12) * n + t] += 0.25;
  }
  return c;
}

function randomKeys(nBars: number, seed: number): BarKey[] {
  const r = rng(seed);
  const out: BarKey[] = [];
  let tonic = 0;
  let mode: 'major' | 'minor' = 'major';
  for (let b = 0; b < nBars; b++) {
    if (r() < 0.15) {
      tonic = Math.floor(r() * 12);
      mode = r() < 0.5 ? 'major' : 'minor';
    }
    out.push({
      bar: b,
      tonic,
      mode,
      confidence: r() < 0.1 ? 0 : 0.5 + 0.5 * r(),
    });
  }
  return out;
}

const barsOf = (nb: number, phase: number, bpb = 4) =>
  Array.from({ length: nb }, (_, i) => Math.floor((i - phase) / bpb));

describe('tierMatrix', () => {
  it('has the table rules (major: V7 -> I strong, IV -> I medium, ii -> V strong; minor: V7 -> i)', () => {
    const T = tierMatrix('major');
    expect(tier(T, [7, '7'], [0, 'maj'])).toBe(1.0);
    expect(tier(T, [5, 'maj'], [0, 'maj'])).toBe(0.6);
    expect(tier(T, [2, 'min'], [7, '7'])).toBe(1.0);
    expect(tier(T, [2, '7'], [7, 'maj'])).toBe(0.6); // secondary dominant V/V -> V
    expect(tier(T, [1, '7'], [0, 'maj'])).toBe(0.6); // tritone substitute
    expect(tier(T, [7, 'sus4'], [7, '7'])).toBeGreaterThanOrEqual(0.6); // sus4 resolution
    const m = tierMatrix('minor');
    expect(tier(m, [7, '7'], [0, 'min'])).toBe(1.0);
  });
  it('has a zero diagonal and power rows = max(maj, min)', () => {
    for (const mode of ['major', 'minor'] as const) {
      const T = tierMatrix(mode);
      for (let i = 0; i < N; i++) expect(T[i * N + i]).toBe(0);
      for (let d = 0; d < 12; d++) {
        const p = d * NQ + qi('5');
        for (let j = 0; j < N; j++) {
          if (j === p) continue;
          const want = Math.max(
            T[(d * NQ + qi('maj')) * N + j],
            T[(d * NQ + qi('min')) * N + j],
          );
          // the column pass can raise entries in power columns further, so only check non-power columns
          if (j % NQ !== qi('5')) expect(T[p * N + j]).toBe(want);
        }
      }
    }
  });
});

describe('normalizeRows', () => {
  it('keeps sum_{j != i} exp(b[i, j]) = k - 1 and a zero diagonal', () => {
    const k = 5;
    const r = rng(1);
    const b = Float64Array.from({ length: k * k }, () => r());
    normalizeRows(b, k);
    for (let i = 0; i < k; i++) {
      let s = 0;
      for (let j = 0; j < k; j++) if (j !== i) s += Math.exp(b[i * k + j]);
      expect(b[i * k + i]).toBe(0);
      expect(s).toBeCloseTo(k - 1, 12);
    }
  });
});

describe('colKeys', () => {
  it('pickup -> first bar, missing bar -> nearest earlier, past the end -> last', () => {
    const ks: BarKey[] = [
      { bar: 0, tonic: 0, mode: 'major', confidence: 1 },
      { bar: 2, tonic: 7, mode: 'major', confidence: 1 },
    ];
    expect(colKeys(ks, [-1, 0, 1, 2, 3, 9]).map((k) => k.bar)).toEqual([
      0, 0, 0, 2, 2, 2,
    ]);
  });
});

describe('TheoryPrior', () => {
  it('rows equal the dense transition bit for bit (key changes, conf 0, pickup)', () => {
    const nb = 90;
    const boc = barsOf(nb, 3);
    const keys = randomKeys(23, 7);
    const dense = denseTransition(keys, boc);
    const p = new TheoryPrior(states, keys, boc);
    for (let t = 0; t < nb; t++) {
      const row = p.row(t);
      for (let i = 0; i < S * S; i++)
        if (row[i] !== dense[t * S * S + i]) throw new Error(`t=${t} i=${i}`);
    }
    expect(p.rows).toBe(nb);
  });
  it('is all zero with strength 0, no keys, one beat, or zero confidences', () => {
    const boc = barsOf(16, 0);
    const keys = randomKeys(4, 3);
    expect(new TheoryPrior(states, keys, boc, 0).isZero()).toBe(true);
    expect(new TheoryPrior(states, [], boc).isZero()).toBe(true);
    expect(new TheoryPrior(states, keys, [0]).isZero()).toBe(true);
    expect(
      new TheoryPrior(
        states,
        keys.map((k) => ({ ...k, confidence: 0 })),
        boc,
      ).isZero(),
    ).toBe(true);
    expect(new TheoryPrior(states, keys, boc).isZero()).toBe(false);
  });
  it('estimateChordsPass2 equals estimateChords with the dense prior (TheoryPrior as chords.PriorRows)', () => {
    const nb = 160;
    const n = 2 * nb;
    const chroma = randomChroma(n, 11);
    const boc = barsOf(nb, 1);
    const keys = randomKeys(41, 5);
    const dense = denseTransition(keys, boc);
    const want = estimateChords(chroma, n, cfg, { perBeat: 2, prior: dense });
    const got = estimateChordsPass2(chroma, n, cfg, {
      perBeat: 2,
      barKeys: keys,
      barOfBeat: boc,
    });
    expect(got).toEqual(want);
    const pass1 = estimateChords(chroma, n, cfg, { perBeat: 2 });
    const zero = estimateChordsPass2(chroma, n, cfg, {
      perBeat: 2,
      barKeys: [],
      barOfBeat: boc,
    });
    expect(zero).toEqual(pass1);
  });
});

describe('memory and time', () => {
  it('a long input never holds the [nBeats, S, S] array (MemTracker peak, sampled ArrayBuffer growth)', () => {
    const nb = 1200; // 10 minutes at 120 BPM
    const n = 2 * nb;
    const chroma = randomChroma(n, 21);
    const boc = barsOf(nb, 2);
    const keys = randomKeys(nb / 4, 9);
    const full = nb * S * S * 4; // the float32 array we must not build (float64 would be twice that)
    const mem = new MemTracker();
    const p = new TheoryPrior(states, keys, boc, 1, { mem });
    const base = process.memoryUsage().arrayBuffers;
    let maxAb = 0;
    const row = p.row.bind(p);
    p.row = (t: number) => {
      if (t % 64 === 0)
        maxAb = Math.max(maxAb, process.memoryUsage().arrayBuffers - base);
      return row(t);
    };
    const t0 = performance.now();
    const out = estimateChords(chroma, n, cfg, { perBeat: 2, prior: p });
    const ms = performance.now() - t0;
    expect(out.length).toBe(n);
    console.log(
      `[T13] memory nb=${nb} S=${S}: MemTracker peak=${(mem.peak / 1e6).toFixed(2)} MB, sampled ArrayBuffer growth max=${(maxAb / 1e6).toFixed(1)} MB, ` +
        `[nb,S,S] f32=${(full / 1e6).toFixed(0)} MB, rows computed=${p.computed}, ${ms.toFixed(0)} ms`,
    );
    expect(mem.peak).toBeLessThan(full / 100);
    expect(maxAb).toBeLessThan(full / 4); // chords.ts' own [S, n] buffers only
  }, 120_000);
  it('5-minute song at 120 BPM: pass 2 time vs pass 1', () => {
    const nb = 600;
    const n = 2 * nb;
    const chroma = randomChroma(n, 31);
    const boc = barsOf(nb, 0);
    const keys = randomKeys(nb / 4, 13);
    let t0 = performance.now();
    estimateChords(chroma, n, cfg, { perBeat: 2 });
    const t1 = performance.now() - t0;
    t0 = performance.now();
    estimateChordsPass2(chroma, n, cfg, {
      perBeat: 2,
      barKeys: keys,
      barOfBeat: boc,
    });
    const t2 = performance.now() - t0;
    t0 = performance.now();
    const dense = denseTransition(keys, boc);
    const tb = performance.now() - t0;
    t0 = performance.now();
    estimateChords(chroma, n, cfg, { perBeat: 2, prior: dense });
    const td = performance.now() - t0;
    console.log(
      `[T13] 5 min (nb=${nb}, n=${n}): pass1=${t1.toFixed(0)} ms, pass2 rows=${t2.toFixed(0)} ms, pass2 dense=${td.toFixed(0)} ms (+${tb.toFixed(0)} ms to build ${(dense.byteLength / 1e6).toFixed(0)} MB)`,
    );
  }, 120_000);
});
