import { beforeEach, describe, expect, it } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { resolveBassConfig } from './config';
import { beatSpans, splitByBass } from './cliche';
import type { LowCqt } from './lowCqt';

// Generic key-C toy spectrograms: one row lit per time span (row 0 = C1 = MIDI 24). Beats every 0.5 s.
const FRAME = 512 / 22050;
function toy(spans: [number, number, number][], sec: number): LowCqt {
  const cols = Math.ceil(sec / FRAME) + 1;
  const semi = new Float32Array(60 * cols);
  for (let t = 0; t < cols; t++) for (const [s, e, row] of spans) if (t * FRAME >= s && t * FRAME < e) semi[row * cols + t] = 1;
  return { semi, nSemis: 60, cols, midi0: 24, frameSec: FRAME, tuning: 0 };
}
const beats = Array.from({ length: 21 }, (_, i) => i * 0.5);
const cfg = resolveBassConfig({ enabled: true, cliche: { split: true } });

describe('B-3 split (cliche.ts)', () => {
  beforeEach(() => stubNoNetwork());

  it('beatSpans cuts at the beats strictly inside the segment', () => {
    expect(beatSpans({ start: 0, end: 1.5 }, beats)).toEqual([
      { start: 0, end: 0.5 },
      { start: 0.5, end: 1 },
      { start: 1, end: 1.5 },
    ]);
    expect(beatSpans({ start: 0.2, end: 0.4 }, beats)).toEqual([{ start: 0.2, end: 0.4 }]);
  });

  it('a descending line under one chord (C - C/B - C/A# - C/A, one bar each) is cut at every step', () => {
    const low = toy([[0, 2, 12], [2, 4, 11], [4, 6, 10], [6, 8, 9]], 8); // C2, B1, A#1, A1
    expect(splitByBass(low, [{ start: 0, end: 8 }], beats, cfg)).toEqual([
      { start: 0, end: 2, src: 0 },
      { start: 2, end: 4, src: 0 },
      { start: 4, end: 6, src: 0 },
      { start: 6, end: 8, src: 0 },
    ]);
  });

  it('no cut: a walking line (one note per beat), a leap (C to G), or a split off', () => {
    const walk = toy([[0, 0.5, 12], [0.5, 1, 14], [1, 1.5, 16], [1.5, 2, 17]], 2); // C D E F, a beat each
    expect(splitByBass(walk, [{ start: 0, end: 2 }], beats, cfg)).toEqual([{ start: 0, end: 2, src: 0 }]);
    const leap = toy([[0, 1, 12], [1, 2, 19]], 2); // C2 then G2, two beats each
    expect(splitByBass(leap, [{ start: 0, end: 2 }], beats, cfg)).toEqual([{ start: 0, end: 2, src: 0 }]);
    const step = toy([[0, 1, 12], [1, 2, 11]], 2); // C2 then B1, two beats each: cut at minBeats 2, not at 3
    expect(splitByBass(step, [{ start: 0, end: 2 }], beats, cfg)).toHaveLength(2);
    expect(splitByBass(step, [{ start: 0, end: 2 }], beats, resolveBassConfig({ enabled: true, cliche: { split: true, minBeats: 3 } }))).toHaveLength(1);
  });
});
