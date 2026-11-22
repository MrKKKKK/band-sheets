import { describe, expect, it } from 'vitest';
import { bassConfigHash } from '../bass/config';
import { analyze, type Chords2Input } from './analyze';
import { collapsePosterior, ExpandedPrior, m2Expand, m3Choose, m3Score, marksConfig, scoreChroma } from './bass';
import { chords2ConfigHash, DEFAULT_BASS_METHOD_VALUES, DEFAULT_CHORDS2_CONFIG, resolveChords2Config } from './config';

const C = 0, E = 4, G = 7, A = 9, B = 11;
const chroma = (pcs: number[], w = 1): number[] => Array.from({ length: 12 }, (_, i) => (pcs.includes(i) ? w : 0));
const M3 = { margin: 0.05 };

describe('T8 config: B method values', () => {
  it('all-off configs keep the T3 / T7 hashes; a method brings its values (and they enter the hash)', () => {
    expect(chords2ConfigHash()).toBe('607593f71c46');
    expect(chords2ConfigHash(resolveChords2Config({ stage: 'V1' }))).toBe('6b3456aceb5e');
    expect(DEFAULT_CHORDS2_CONFIG.bass).toEqual({ method: 'off' });
    const m3 = resolveChords2Config({ bass: { method: 'M3' } });
    expect(m3.bass).toEqual({ method: 'M3', ...DEFAULT_BASS_METHOD_VALUES });
    const m3b = resolveChords2Config({ bass: { method: 'M3', m3: { margin: 0.2 } } });
    expect(m3b.bass.m3).toEqual({ margin: 0.2 });
    expect(chords2ConfigHash(m3b)).not.toBe(chords2ConfigHash(m3));
    expect(() => resolveChords2Config({ bass: { m1: { trebleWeight: 0.5 } } })).toThrow(/method/);
    expect(() => resolveChords2Config({ bass: { method: 'M1', m3: { nope: 1 } } })).toThrow(/unknown/);
    expect(() => resolveChords2Config({ bass: { method: 'M1', m1: { trebleWeight: 'x' } } })).toThrow(/expected number/);
    expect(() => resolveChords2Config({ bass: { method: 'M1', nope: 1 } })).toThrow(/unknown/);
  });
  it('M1 / M2 refuse to run without the per-column bass chroma', () => {
    const input: Chords2Input = { chroma: new Float64Array(24), n: 2, perBeat: 1, barKeys: [], barOfBeat: [0, 0] };
    expect(() => analyze(input, resolveChords2Config({ bass: { method: 'M2' } }))).toThrow(/bassChroma/);
    expect(() => analyze(input, resolveChords2Config({ bass: { method: 'M1' } }))).toThrow(/bassChroma/);
  });
  it('T8 pins: the tuned M3 / M1 / M2 configs (DEFAULT_BASS_METHOD_VALUES) and the marks, as run at look point 2', () => {
    const h = (method: 'M1' | 'M2' | 'M3') => chords2ConfigHash(resolveChords2Config({ bass: { method } }));
    expect([h('M3'), h('M1'), h('M2')]).toEqual(['9416f30a7fbb', 'a2e280c86503', '1487c0fed954']);
    expect(bassConfigHash(marksConfig())).toBe('77cc49d1ca67');
  });
  it('the marks are the G2 default without spike 6 root re-decision', () => {
    const m = marksConfig();
    expect(m.enabled).toBe(true);
    expect(m.cliche).toMatchObject({ split: true, redecideRoot: false });
    expect(m.slash.weakMinConfidence).toBe(0.4);
  });
});

describe('M1 scoreChroma', () => {
  it('full minus w x bass, floored at 0; untouched without M1', () => {
    const full = Float64Array.from([1, 0.5, 0.2]);
    const bass = [0.4, 0.6, 0.1];
    expect(scoreChroma(full, bass, DEFAULT_CHORDS2_CONFIG)).toBe(full);
    const cfg = resolveChords2Config({ bass: { method: 'M1', m1: { trebleWeight: 0.5 } } });
    expect(Array.from(scoreChroma(full, bass, cfg))).toEqual([0.8, 0.2, 0.15000000000000002]);
    expect(Array.from(scoreChroma(full, bass, resolveChords2Config({ bass: { method: 'M1', m1: { trebleWeight: 1 } } })))).toEqual([0.6, 0, 0.1]);
    expect(Array.from(scoreChroma(full, bass, resolveChords2Config({ bass: { method: 'M2', m2: { trebleWeight: 1 } } })))).toEqual([0.6, 0, 0.1]);
    expect(() => scoreChroma(full, undefined, cfg)).toThrow(/bassChroma/);
    expect(() => scoreChroma(full, [1], cfg)).toThrow(/length/);
  });
  it('M1 changes the reading when the bass band carries the 3rd: C/E (E only low) is no longer read as Em', () => {
    // one column, right hand C E G over a loud bass E (and its 3rd harmonic B); the bass band holds E 2 and B 1
    const full = [0.5, 0, 0, 0, 2.5, 0, 0, 1, 0, 0, 0, 1];
    const bass = [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1];
    const input = (b?: number[]): Chords2Input => ({ chroma: Float64Array.from(full), n: 1, perBeat: 1, barKeys: [], barOfBeat: [0], ...(b ? { bassChroma: b } : {}) });
    const off = analyze(input(), DEFAULT_CHORDS2_CONFIG).segments[0];
    expect([off.root, off.quality]).toEqual([E, 'min']);
    const m1 = analyze(input(bass), resolveChords2Config({ bass: { method: 'M1', m1: { trebleWeight: 1 } } })).segments[0];
    expect([m1.root, m1.quality]).toEqual([C, 'maj']);
  });
});

