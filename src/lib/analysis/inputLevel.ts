/**
 * Input loudness normalisation for the chord analyzer (issue #96): one gain for the whole signal so its RMS is
 * TARGET_RMS_DB, capped so the peak stays at or below PEAK_CEILING_DB. The analyzer's thresholds were tuned on
 * material around -22 dBFS RMS, and quiet recordings lost their chords without it.
 *
 * The numbers and the formula come from spike 6 R3 (`docs/audio-spike6-r2.md` on the research branch;
 * `levelDb` / `normalizeGainDb` in its `rec_eval.ts`). This file is app-side code, NOT copied from the research
 * branch, and sits outside the frozen `chords/` directory (so the analyzer config hash is unchanged).
 */

/** Median whole-file RMS (dBFS) of the synthetic tuning split (spike 6 R3). */
export const TARGET_RMS_DB = -22;
/** The peak never ends above this after normalising (spike 6 R3). */
export const PEAK_CEILING_DB = -1;

const dbOf = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

/** Whole-array RMS and peak in dBFS (floored at -240 dB, so never -Infinity). */
export function levelDb(y: Float32Array): { rmsDb: number; peakDb: number } {
  let ss = 0;
  let pk = 0;
  for (let i = 0; i < y.length; i++) {
    ss += y[i] * y[i];
    pk = Math.max(pk, Math.abs(y[i]));
  }
  return {
    rmsDb: dbOf(Math.sqrt(ss / Math.max(1, y.length))),
    peakDb: dbOf(pk),
  };
}

/** Gain (dB) that brings the RMS to `targetDb`, capped so the peak stays at or below `ceilingDb`. May be negative. */
export const normalizeGainDb = (
  rmsDb: number,
  peakDb: number,
  targetDb: number = TARGET_RMS_DB,
  ceilingDb: number = PEAK_CEILING_DB,
): number => Math.min(targetDb - rmsDb, ceilingDb - peakDb);

/**
 * Applies the normalising gain to `y` in place and returns the dB applied. Empty, all-zero or non-finite input
 * is left untouched (returns 0); a gain of exactly 0 leaves the samples bit-identical.
 */
export function normalizeLevel(y: Float32Array): number {
  const { rmsDb, peakDb } = levelDb(y);
  // empty / all-zero (floored) / NaN / Infinity: nothing to normalise
  if (!Number.isFinite(rmsDb) || !Number.isFinite(peakDb) || peakDb <= -240)
    return 0;
  const g = normalizeGainDb(rmsDb, peakDb);
  if (g === 0) return 0;
  const k = 10 ** (g / 20);
  for (let i = 0; i < y.length; i++) y[i] *= k;
  return g;
}
