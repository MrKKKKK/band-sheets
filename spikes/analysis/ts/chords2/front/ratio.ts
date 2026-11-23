/**
 * Spike 8 T4: the added-tone ratio ρ(d) of plan §2.2 steps 2-4 on one beat's F1 notes, used by T4's unit tests and the
 * front-end accuracy table (docs/audio-spike8-t4.md). D2 (T5) builds its decision on this function rather than copying
 * the formula:
 *   s(p)    = pcStrength (max over octaves; the lowest picked note left out of the numerator, kept in the denominator)
 *   denom   = mean s over the triad's tones that sound (s >= thetaLow x the beat's max s; the bass included)
 *   ρ(d)    = s_numerator(root + d) / denom (0 when no triad tone sounds)
 */
import { DEFAULT_F1_CONFIG, type F1Config } from './config';
import { pcStrength, type F1Note } from './f1';

/** ρ(d) for root pitch class `root`, triad intervals `triad` (e.g. [0, 4, 7]) and the added interval `d`. */
export function addedRatio(notes: readonly F1Note[], root: number, triad: readonly number[], d: number, cfg: F1Config = DEFAULT_F1_CONFIG): number {
  const all = pcStrength(notes, false, cfg);
  const max = Math.max(...all);
  if (max <= 0) return 0;
  const on = triad.map((iv) => all[(root + iv) % 12]).filter((s) => s >= cfg.thetaLow * max);
  if (on.length === 0) return 0;
  const denom = on.reduce((a, b) => a + b, 0) / on.length;
  return pcStrength(notes, true, cfg)[(root + d) % 12] / denom;
}
