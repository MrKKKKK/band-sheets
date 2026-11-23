/**
 * Spike 8 T4: the added-tone ratio ρ(d) of plan §2.2 steps 2-4 on one beat's F1 notes, used by D2 (d2.ts), T4's unit
 * tests and the front-end accuracy table (docs/audio-spike8-t4.md):
 *   s(p)    = pcStrength (max over octaves; the lowest picked note left out of the numerator, kept in the denominator)
 *   denom   = mean s over the triad's tones that sound (s >= thetaLow x the beat's max s; the bass included)
 *   ρ(d)    = s_numerator(root + d) / denom (0 when no triad tone sounds)
 * θ_low belongs to D2 (Chords2Config `d2.thetaLow`, T5); the caller passes it.
 */
import { DEFAULT_F1_CONFIG, type F1Config } from './config';
import { pcStrength, type F1Note } from './f1';

/** ρ(d) for each added interval in `ds`, root pitch class `root`, triad intervals `triad` (e.g. [0, 4, 7]). */
export function addedRatios(notes: readonly F1Note[], root: number, triad: readonly number[], ds: readonly number[], thetaLow: number, cfg: F1Config = DEFAULT_F1_CONFIG): number[] {
  const all = pcStrength(notes, false, cfg);
  const max = Math.max(...all);
  const on = max > 0 ? triad.map((iv) => all[(root + iv) % 12]).filter((s) => s >= thetaLow * max) : [];
  if (on.length === 0) return ds.map(() => 0);
  const denom = on.reduce((a, b) => a + b, 0) / on.length;
  const num = pcStrength(notes, true, cfg);
  return ds.map((d) => num[(root + d) % 12] / denom);
}

/** ρ(d) for one added interval `d`. */
export const addedRatio = (notes: readonly F1Note[], root: number, triad: readonly number[], d: number, thetaLow: number, cfg: F1Config = DEFAULT_F1_CONFIG): number =>
  addedRatios(notes, root, triad, [d], thetaLow, cfg)[0];
