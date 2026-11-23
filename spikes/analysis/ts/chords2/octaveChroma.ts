/**
 * Spike 8 T6, D1 (plan §2.2): fold F1's per-beat notes to 12 pitch classes, the chroma that chords2 scores its template
 * points on when `Chords2Config.octaveChroma` is on. pcStrength with the lowest note counted (the bass is part of the chord
 * here; `/X` itself stays spike 6's B-1). Each beat's row is repeated over its `perBeat` columns.
 */
import { DEFAULT_F1_CONFIG, type F1Config } from './front/config';
import { pcStrength, type F1Beat } from './front/f1';

/** Row-major [12, beats.length * perBeat]. */
export function foldF1(beats: readonly F1Beat[], perBeat = 1, cfg: F1Config = DEFAULT_F1_CONFIG): Float64Array {
  const n = beats.length * perBeat;
  const out = new Float64Array(12 * n);
  beats.forEach((b, i) => {
    const s = pcStrength(b.notes, false, cfg);
    for (let k = 0; k < perBeat; k++) for (let j = 0; j < 12; j++) out[j * n + i * perBeat + k] = s[j];
  });
  return out;
}
