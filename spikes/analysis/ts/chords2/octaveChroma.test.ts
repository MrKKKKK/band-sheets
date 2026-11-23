// Spike 8 T6: the D1 switch (plan §2.2). Hand-made additive tones only; goes through the real F1 (7-octave CQT).
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze';
import { chords2ConfigHash, DEFAULT_CHORDS2_CONFIG, resolveChords2Config } from './config';
import { foldF1 } from './octaveChroma';
import { DEFAULT_F1_CONFIG } from './front/config';
import { f1Beats, octaveCqt } from './front/f1';
import { chordName } from './analyze';

const SR = 22050;
const PIANO = [0.6, 1, 0.8, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1, 0.08]; // 2nd / 3rd partials stronger than the fundamental

function tones(midis: number[], sec = 2): Float32Array {
  const n = Math.round(sec * SR);
  const y = new Float32Array(n);
  for (const midi of midis) {
    const f0 = 440 * 2 ** ((midi - 69) / 12);
    PIANO.forEach((a, i) => {
      const f = f0 * (i + 1);
      if (f >= SR / 2 - 200) return;
      const w = (2 * Math.PI * f) / SR;
      for (let k = 0; k < n; k++) y[k] += a * Math.min(1, k / (0.01 * SR)) * Math.exp(-k / (3 * SR)) * Math.sin(w * k + ((i * 1.7 + midi) % (2 * Math.PI)));
    });
  }
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let k = 0; k < n; k++) y[k] *= 0.3 / peak;
  return y;
}

describe('D1 config switch', () => {
  it('off by default: the hashes of existing configs do not move; on changes the hash', () => {
    expect(DEFAULT_CHORDS2_CONFIG.octaveChroma).toBeUndefined();
    expect(chords2ConfigHash()).toBe('607593f71c46');
    expect(chords2ConfigHash(resolveChords2Config({ stage: 'V1' }))).toBe('6b3456aceb5e');
    expect(chords2ConfigHash(resolveChords2Config({ octaveChroma: undefined }))).toBe('607593f71c46');
    const on = resolveChords2Config({ octaveChroma: true });
    expect(on.octaveChroma).toBe(true);
    expect(chords2ConfigHash(on)).not.toBe('607593f71c46');
    expect(() => resolveChords2Config({ octaveChroma: 1 })).toThrow(/octaveChroma/);
  });
  it('on without f1Chroma throws', () => {
    expect(() => analyze({ chroma: new Float64Array(12), n: 1, perBeat: 1, barKeys: [], barOfBeat: [0] }, resolveChords2Config({ octaveChroma: true }))).toThrow(/f1Chroma/);
  });
});

describe('D1: synthetic C/E (piano C major triad, E in the bass)', () => {
  it('D1 ON does not give Em; C (root 0) is read', () => {
    const y = tones([40, 60, 64, 67]); // E2 bass, C4 E4 G4
    const beats = f1Beats(octaveCqt(y, DEFAULT_F1_CONFIG, { tuning: 0 }), [0.25], 1.75);
    const f1Chroma = foldF1(beats);
    const out = analyze({ chroma: Float64Array.from(f1Chroma), n: 1, perBeat: 1, barKeys: [], barOfBeat: [0], f1Chroma }, resolveChords2Config({ octaveChroma: true }));
    const col = out.columns[0];
    expect(chordName(col.root, col.quality)).not.toBe('Em');
    expect(col.root).toBe(0);
  });
});
