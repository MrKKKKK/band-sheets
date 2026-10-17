import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHORDS_CONFIG as cfg,
  beatLevel,
  chordName,
  chordText,
  estimateChords,
  mergeChords,
  mergeSegments,
  type ColumnChord,
} from './chords';
import { chordPosterior, numpySum } from './posterior';
import * as vocab from './vocab';

// reference values from numpy 2.x (a[i] = ((i * 7919) % 1000) / 1000 / 3; sum and mean)
const NUMPY_SUMS: [number, number, number][] = [
  [1, 0.0, 0.0],
  [2, 0.30633333333333335, 0.15316666666666667],
  [5, 1.0633333333333335, 0.2126666666666667],
  [8, 1.5773333333333335, 0.19716666666666668],
  [9, 1.6946666666666668, 0.1882962962962963],
  [16, 2.7600000000000002, 0.17250000000000001],
  [17, 2.994666666666667, 0.17615686274509804],
  [128, 21.21066666666667, 0.16570833333333335],
  [129, 21.421333333333333, 0.16605684754521963],
  [257, 42.808, 0.166568093385214],
  [2500, 416.41666666666663, 0.16656666666666664],
];

/** chroma [12, n] from per-column pitch-class lists */
function chromaOf(cols: number[][], level = 1): Float64Array {
  const n = cols.length;
  const c = new Float64Array(12 * n);
  cols.forEach((pcs, t) => pcs.forEach((p) => (c[p * n + t] = level)));
  return c;
}
const C = [0, 4, 7];
const G = [7, 11, 2];
const G7 = [7, 11, 2, 5];

describe('numpySum', () => {
  for (const [n, sum, mean] of NUMPY_SUMS) {
    it(`matches numpy for n=${n}`, () => {
      const a = Float64Array.from({ length: n }, (_, i) => ((i * 7919) % 1000) / 1000 / 3);
      expect(numpySum(a, 0, n)).toBe(sum);
      expect(numpySum(a, 0, n) / n).toBe(mean);
    });
  }
});

describe('vocab', () => {
  it('v2 order: v1 qualities, then dim/aug/sus4, then m7b5/dim7; 120 states, move over 60', () => {
    const s = vocab.states(cfg);
    expect(s.length).toBe(120);
    expect(vocab.moveStates(cfg)).toBe(60);
    expect(s[0]).toEqual({ root: 0, quality: 'maj' });
    expect(s[12]).toEqual({ root: 0, quality: 'min' });
    expect(s[60]).toEqual({ root: 0, quality: 'dim' });
    expect(s[119]).toEqual({ root: 11, quality: 'dim7' });
    expect(vocab.states({ ...cfg, vocab: 'v1' }).length).toBe(60);
  });
  it('rejects power chords', () => {
    expect(() => vocab.states({ ...cfg, power: true })).toThrow(/power/);
  });
});

