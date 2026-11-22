/**
 * Test support only (T17): T9's segment-level form of the identical-pair post-pass (the form analyze() applied before
 * T17 removed it so that pipeline.ts pairsAfterBass is the one place the rule runs in the app-side code). Keeps the
 * T9 golden / behaviour tests meaningful: the same segments, bass points and decisions as before.
 */
import type { BarKey } from '../dsp/keytrack';
import type { Chords2Output } from './analyze';
import type { Chords2Config } from './config';
import { applyDecisions, resolvePairs, segmentBassPc, segmentKeys } from './pairRule';

/** `out` (analyze() with pairRule off) with the pair rule `rule` applied to its segments, as analyze() did in T9. */
export function withPairRule(out: Chords2Output, cfg: Chords2Config, rule: 'off' | 'context' | 'bassRoot', barKeys: readonly BarKey[], barOfBeat: ArrayLike<number>): Chords2Output {
  if (rule === 'off') return out;
  const bass = out.segments.map((s) => segmentBassPc(s, cfg.bass.method));
  const keys = segmentKeys(out.segments, barKeys, barOfBeat);
  const decisions = resolvePairs(out.segments.map((s, i) => ({ root: s.root, quality: s.quality, bass: bass[i], key: keys[i] })), rule, cfg.stage);
  return { ...out, segments: applyDecisions(out.segments, decisions, bass) };
}
