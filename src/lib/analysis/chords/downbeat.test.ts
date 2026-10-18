import { describe, expect, it } from 'vitest';
import {
  chordChangeStrength,
  estimateDownbeats,
  bassChangeStrength,
  beatOnsetStrength,
} from './downbeat';

describe('downbeat rule', () => {
  it('chord changes every 4 beats pick that phase with positive confidence', () => {
    const roots = [0, 0, 0, 0, 7, 7, 7, 7, 0, 0, 0, 0, 7, 7, 7, 7].map(
      (r) => r as number | null,
    );
    const cc = chordChangeStrength(roots, null, null);
    const d = estimateDownbeats(16, cc, null, null);
    expect(d.phase).toBe(0);
    const shifted = estimateDownbeats(15, cc.slice(1), null, null);
    expect(shifted.phase).toBe(3);
    expect(shifted.confidence).toBeGreaterThan(0);
  });
  it('no evidence: all scores 0, tie -> tie_break_phase 0, confidence 0', () => {
    const d = estimateDownbeats(8, new Float64Array(8), null, null);
    expect(d).toEqual({
      phase: 0,
      beatsPerBar: 4,
      confidence: 0,
      scores: [0, 0, 0, 0],
    });
  });
  it('null / none chords count 0; quality-only change is half weight', () => {
    expect(Array.from(chordChangeStrength([0, null, 0], null, null))).toEqual([
      0, 0, 0,
    ]);
    const c = chordChangeStrength([0, 0], ['maj', '7'], [1, 1]);
    expect(c[1]).toBeCloseTo(0.5);
  });
  it('anticipation moves credit to the next beat', () => {
    const c = chordChangeStrength([0, 7, 7], null, [1, 0.5, 1]);
    expect(c[1]).toBeCloseTo(0.5 * 1);
    expect(c[2]).toBeCloseTo(0.5);
  });
  it('bass: onset of a new note + energy rise', () => {
    const b = new Float64Array(12 * 2);
    // oxlint-disable-next-line oxc/erasing-op
    b[0 * 2 + 0] = 1;
    b[7 * 2 + 1] = 1;
    const out = bassChangeStrength(b, 2)!;
    expect(out[1]).toBeCloseTo(0.5);
  });
  it('onset strength uses round-half-up frame and +-2 window', () => {
    const env = [0, 0, 0, 5, 0, 0, 0, 0];
    const o = beatOnsetStrength(env, [(5 * 512) / 22050], 22050, 512)!;
    expect(o[0]).toBe(5);
  });
});
