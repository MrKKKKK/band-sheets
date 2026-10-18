/**
 * Whole-song key: Krumhansl-Schmuckler profile correlation (port of py/dsp/keyest.py).
 *
 * Profiles: Krumhansl & Kessler (1982) probe-tone ratings (hand-set classic values, no training).
 * Default config (hash adec583eb3c6): analyze.py calls estimate_key(beat_chroma) — the per-beat chroma
 * [12, nBeats], not the chord columns.
 *
 * numpy parity: scores in KEYS order (majors C..B, then minors C..B); Python sorts by -score with a stable
 * sort, so on an exact tie the earlier key in KEYS wins (here: strict `>` scan in KEYS order). Sums use
 * numpy's pairwise order (pairwiseSum) where numpy uses it; dot products / norms go through BLAS in numpy, so
 * those agree to ~1e-16 relative, not bit-for-bit.
 */
import { NOTE_NAMES } from './chords';
import { pairwiseSum } from './core/npmath';

export const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
export const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;

export type Mode = 'major' | 'minor';
export const MODES: readonly Mode[] = ['major', 'minor'];

/** keyest.KEYS: (tonic, mode) for index 0..23 (majors 0-11, minors 12-23). */
export const KEYS: readonly (readonly [number, Mode])[] = [
  ...Array.from({ length: 12 }, (_, t) => [t, 'major'] as const),
  ...Array.from({ length: 12 }, (_, t) => [t, 'minor'] as const),
];

export interface GlobalKey {
  tonic: string; // NOTE_NAMES entry
  mode: Mode;
  confidence: number; // 0-1: gap between the best and the second-best correlation
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  const ma = pairwiseSum(a) / n;
  const mb = pairwiseSum(b) / n;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const d = Math.sqrt(saa) * Math.sqrt(sbb);
  return d > 0 ? sab / d : 0;
}

/** keyest.key_scores: correlation of a 12-bin pitch-class profile with each of the 24 key profiles (KEYS order). */
export function keyScores(pcp: ArrayLike<number>): Float64Array {
  const out = new Float64Array(24);
  const prof = new Float64Array(12);
  [MAJOR_PROFILE, MINOR_PROFILE].forEach((p, m) => {
    for (let tonic = 0; tonic < 12; tonic++) {
      for (let i = 0; i < 12; i++) prof[(i + tonic) % 12] = p[i]; // np.roll(prof, tonic)
      out[m * 12 + tonic] = corr(pcp, prof);
    }
  });
  return out;
}

/**
 * keyest.estimate_key on a [12, n] row-major chroma (per-beat). Silent / flat input -> C major, 0.
 */
export function estimateKey(chroma: ArrayLike<number>, n: number): GlobalKey {
  if (chroma.length !== 12 * n) throw new Error(`chroma has ${chroma.length} values, expected 12 x ${n}`);
  const pcp = new Float64Array(12);
  const row = new Float64Array(n);
  for (let j = 0; j < 12; j++) {
    for (let t = 0; t < n; t++) row[t] = Math.max(chroma[j * n + t], 0); // np.clip(c, 0, None)
    pcp[j] = pairwiseSum(row);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pcp) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (n === 0 || pairwiseSum(pcp) <= 0 || hi - lo <= 0) return { tonic: 'C', mode: 'major', confidence: 0 };
  const s = keyScores(pcp);
  // stable sort by -score: best = first max in KEYS order, second = first max among the rest
  let best = 0;
  for (let k = 1; k < 24; k++) if (s[k] > s[best]) best = k;
  let second = best === 0 ? 1 : 0;
  for (let k = 0; k < 24; k++) if (k !== best && s[k] > s[second]) second = k;
  const [tonic, mode] = KEYS[best];
  return { tonic: NOTE_NAMES[tonic], mode, confidence: Math.min(Math.max(s[best] - s[second], 0), 1) };
}