describe('M3 m3Choose', () => {
  const bassE = { pc: E, confidence: 0.5 };
  it('C/E read as Em: the treble C E G re-chooses C (it holds the bass E)', () => {
    expect(m3Choose({ root: E, quality: 'min' }, bassE, chroma([C, E, G]), M3, 0.1)).toEqual({ root: C, quality: 'maj' });
  });
  it('keeps the reading when the treble agrees, the bass is unsure, the quality is outside its classes, or the root is not the bass', () => {
    expect(m3Choose({ root: E, quality: 'min' }, bassE, chroma([E, G, B]), M3, 0.1)).toBeNull();
    expect(m3Choose({ root: E, quality: 'min' }, { pc: E, confidence: 0.05 }, chroma([C, E, G]), M3, 0.1)).toBeNull();
    expect(m3Choose({ root: E, quality: 'dim' }, bassE, chroma([C, E, G]), M3, 0.1)).toBeNull();
    // C over a G bass (a left hand on the 5th): not M3's error, even when the treble looks like G
    expect(m3Choose({ root: C, quality: 'maj' }, { pc: G, confidence: 0.9 }, chroma([G, B, 2]), M3, 0.1)).toBeNull();
  });
  it('only chords that hold the bass: C/B read as B-something is not turned into C', () => {
    expect(m3Choose({ root: B, quality: 'min' }, { pc: B, confidence: 0.5 }, chroma([C, E, G]), M3, 0.1)).toEqual({ root: E, quality: 'min' });
    expect(m3Choose({ root: B, quality: 'min' }, { pc: B, confidence: 0.5 }, chroma([C, E, G]), { margin: 0.7 }, 0.1)).toBeNull();
  });
  it('a close treble keeps the root position (margin); sevenths stay sevenths; never the same notes', () => {
    expect(m3Choose({ root: E, quality: 'min' }, bassE, chroma([C, E, G, B]), M3, 0.1)).toBeNull();
    expect(m3Choose({ root: E, quality: 'min' }, bassE, chroma([C, E, G]), { margin: 0.5 }, 0.1)).toBeNull();
    expect(m3Choose({ root: E, quality: 'min7' }, bassE, chroma([C, E, G, B]), { margin: 0 }, 0.1)).toEqual({ root: C, quality: 'maj7' });
    expect(m3Choose({ root: A, quality: 'min7' }, { pc: A, confidence: 0.5 }, chroma([A, C, E, G]), { margin: 0 }, 0.1)).toBeNull();
  });
  it('m3Score: cosine of the template on the treble', () => {
    expect(m3Score({ root: C, quality: 'maj' }, chroma([C, E, G], 3))).toBeCloseTo(1, 12);
    expect(m3Score({ root: E, quality: 'min' }, chroma([C, E, G]))).toBeCloseTo(2 / 3, 12);
    expect(m3Score({ root: C, quality: 'maj' }, chroma([]))).toBe(0);
  });
});

describe('M2', () => {
  it('m2Expand: one state per chord tone; chord score + weight x normalized bass chroma + root bonus; gated / silent stay 0', () => {
    const sts = [{ root: C, quality: 'maj' }, { root: E, quality: 'min' }];
    const n = 2;
    const s = Float64Array.from([0.8, 0, 0.6, 0.5]); // [2 states, 2 columns]; state 0 gated off in column 1
    const bass = new Float64Array(24);
    bass[E * n + 0] = 2; // column 0: bass E (max), C half
    bass[C * n + 0] = 1;
    const ex = m2Expand(s, sts, bass, n, { ...DEFAULT_BASS_METHOD_VALUES, m2: { trebleWeight: 1, bassWeight: 0.5, rootBonus: 0.1 } });
    expect(ex.k).toBe(6);
    expect(Array.from(ex.base)).toEqual([0, 0, 0, 1, 1, 1]);
    // C over C / E / G in column 0
    expect([ex.emis[0 * n], ex.emis[1 * n], ex.emis[2 * n]]).toEqual([0.8 + 0.25 + 0.1, 0.8 + 0.5, 0.8]);
    // Em over E (its root) in column 0
    expect(ex.emis[3 * n]).toBeCloseTo(0.6 + 0.5 + 0.1, 12);
    expect(ex.emis[0 * n + 1]).toBe(0);
    expect(() => m2Expand(s, sts, undefined, n, DEFAULT_BASS_METHOD_VALUES)).toThrow(/bassChroma/);
  });
  it('ExpandedPrior maps the chord prior; collapsePosterior sums per chord', () => {
    const inner = { rows: 1, row: () => [1, 2, 3, 4], isZero: () => false };
    const p = new ExpandedPrior(inner, Int32Array.from([0, 0, 1]), 2);
    expect(Array.from(p.row(0))).toEqual([1, 1, 2, 1, 1, 2, 3, 3, 4]);
    expect(Array.from(collapsePosterior(Float64Array.from([0.1, 0.2, 0.3, 0.4, 0.6, 0.4]), Int32Array.from([0, 0, 1]), 2, 2))).toEqual([0.4, 0.6000000000000001, 0.6, 0.4]);
  });
  it('M2 decodes C/E as C where the full chroma reads Em (the bass E is a tone of C, the treble is C E G)', () => {
    const full = [0.5, 0, 0, 0, 2.5, 0, 0, 1, 0, 0, 0, 1];
    const bass = [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1];
    const seg = analyze({ chroma: Float64Array.from(full), n: 1, perBeat: 1, barKeys: [], barOfBeat: [0], bassChroma: bass }, resolveChords2Config({ bass: { method: 'M2' } })).segments[0];
    expect([seg.root, seg.quality]).toEqual([C, 'maj']);
  });
});
