/**
 * Golden / characterization test (plan T3): with every v2 switch off (stage V0, bass off, pairRule off) the chords2
 * chord stage equals frozen v1a's 2nd pass (estimateChordsPass2 + mergeSegments) exactly: same columns (root,
 * quality, confidence, posterior), same segments (with candidates). Inputs are the same kinds of fixtures v1a's own
 * tests use (harmony.test.ts / chords.test.ts: hand-made chord chroma and seeded random chroma and bar keys).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHORDS_CONFIG as v1cfg, mergeSegments } from '../dsp/chords';
import { estimateChordsPass2 } from '../dsp/harmony';
import type { BarKey } from '../dsp/keytrack';
import { analyze } from './analyze';
import { bassConfigHash, enabledBassConfig } from '../bass/config';
import { appBassConfig, DEFAULT_CHORDS2_CONFIG, chords2ConfigHash, resolveChords2Config } from './config';

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
function randomChroma(n: number, seed: number): Float64Array {
  const r = rng(seed);
  const c = new Float64Array(12 * n);
  for (let i = 0; i < c.length; i++) c[i] = r() < 0.35 ? r() : 0;
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
    out.push({ bar: b, tonic, mode, confidence: r() < 0.1 ? 0 : 0.5 + 0.5 * r() });
  }
  return out;
}
const barsOf = (nb: number, phase: number, bpb = 4) => Array.from({ length: nb }, (_, i) => Math.floor((i - phase) / bpb));
/** chroma [12, n] from per-column pitch-class lists (hand-made chord progression, as chords.test.ts) */
function chromaOf(cols: number[][]): Float64Array {
  const n = cols.length;
  const c = new Float64Array(12 * n);
  cols.forEach((pcs, t) => pcs.forEach((p) => (c[p * n + t] = 1)));
  return c;
}

const off = resolveChords2Config({});

function expectSame(chroma: Float64Array, n: number, perBeat: number, keys: BarKey[], boc: number[]): void {
  const want = estimateChordsPass2(chroma, n, v1cfg, { perBeat, barKeys: keys, barOfBeat: boc });
  const got = analyze({ chroma, n, perBeat, barKeys: keys, barOfBeat: boc }, off);
  expect(got.columns).toEqual(want);
  expect(got.segments).toEqual(mergeSegments(want, v1cfg, perBeat));
  expect(got.states.length).toBe(120);
}

describe('chords2 with every switch off == frozen v1a', () => {
  it('seeded random chroma and bar keys, per_beat 1 and 2, with a pickup', () => {
    for (const [seed, perBeat, phase] of [[1, 1, 0], [11, 2, 1], [23, 2, 3], [5, 1, 2]] as const) {
      const nb = 120;
      const n = nb * perBeat;
      expectSame(randomChroma(n, seed), n, perBeat, randomKeys(35, seed + 100), barsOf(nb, phase));
    }
  });
  it('no keys (zero prior: the fast path) and zero-confidence keys', () => {
    const nb = 80;
    const boc = barsOf(nb, 0);
    const chroma = randomChroma(nb * 2, 9);
    expectSame(chroma, nb * 2, 2, [], boc);
    expectSame(chroma, nb * 2, 2, randomKeys(20, 4).map((k) => ({ ...k, confidence: 0 })), boc);
  });
  it('hand-made block chords with silence (C - Am7 - F - G7, N)', () => {
    const prog = [[0, 4, 7], [9, 0, 4, 7], [5, 9, 0], [7, 11, 2, 5], []];
    const cols = prog.flatMap((p) => Array.from({ length: 4 }, () => p));
    const keys: BarKey[] = Array.from({ length: 5 }, (_, b) => ({ bar: b, tonic: 0, mode: 'major', confidence: 0.8 }));
    expectSame(chromaOf(cols), cols.length, 1, keys, barsOf(cols.length, 0));
  });
  it('empty input', () => {
    expect(analyze({ chroma: new Float64Array(0), n: 0, perBeat: 1, barKeys: [], barOfBeat: [] }, off).segments).toEqual([]);
  });
});

