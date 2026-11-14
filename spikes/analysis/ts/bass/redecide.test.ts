import { beforeEach, describe, expect, it } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { resolveBassConfig } from './config';
import type { LowCqt } from './lowCqt';
import { redecide, redecideRoots, thirdRelated, trebleChroma } from './redecide';

// Generic key-C material. Pitch classes: C 0, D 2, E 4, G 7, A 9, B 11.
const cfg = resolveBassConfig({ enabled: true, cliche: { redecideRoot: true } });
const chroma = (v: Record<number, number>) => Array.from({ length: 12 }, (_, i) => v[i] ?? 0);

/** One frame per column, rows = MIDI 24.. (row r = MIDI 24 + r); `rows` maps MIDI -> magnitude, held for 2 s. */
function toy(rows: Record<number, number>): LowCqt {
  const frameSec = 512 / 22050;
  const cols = Math.ceil(2 / frameSec);
  const semi = new Float32Array(60 * cols);
  for (const [m, a] of Object.entries(rows)) for (let t = 0; t < cols; t++) semi[(Number(m) - 24) * cols + t] = a;
  return { semi, nSemis: 60, cols, midi0: 24, frameSec, tuning: 0 };
}
/** E2 (MIDI 40) bass with 1/h harmonics h = 1..8. */
const E2 = { 40: 1, 52: 1 / 2, 59: 1 / 3, 64: 1 / 4, 68: 1 / 5, 71: 1 / 6, 74: 1 / 7, 76: 1 / 8 };

describe('root re-decision (redecide.ts)', () => {
  beforeEach(() => stubNoNetwork());

  it('third-related triads of the other mode, with the note each gains and drops', () => {
    expect(thirdRelated({ root: 0, quality: 'maj' })).toEqual([
      { root: 9, quality: 'min', gained: 9, dropped: 7 },
      { root: 4, quality: 'min', gained: 11, dropped: 0 },
    ]);
    expect(thirdRelated({ root: 4, quality: 'min' })).toEqual([
      { root: 7, quality: 'maj', gained: 2, dropped: 4 },
      { root: 0, quality: 'maj', gained: 0, dropped: 11 },
    ]);
  });

  it('Em over E with C above and no B -> C (C/E); only minor triads, a shared bass, enough evidence', () => {
    const em = { root: 4, quality: 'min' as const };
    expect(redecide(em, { pc: 4, confidence: 0.5 }, chroma({ 0: 4, 11: 1 }), cfg)).toEqual({ root: 0, quality: 'maj' });
    expect(redecide(em, { pc: 4, confidence: 0.5 }, chroma({ 0: 3.9, 11: 1 }), cfg)).toBeNull(); // below redecideRatio 4
    expect(redecide(em, { pc: 4, confidence: 0.05 }, chroma({ 0: 4, 11: 1 }), cfg)).toBeNull(); // bass below minConfidence
    expect(redecide(em, { pc: 6, confidence: 0.5 }, chroma({ 0: 4, 11: 1 }), cfg)).toBeNull(); // F# is in neither triad
    expect(redecide({ root: 7, quality: 'maj' }, { pc: 7, confidence: 0.5 }, chroma({ 4: 9, 2: 1 }), cfg)).toBeNull(); // G stays G
    // Am with C in the bass and G above, no A -> C
    expect(redecide({ root: 9, quality: 'min' }, { pc: 0, confidence: 0.5 }, chroma({ 7: 5, 9: 1 }), cfg)).toEqual({ root: 0, quality: 'maj' });
  });

  it('treble chroma takes the bass harmonics out (spectral smoothness keeps a piano note on a harmonic)', () => {
    const plain = trebleChroma(toy({ ...E2, 60: 0.3 }), { start: 0, end: 2 }, 40); // C4 above E2
    expect(plain[0]).toBeCloseTo(0.3, 5); // C kept
    expect(plain[11]).toBeCloseTo(0, 5); // B (E2's 3rd and 6th harmonics) removed
    const onHarmonic = trebleChroma(toy({ ...E2, 64: 1 / 4 + 0.4 }), { start: 0, end: 2 }, 40); // E4 played on h4
    expect(onHarmonic[4]).toBeGreaterThan(0.3);
  });

  it('redecideRoots rebuilds the name, keeps the ? and every other field; unchanged chords stay the same object', () => {
    const low = toy({ ...E2, 60: 0.3, 67: 0.3 }); // E2 bass, C4 + G4 above: C/E
    const em = { start: 0, end: 2, root: 'E', quality: 'min', bass: null, text: 'Em?', confidence: 0.4 };
    const g = { start: 0, end: 2, root: 'G', quality: 'maj', bass: null, text: 'G', confidence: 0.9 };
    const bass = { pc: 4, midi: 40, confidence: 0.5, second: { pc: 0, confidence: 0.5 } };
    const [a, b] = redecideRoots(low, [em, g], [bass, bass], cfg);
    expect(a).toEqual({ ...em, root: 'C', quality: 'maj', text: 'C?' });
    expect(b).toBe(g);
  });

  it('redecideRoots throws on a root name it does not know instead of treating it as pitch class -1', () => {
    const low = toy(E2);
    const bass = { pc: 4, midi: 40, confidence: 0.5, second: { pc: 0, confidence: 0 } };
    const flat = { start: 0, end: 2, root: 'Bb', quality: 'maj', bass: null };
    expect(() => redecideRoots(low, [flat], [bass], cfg)).toThrow(/unexpected chord root "Bb"/);
    // non-triad qualities are skipped before the root is read (unchanged behaviour)
    const seventh = { ...flat, quality: '7' };
    expect(redecideRoots(low, [seventh], [bass], cfg)[0]).toBe(seventh);
  });
});