describe('estimateChords (hand-made chroma)', () => {
  it('names C then G7, silence is N with confidence 1, posteriors sum to 1', () => {
    const cols = [C, C, C, [], G7, G7, G7];
    const out = estimateChords(chromaOf(cols), cols.length, cfg);
    expect(out.map((c) => chordName(c.root, c.quality))).toEqual(['C', 'C', 'C', 'N', 'G7', 'G7', 'G7']);
    // the silent column breaks nothing: path around it still stays on the chord
    expect(out[3]).toMatchObject({ root: null, quality: 'maj', confidence: 1 });
    for (const c of out) {
      const p = c.posterior as Float64Array;
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });
  it('a 7th needs to beat the triad (G: no F -> plain G)', () => {
    const out = estimateChords(chromaOf([G, G, G]), 3, cfg);
    expect(out.map((c) => chordName(c.root, c.quality))).toEqual(['G', 'G', 'G']);
  });
  it('per_beat 2 works on half-beat columns and rejects odd counts', () => {
    const cols = [C, C, C, C, G, G, G, G];
    const out = estimateChords(chromaOf(cols), 8, cfg, { perBeat: 2 });
    expect(out.map((c) => chordName(c.root, c.quality))).toEqual(['C', 'C', 'C', 'C', 'G', 'G', 'G', 'G']);
    expect(() => estimateChords(chromaOf(cols.slice(1)), 7, cfg, { perBeat: 2 })).toThrow(/multiple/);
    expect(beatLevel(out, 2).length).toBe(4);
  });
  it('an all-zero prior takes the fast path (same result); a prior forbidding the move changes nothing here', () => {
    const cols = [C, C, G, G];
    const a = estimateChords(chromaOf(cols), 4, cfg);
    const k = 120;
    const b = estimateChords(chromaOf(cols), 4, cfg, { prior: new Float64Array(4 * k * k) });
    expect(b.map((c) => [c.root, c.quality])).toEqual(a.map((c) => [c.root, c.quality]));
    // a huge bonus for staying in C on every column keeps the C chord through the G columns
    const prior = new Float64Array(4 * k * k);
    for (let t = 0; t < 4; t++) prior[t * k * k + 0 * k + 0] = 100; // C -> C
    const c = estimateChords(chromaOf(cols), 4, cfg, { prior });
    expect(c.every((x) => x.root === 0 && x.quality === 'maj')).toBe(true);
    // beat-level prior repeated per column (2 rows for 4 columns at perBeat 2) is accepted
    expect(() => estimateChords(chromaOf(cols), 4, cfg, { perBeat: 2, prior: new Float64Array(2 * k * k).fill(0.5) })).not.toThrow();
    expect(() => estimateChords(chromaOf(cols), 4, cfg, { prior: new Float64Array(3 * k * k).fill(0.5) })).toThrow(/prior/);
  });
  it('rejects non-default switches', () => {
    expect(() => estimateChords(chromaOf([C]), 1, { ...cfg, slash: true })).toThrow(/slash/);
    expect(() => estimateChords(chromaOf([C]), 1, { ...cfg, harmonics: 'fixed' as never })).toThrow(/harmonics/);
  });
});

describe('prior forms', () => {
  it('row provider is bit-identical to the flat array; timing at n=1200', () => {
    const k = 120;
    const n = 1200;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const cols = Array.from({ length: n }, (_, t) => [[0, 4, 7], [7, 11, 2], [9, 0, 4], [5, 9, 0]][Math.floor(t / 8) % 4]);
    const chroma = chromaOf(cols);
    for (const perBeat of [1, 2]) {
      const rows = n / perBeat;
      const flat = Float64Array.from({ length: rows * k * k }, () => (rnd() - 0.5) * 3);
      const provider = { rows, row: (r: number) => flat.subarray(r * k * k, (r + 1) * k * k) };
      const t0 = performance.now();
      const a = estimateChords(chroma, n, cfg, { prior: flat, perBeat });
      const t1 = performance.now();
      const b = estimateChords(chroma, n, cfg, { prior: provider, perBeat });
      const t2 = performance.now();
      console.log(`[T7c] perBeat=${perBeat} flat ${(t1 - t0).toFixed(0)} ms, provider ${(t2 - t1).toFixed(0)} ms`);
      expect(b.map((c) => [c.root, c.quality, c.confidence])).toEqual(a.map((c) => [c.root, c.quality, c.confidence]));
    }
    const beatRows = Float64Array.from({ length: (n / 2) * k * k }, () => rnd() - 0.5);
    const prov = { rows: n / 2, row: (r: number) => beatRows.subarray(r * k * k, (r + 1) * k * k) };
    const x = estimateChords(chroma, n, cfg, { prior: prov, perBeat: 2 });
    const y = estimateChords(chroma, n, cfg, { prior: beatRows, perBeat: 2 });
    expect(x.map((c) => [c.root, c.quality])).toEqual(y.map((c) => [c.root, c.quality]));
    expect(() => estimateChords(chroma, n, cfg, { prior: { rows: 7, row: () => beatRows } })).toThrow(/prior/);
    // isZero -> fast path, same as no prior
    const z = estimateChords(chroma, n, cfg, { prior: { rows: n, row: () => { throw new Error('unused'); }, isZero: () => true } });
    expect(z.map((c) => c.root)).toEqual(estimateChords(chroma, n, cfg).map((c) => c.root));
  });
});

describe('chordPosterior', () => {
  it('uniform emissions give uniform posterior; ties are exact', () => {
    const p = chordPosterior(new Float64Array(3 * 4), 3, 4, 0.6);
    for (const v of p) expect(v).toBeCloseTo(1 / 3, 14);
  });
});

function col(root: number | null, quality = 'maj', confidence = 0.5): ColumnChord {
  return { root, quality, confidence, bass: null, posterior: null };
}

describe('mergeChords', () => {
  it('merges equal neighbours; mean confidence; low-confidence flag; no-chord is never low', () => {
    const segs = mergeChords([col(0, 'maj', 0.9), col(0, 'maj', 0.8), col(null, 'maj', 1), col(7, 'maj', 0.5)], cfg);
    expect(segs.map((s) => [s.startBeat, s.endBeat, s.root])).toEqual([[0, 2, 0], [2, 3, null], [3, 4, 7]]);
    expect(segs[0].confidence).toBeCloseTo(0.85, 12);
    expect(segs.map((s) => s.lowConfidence)).toEqual([true, false, true]);
  });
  it('absorbs runs shorter than merge_min_beats into the longer neighbour (previous on a tie)', () => {
    const c = { ...cfg, merge_min_beats: 2 };
    const segs = mergeChords([col(0), col(0), col(5), col(7), col(7)], c);
    expect(segs.map((s) => [s.startBeat, s.endBeat, s.root])).toEqual([[0, 3, 0], [3, 5, 7]]);
  });
  it('mergeSegments attaches top-3 candidates, text gets ? under 0.93', () => {
    const cols = [C, C, C, C];
    const chords = estimateChords(chromaOf(cols), 4, cfg);
    const segs = mergeSegments(chords, cfg);
    expect(segs).toHaveLength(1);
    expect(segs[0].candidates).toHaveLength(3);
    expect(segs[0].candidates[0]).toMatchObject({ root: 0, quality: 'maj' });
    expect(chordText({ root: 0, quality: 'min7', bass: null, confidence: 0.5 }, cfg)).toBe('Cm7?');
    expect(chordText({ root: null, quality: 'maj', bass: null, confidence: 0.1 }, cfg)).toBe('N');
  });
});