describe('config', () => {
  it('defaults: everything off, V0; v1a chords values are carried unchanged', () => {
    expect(DEFAULT_CHORDS2_CONFIG).toMatchObject({ stage: 'V0', bass: { method: 'off' }, pairRule: 'off' });
    expect(DEFAULT_CHORDS2_CONFIG.chords).toEqual(v1cfg);
  });
  it('hash pin (changes whenever a value changes) and override validation', () => {
    expect(chords2ConfigHash()).toBe(PIN_DEFAULT);
    expect(chords2ConfigHash(resolveChords2Config({ stage: 'V1' }))).not.toBe(PIN_DEFAULT);
    expect(() => resolveChords2Config({ nope: 1 })).toThrow(/unknown chords2 config key/);
    expect(() => resolveChords2Config({ stage: 'V9' })).toThrow(/stage/);
  });
  it('B methods (T8, bass.test.ts): M3 runs after the chord stage (chord stage = off), M1 / M2 need the bass chroma', () => {
    const inp = { chroma: randomChroma(8, 1), n: 8, perBeat: 1, barKeys: [], barOfBeat: barsOf(8, 0) };
    const c = (o: unknown) => () => analyze(inp, resolveChords2Config(o));
    expect(analyze(inp, resolveChords2Config({ bass: { method: 'M3' } })).segments).toEqual(analyze(inp, DEFAULT_CHORDS2_CONFIG).segments);
    expect(c({ bass: { method: 'M1' } })).toThrow(/bassChroma/);
    expect(c({ bass: { method: 'M2' } })).toThrow(/bassChroma/);
    expect(c({ pairRule: 'context' })).toThrow(/pairRule/); // applied by pipeline.ts pairsAfterBass only (T17)
  });
});

describe('T17: app bass config and the pair rule in the hash', () => {
  it('appBassConfig = spike 6 G2 config without redecideRoot, hash pinned', () => {
    const c = appBassConfig();
    expect(c.enabled).toBe(true);
    expect(c.cliche).toMatchObject({ split: true, redecideRoot: false });
    expect(bassConfigHash(c)).toBe('77cc49d1ca67');
    expect(bassConfigHash(enabledBassConfig())).toBe('e5b432a11e3c'); // spike 6's G2 (with redecideRoot), unchanged
  });
  it('the pairRule value is part of the chords2 hash; off keeps the earlier hashes', () => {
    const v1 = (pairRule: string) => chords2ConfigHash(resolveChords2Config({ stage: 'V1', pairRule }));
    expect(v1('off')).toBe('6b3456aceb5e');
    expect(new Set([v1('off'), v1('context'), v1('bassRoot')]).size).toBe(3);
  });
});

describe('vocabulary stages', () => {
  it('state counts 120 / 156 / 204 / 240; names and the family map', async () => {
    const vocab = await import('./vocab');
    expect(['V0', 'V1', 'V2', 'V3'].map((s) => vocab.states(s as 'V0', v1cfg).length)).toEqual([120, 156, 204, 240]);
    expect(vocab.suffix('maj9')).toBe('maj9');
    expect(vocab.suffix('min7')).toBe('m7');
    expect(vocab.familyOf('sus2')).toEqual(['maj', 'min']);
    expect(vocab.familyOf('maj7')).toEqual(['maj7']);
    for (const q of vocab.newQualities('V3')) expect(vocab.FAMILY_OF[q]).toBeDefined();
  });
  it('V3 runs end to end (sus2 uses the max of two priors)', () => {
    const nb = 40;
    const out = analyze(
      { chroma: randomChroma(nb, 3), n: nb, perBeat: 1, barKeys: randomKeys(10, 2), barOfBeat: barsOf(nb, 0) },
      resolveChords2Config({ stage: 'V3' }),
    );
    expect(out.states.length).toBe(240);
    expect(out.columns.length).toBe(nb);
  });
});

const PIN_DEFAULT = '607593f71c46';
