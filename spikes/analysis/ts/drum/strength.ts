/**
 * Spike 5 T7: strength -> ghost / normal / accent (docs/audio-spike5-plan.md section 2 "全段階で共通").
 *
 * Levels are relative to the take and computed PER INSTRUMENT (a BD and a HH have different band energies), in dB of
 * `strength` (an amplitude-like value >= 0; 0 counts as -240 dB):
 *   ref    = quantile(refPercentile) of the instrument's hits (the loud hits; robust to many ghosts, e.g. funk SD)
 *   ghost  = d < ref + ghostDb
 *   normal = quantile(normalPercentile) of the non-ghost hits (robust to many accents, e.g. accented HH quarters)
 *   accent = d >= normal + accentDb
 * An instrument with fewer than minHits hits gets no marks (too few to know its normal level). A take without ghosts
 * or accents gets no marks (no fixed share is forced). Quantiles interpolate linearly (numpy's default).
 */
import { DEFAULT_DRUM_CONFIG, type DrumConfig } from './config';
import type { DrumMark } from './types';

/** Linear-interpolated quantile of an ascending array (NaN when empty). */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const p = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

export const toDb = (s: number): number => 20 * Math.log10(Math.max(s, 1e-12));

export interface StrengthLevels {
  inst: string;
  n: number;
  /** Thresholds in dB: below ghostDb = ghost, at or above accentDb = accent. */
  ghostDb: number;
  accentDb: number;
}

/** marks[i] for hits[i] (undefined = normal) and the per-instrument thresholds (instruments in name order). */
export function strengthMarks(
  hits: readonly { inst: string; strength: number }[],
  cfg: DrumConfig['strength'] = DEFAULT_DRUM_CONFIG.strength,
): { marks: (DrumMark | undefined)[]; levels: StrengthLevels[] } {
  const byInst = new Map<string, number[]>();
  hits.forEach((h, i) => byInst.set(h.inst, [...(byInst.get(h.inst) ?? []), i]));
  const marks: (DrumMark | undefined)[] = hits.map(() => undefined);
  const levels: StrengthLevels[] = [];
  for (const inst of [...byInst.keys()].sort()) {
    const idx = byInst.get(inst)!;
    if (idx.length < cfg.minHits) continue;
    const db = idx.map((i) => toDb(hits[i].strength));
    const sorted = [...db].sort((a, b) => a - b);
    const ghostDb = quantile(sorted, cfg.refPercentile) + cfg.ghostDb;
    const accentDb = quantile(sorted.filter((d) => d >= ghostDb), cfg.normalPercentile) + cfg.accentDb;
    levels.push({ inst, n: idx.length, ghostDb, accentDb });
    idx.forEach((i, k) => {
      if (db[k] < ghostDb) marks[i] = 'g';
      else if (db[k] >= accentDb) marks[i] = 'ac';
    });
  }
  return { marks, levels };
}
