import { describe, expect, it } from 'vitest';
import type { BarKey } from '../dsp/keytrack';
import { analyze, chordName } from './analyze';
import { DEFAULT_CHORDS2_CONFIG, resolveChords2Config } from './config';

/** chroma [12, n] from per-column pitch-class lists (level per pc) */
function chromaOf(cols: [number, number][][]): Float64Array {
  const n = cols.length;
  const c = new Float64Array(12 * n);
  cols.forEach((pcs, t) => pcs.forEach(([p, v]) => (c[p * n + t] = v)));
  return c;
}

const A = 9, C = 0, E = 4, Gs = 8, G = 7, Fs = 6;
const BEATS = 8; // per chord
// inner-voice line over a held Am triad: E-G#-G-F# (the 5th's neighbour moves by step), level LINE
const LINE = 0.9;
const frames = [Gs, G, Fs].reduce<[number, number][][]>(
  (acc, m) => [...acc, ...Array.from({ length: BEATS }, () => [[A, 1], [C, 1], [E, 1], [m, LINE]] as [number, number][])],
  Array.from({ length: BEATS }, () => [[A, 1], [C, 1], [E, 1]] as [number, number][]),
);
const n = frames.length;
const chroma = chromaOf(frames);
const barOfBeat = Array.from({ length: n }, (_, i) => Math.floor(i / 4));
const aMinor: BarKey[] = Array.from({ length: n / 4 }, (_, b) => ({ bar: b, tonic: 9, mode: 'minor', confidence: 0.9 }));
const run = (stage: 'V0' | 'V1', keys: BarKey[]) => analyze({ chroma, n, perBeat: 1, barKeys: keys, barOfBeat }, resolveChords2Config({ stage }));
const names = (stage: 'V0' | 'V1', keys: BarKey[]) => run(stage, keys).segments.map((s) => chordName(s.root, s.quality));

describe('inner-voice cliche (Am - AmM7 - Am7 - Am6), plan T3 done condition', () => {
  it('V1 re-solves the Viterbi and makes 4 segments: Am, AmM7, Am7, and the Am6 / F#m7b5 pair', () => {
    const got = names('V1', aMinor);
    expect(got.slice(0, 3)).toEqual(['Am', 'AmM7', 'Am7']);
    expect(got).toHaveLength(4);
    // Am6 = F#m7b5 (identical notes): with pairRule 'off' the tie goes to the existing v1a reading (plan §2.3); the
    // other reading stays a candidate. Choosing Am6 is T9's job.
    expect(got[3]).toBe('F#m7b5');
    const cands = run('V1', aMinor).segments[3].candidates.map((c) => chordName(c.root, c.quality));
    expect(cands).toContain('Am6');
  });
  it('V0 cannot name mM7 / m6 (U1: v1a segments cannot be relabeled, the state space has to grow)', () => {
    const v0 = names('V0', aMinor);
    expect(v0.some((x) => /mM7|m6$/.test(x))).toBe(false);
    expect(v0.length).toBeLessThan(4);
  });
  it('the default config is stage V0', () => {
    expect(DEFAULT_CHORDS2_CONFIG.stage).toBe('V0');
  });
});
