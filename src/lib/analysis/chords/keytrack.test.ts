/**
 * keyest / keytrack unit tests (no dumps needed). keytrack.cases.json = synthetic random chord sequences with
 * Python's keytrack.estimate / keyest.estimate_key outputs (spike 3 T12; generator out/t12/cases.py, not
 * committed): cases with 1, 2 and 3 passes and 6 that end without converging (keytrack-not-converged), which
 * the dev dumps never reach (all 23 converge after 1 pass).
 */
import casesRaw from './keytrack.cases.json?raw';
import { describe, expect, it } from 'vitest';
import { estimateKey, keyScores } from './keyest';
import {
  estimate,
  fitMatrix,
  keyIndex,
  neutralMatrix,
  phrases,
  QUALITIES,
  resolutions,
  type KeyChord,
} from './keytrack';

interface Case {
  root: number[];
  quality: string[];
  phase: number;
  sections: number[];
  passes: number;
  converged: boolean;
  keys: [number, number, number, number][];
  globalKey: [string, string, number];
}
const CASES = (JSON.parse(casesRaw) as { cases: Case[] }).cases;
const TONES: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  sus4: [0, 5, 7],
};
const chordsOf = (c: Case): KeyChord[] =>
  c.root.map((r, i) => ({ root: r < 0 ? null : r, quality: c.quality[i] }));
const barsOf = (n: number, phase: number) =>
  Array.from({ length: n }, (_, i) => Math.floor((i - phase) / 4));

describe('keyest', () => {
  it('C major scale profile -> C major; flat / silent -> C major 0', () => {
    const pcp = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
    expect(estimateKey(pcp, 1)).toMatchObject({ tonic: 'C', mode: 'major' });
    expect(estimateKey(new Array(12).fill(1), 1)).toEqual({
      tonic: 'C',
      mode: 'major',
      confidence: 0,
    });
    expect(estimateKey(new Array(24).fill(0), 2)).toEqual({
      tonic: 'C',
      mode: 'major',
      confidence: 0,
    });
    const s = keyScores(pcp);
    expect(s.length).toBe(24);
    expect(s[0]).toBeGreaterThan(s[9 + 12]); // C major over A minor for this profile
  });
  it('matches Python estimate_key on the synthetic cases', () => {
    for (const c of CASES) {
      const n = c.root.length;
      const chroma = new Float64Array(12 * n);
      c.root.forEach((r, t) => {
        if (r < 0) return;
        for (const iv of TONES[c.quality[t]])
          chroma[((r + iv) % 12) * n + t] += 1.0 + 0.1 * ((t * 7 + iv) % 5);
      });
      const g = estimateKey(chroma, n);
      expect([g.tonic, g.mode]).toEqual(c.globalKey.slice(0, 2));
      expect(Math.abs(g.confidence - c.globalKey[2])).toBeLessThan(1e-12);
    }
  });
});

describe('keytrack tables', () => {
  it('fit matrix: tonic 1.35, diatonic 1, minor dominant shared with the relative major', () => {
    const fit = fitMatrix();
    const at = (k: number, r: number, q: string) =>
      fit[(k * 12 + r) * QUALITIES.length + QUALITIES.indexOf(q as never)];
    const C = keyIndex(0, 'major');
    const Am = keyIndex(9, 'minor');
    expect(at(C, 0, 'maj')).toBe(1.35);
    expect(at(C, 2, 'min')).toBe(1.0);
    expect(at(Am, 4, '7')).toBe(at(C, 4, '7')); // E7: V of A minor = V/vi of C major
    expect(at(Am, 4, '7')).toBe(1.0);
    const neu = neutralMatrix();
    expect(
      neu[(C * 12 + 4) * QUALITIES.length + QUALITIES.indexOf('maj')],
    ).toBe(1);
    expect(
      neu[
        (keyIndex(4, 'major') * 12 + 4) * QUALITIES.length +
          QUALITIES.indexOf('maj')
      ],
    ).toBe(0);
  });
  it('resolutions and phrases', () => {
    const ch: KeyChord[] = [
      { root: 7, quality: '7' },
      { root: 7, quality: '7' },
      { root: 0, quality: 'maj' },
      { root: 0, quality: 'maj' },
      { root: null, quality: 'maj' },
      { root: 6, quality: 'dim7' },
      { root: 7, quality: 'min' },
      { root: 7, quality: 'min' },
    ];
    const boc = Int32Array.from(barsOf(8, 1));
    const r = resolutions(ch, boc);
    expect(r).toEqual([
      {
        domBar: 0,
        targetBar: 0,
        tonic: 0,
        mode: 'major',
        kind: 'dominant7',
        targetCols: [2, 4],
      },
      {
        domBar: 1,
        targetBar: 1,
        tonic: 7,
        mode: 'minor',
        kind: 'dominant7',
        targetCols: [6, 8],
      },
    ]);
    const voiced = Uint8Array.from(ch, (c) => (c.root === null ? 0 : 1));
    expect(phrases(boc, [], 2, 1, voiced)).toEqual([
      [1, 3],
      [5, 7],
    ]);
    expect(phrases(boc, [], 2, 0, voiced)).toEqual([]);
  });
});

describe('keytrack vs Python (synthetic cases)', () => {
  it('covers 1-3 passes and non-convergence', () => {
    const tags = new Set(CASES.map((c) => `${c.passes}/${c.converged}`));
    for (const t of ['1/true', '2/true', '3/true', '4/false'])
      expect(tags).toContain(t);
  });
  CASES.forEach((c, i) => {
    it(`case ${i}: ${c.root.length} beats, passes ${c.passes}, converged ${c.converged}`, () => {
      const got = estimate(
        chordsOf(c),
        barsOf(c.root.length, c.phase),
        c.sections,
      );
      expect(got.passes).toBe(c.passes);
      expect(got.converged).toBe(c.converged);
      expect(
        got.keys.map((k) => [k.bar, k.tonic, k.mode === 'major' ? 0 : 1]),
      ).toEqual(c.keys.map((k) => k.slice(0, 3)));
      got.keys.forEach((k, b) =>
        expect(Math.abs(k.confidence - c.keys[b][3])).toBeLessThan(1e-12),
      );
    });
  });
  it('5-minute timing (600 beats = 150 bars at 120 BPM, chords tiled from a non-converging case)', () => {
    const c = CASES.find((x) => !x.converged)!;
    const ch = chordsOf(c);
    const tiled = Array.from({ length: 600 }, (_, i) => ch[i % ch.length]);
    const keyEst = new Float64Array(12 * 600).map((_, i) => (i * 7919) % 13);
    const t0 = performance.now();
    const got = estimate(tiled, barsOf(600, 0), [0, 32, 64, 96, 128]);
    const g = estimateKey(keyEst, 600);
    const ms = performance.now() - t0;
    console.log(
      `[T12] 5 min: ${got.keys.length} bars, passes ${got.passes}, ${ms.toFixed(1)} ms (keytrack + keyest)`,
      g.mode,
    );
    expect(got.keys.length).toBe(150);
  });
  it('empty / all-pickup input -> no keys', () => {
    expect(estimate([], [], [])).toEqual({
      keys: [],
      passes: 0,
      converged: true,
    });
    expect(estimate([{ root: 0, quality: 'maj' }], [-1], []).keys).toEqual([]);
  });
});
