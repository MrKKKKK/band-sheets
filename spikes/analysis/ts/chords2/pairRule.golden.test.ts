/**
 * Golden (plan T9): pairRule 'off' leaves the chords2 output of T3 unchanged at every stage. The pins were computed
 * from the T3 code (0bfdce1) before the T9 post-pass existed; analyze() with pairRule 'off' must keep matching them.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BarKey } from '../dsp/keytrack';
import { analyze } from './analyze';
import { resolveChords2Config } from './config';
import type { Stage } from './vocab';

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

function run(stage: Stage, seed: number, perBeat: 1 | 2, pairRule: string) {
  const nb = 64;
  const n = nb * perBeat;
  return analyze(
    { chroma: randomChroma(n, seed), n, perBeat, barKeys: randomKeys(nb / 4, seed + 7), barOfBeat: Array.from({ length: nb }, (_, i) => Math.floor(i / 4)) },
    resolveChords2Config({ stage, pairRule }),
  );
}

/** SHA-256 (first 16 hex) of the segments (with candidates) and the columns' readings of one seeded input. */
function offDigest(stage: Stage, seed: number, perBeat: 1 | 2): string {
  const out = run(stage, seed, perBeat, 'off');
  const cols = out.columns.map((c) => [c.root, c.quality, c.confidence]);
  return createHash('sha256').update(JSON.stringify({ segs: out.segments, cols })).digest('hex').slice(0, 16);
}

const CASES: [Stage, number, 1 | 2][] = [
  ['V1', 3, 1],
  ['V1', 8, 2],
  ['V2', 5, 1],
  ['V2', 13, 2],
  ['V3', 21, 1],
];

describe("pairRule 'off' == T3 output (golden)", () => {
  it.each(CASES)('stage %s, seed %i, perBeat %i', (stage, seed, perBeat) => {
    expect(offDigest(stage, seed, perBeat)).toBe(PINS[`${stage}-${seed}-${perBeat}`]);
  });
  it('the inputs do contain pair readings (pairRule on gives candidates; columns are never changed)', () => {
    let pairSegs = 0;
    for (const [stage, seed, perBeat] of CASES) {
      const off = run(stage, seed, perBeat, 'off');
      const on = run(stage, seed, perBeat, 'context');
      expect(on.columns).toEqual(off.columns);
      expect(on.segments).toHaveLength(off.segments.length);
      pairSegs += on.segments.filter((s) => s.chordCandidates).length;
    }
    expect(pairSegs).toBeGreaterThan(0);
  });
});

const PINS: Record<string, string> = {
  'V1-3-1': '62c8a17730b323ec',
  'V1-8-2': '51c143ac79b52215',
  'V2-5-1': 'c8188d285feb0a23',
  'V2-13-2': '58a784eafb165136',
  'V3-21-1': 'ae1fee685312d85b',
};
