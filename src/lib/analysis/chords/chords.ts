/**
 * Chord estimation from chroma columns (port of py/dsp/chords.py, DEFAULT path only: vocab v2, binary
 * templates, Viterbi, posterior confidence + candidates). Anything else in the Python config
 * (power, slash, bass_root, harmonics, median/none smoothing, seventh_mode 'segment', margin confidence)
 * throws in `checkConfig`.
 *
 *   estimateChords(chroma, n, cfg, {prior, perBeat}) -> ColumnChord[]   one per column
 *   mergeChords(chords, cfg, perBeat) -> ChordSegment[]
 *   mergeSegments(chords, cfg, perBeat) = merge + candidates (analyze._merge)
 *   chordName / chordText ('?' when confidence < low_confidence)
 *
 * Float choices follow Python: chroma is widened to float64, scores/Viterbi/posterior all float64.
 * Sums that numpy does along axis 0 are plain sequential adds over the 12 rows; mean() goes through
 * `pairwiseSum` (core/npmath). The template matmul (BLAS in numpy) is a plain 12-term sum, so scores can differ from
 * Python by an ulp; only exact score ties could notice (templates are 0/1 patterns, ties are real).
 *
 * Pass 1 (prior = null) consumes only `col_chroma` and `per_beat`: bounds/bass are used only by
 * bass_root/slash/harmonics, which are off in the default config (adec583eb3c6). Pass 2 takes the
 * theory prior ([nBeats or nCols, k, k] log bonus; computing it is harmony.ts, a later task).
 */
import { pairwiseSum } from '../core/npmath';
import { attachCandidates, chordPosterior, type Candidate } from './posterior';
import * as vocab from './vocab';
import type { ChordState } from './vocab';

export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;
const BETA = 20.0; // emission sharpness (hand-set)
const EIGHTH_EMIS = 0.75; // emission weight per half-beat column

export interface ChordsConfig extends vocab.VocabConfig {
  bass_root: 'none';
  bass_root_weight: number;
  candidates: boolean;
  candidates_k: number;
  confidence: 'posterior' | 'margin';
  harmonics: 'none';
  low_confidence: number;
  merge_min_beats: number;
  no_chord_energy: number;
  self_transition: number;
  seventh_margin: number;
  seventh_mode: 'beat';
  seventh_weight: number;
  slash: boolean;
  smoothing: 'viterbi';
}

/** chords section of the default config (config.json of the parity dumps, hash adec583eb3c6). */
export const DEFAULT_CHORDS_CONFIG: ChordsConfig = {
  bass_root: 'none',
  bass_root_weight: 0.0,
  candidates: true,
  candidates_k: 3,
  confidence: 'posterior',
  harmonics: 'none',
  low_confidence: 0.93,
  merge_min_beats: 1,
  no_chord_energy: 0.02,
  power: false,
  self_transition: 0.6,
  seventh_margin: 0.0,
  seventh_mode: 'beat',
  seventh_weight: 0.98,
  slash: false,
  smoothing: 'viterbi',
  use_seventh: true,
  vocab: 'v2',
  vocab_margin: 0.05,
  vocab_sus4_margin: 0.2,
  vocab_weight: 1.0,
};

export function checkConfig(cfg: ChordsConfig): void {
  const bad = (k: string, v: unknown) => {
    throw new Error(
      `chords.${k}=${String(v)} is not supported by the TS port (default path only)`,
    );
  };
  if (cfg.smoothing !== 'viterbi') bad('smoothing', cfg.smoothing);
  if (cfg.confidence !== 'posterior' && cfg.confidence !== 'margin')
    bad('confidence', cfg.confidence);
  if (cfg.harmonics !== 'none') bad('harmonics', cfg.harmonics);
  if (cfg.bass_root !== 'none') bad('bass_root', cfg.bass_root);
  if (cfg.seventh_mode !== 'beat') bad('seventh_mode', cfg.seventh_mode);
  if (cfg.slash) bad('slash', cfg.slash);
  if (cfg.power) bad('power', cfg.power);
  if (cfg.vocab !== 'v1' && cfg.vocab !== 'v2') bad('vocab', cfg.vocab);
  if (cfg.candidates_k < 1)
    throw new Error(
      `chords.candidates_k must be >= 1, got ${cfg.candidates_k}`,
    );
}

export interface ColumnChord {
  root: number | null; // 0-11, null = no chord
  quality: string;
  confidence: number;
  bass: number | null;
  /** (nStates,) posterior of this column over vocab.states(cfg); null when posterior was not computed. */
  posterior: Float64Array | null;
}

export interface ChordSegment {
  startBeat: number;
  endBeat: number; // exclusive
  root: number | null;
  quality: string;
  confidence: number; // mean over the segment's columns
  lowConfidence: boolean;
  bass: number | null;
  candidates: Candidate[];
  perBeat: number;
}

export function chordName(
  root: number | null,
  quality: string,
  bass: number | null = null,
): string {
  if (root === null) return 'N';
  let name = NOTE_NAMES[root % 12] + vocab.suffix(quality);
  if (bass !== null && bass % 12 !== root % 12)
    name += '/' + NOTE_NAMES[bass % 12];
  return name;
}

export function chordText(
  bc: Pick<ColumnChord, 'root' | 'quality' | 'bass' | 'confidence'>,
  cfg: ChordsConfig,
): string {
  let name = chordName(bc.root, bc.quality, bc.bass);
  if (bc.root !== null && bc.confidence < cfg.low_confidence) name += '?';
  return name;
}

const isSeventh = (quality: string): boolean =>
  vocab.intervals(quality).length === 4;

/** Weighted cosine scores [nStates, n] with disallowed sevenths set to 0 (chords._scores). */
function scores(
  chroma: Float64Array,
  n: number,
  sts: readonly ChordState[],
  cfg: ChordsConfig,
): Float64Array {
  const k = sts.length;
  // unit = chroma / where(norm > 0, norm, 1); norm = sqrt of sequential row sum of squares
  const unit = new Float64Array(12 * n);
  for (let t = 0; t < n; t++) {
    let sq = 0;
    for (let j = 0; j < 12; j++) sq += chroma[j * n + t] * chroma[j * n + t];
    const norm = Math.sqrt(sq);
    const d = norm > 0 ? norm : 1.0;
    for (let j = 0; j < 12; j++) unit[j * n + t] = chroma[j * n + t] / d;
  }
  // binary templates, unit norm: 1/sqrt(#tones)
  const s = new Float64Array(k * n);
  for (let i = 0; i < k; i++) {
    const iv = vocab.intervals(sts[i].quality);
    const w = 1.0 / Math.sqrt(iv.length);
    const tones = iv.map((x) => (sts[i].root + x) % 12).sort((a, b) => a - b);
    for (let t = 0; t < n; t++) {
      let acc = 0;
      for (const j of tones) acc += w * unit[j * n + t];
      s[i * n + t] = acc;
    }
  }
  vocab.gateScores(s, unit, sts, n, cfg);
  const sev = sts.map((st) => isSeventh(st.quality));
  if (sev.some(Boolean)) {
    for (let t = 0; t < n; t++) {
      let bestTriad = -Infinity;
      for (let i = 0; i < k; i++)
        if (!sev[i]) bestTriad = Math.max(bestTriad, s[i * n + t]);
      for (let i = 0; i < k; i++) {
        if (!sev[i]) continue;
        const s7 = s[i * n + t] * cfg.seventh_weight;
        s[i * n + t] = s7 >= bestTriad + cfg.seventh_margin ? s7 : 0;
      }
    }
  }
  return s;
}

/**
 * Best path. `prior` = log bonus per move, [nPriorRows, k, k] flattened (rows repeat per column when
 * nPriorRows * perBeat == n); null / all zero -> the fast path. Ties: stay first, then the lowest state.
 */
function viterbi(
  emis: Float64Array,
  k: number,
  n: number,
  stay0: number,
  prior: Prior | null,
  perBeat: number,
  nMove: number,
): Int32Array {
  const m = nMove;
  const stay = Math.min(Math.max(stay0, 1 / m + 1e-9), 1 - 1e-9);
  const lStay = Math.log(stay);
  const lMove = Math.log((1 - stay) / (m - 1));
  const logp = new Float64Array(k * n);
  for (let i = 0; i < k * n; i++) logp[i] = BETA * emis[i];
  let usePrior = false;
  let provider: PriorRows | null = null;
  let flatPrior: Float32Array | Float64Array | null = null; // flat form: index with a row offset, no subarray
  if (prior) {
    if ('row' in prior) {
      provider = prior;
      usePrior = !(prior.isZero?.() ?? false);
    } else {
      const flat = prior;
      for (let i = 0; i < flat.length; i++)
        if (flat[i] !== 0) {
          usePrior = true;
          break;
        }
      flatPrior = flat;
      provider = { rows: flat.length / (k * k), row: () => flat };
    }
  }
  let rowDiv = 1; // columns per prior row
  if (usePrior && provider) {
    const rows = provider.rows;
    if (rows === n) rowDiv = 1;
    else if (perBeat > 1 && rows * perBeat === n)
      rowDiv = perBeat; // beat-level prior: repeated per column
    else throw new Error(`prior has ${rows} rows != ${n} columns`);
  }
  let delta = new Float64Array(k);
  for (let i = 0; i < k; i++) delta[i] = logp[i * n];
  const back = new Int32Array(k * n);
  const next = new Float64Array(k);
  for (let t = 1; t < n; t++) {
    if (!usePrior) {
      let bestPrev = 0;
      for (let i = 1; i < k; i++) if (delta[i] > delta[bestPrev]) bestPrev = i;
      const move = delta[bestPrev] + lMove;
      for (let j = 0; j < k; j++) {
        const stayV = delta[j] + lStay;
        const useStay = stayV >= move;
        back[j * n + t] = useStay ? j : bestPrev;
        next[j] = (useStay ? stayV : move) + logp[j * n + t];
      }
    } else {
      const r = Math.floor(t / rowDiv);
      const P = flatPrior ?? (provider as PriorRows).row(r);
      const o = flatPrior ? r * k * k : 0;
      for (let j = 0; j < k; j++) {
        // cand[i][j] = delta[i] + trans[i][j] + prior[t][i][j]; argmax over i, first max wins
        let bestI = 0;
        let bestV = -Infinity;
        for (let i = 0; i < k; i++) {
          const c = delta[i] + (i === j ? lStay : lMove) + P[o + i * k + j];
          if (c > bestV) {
            bestV = c;
            bestI = i;
          }
        }
        const stayC = delta[j] + lStay + P[o + j * k + j];
        const b = stayC >= bestV ? j : bestI;
        back[j * n + t] = b;
        next[j] = (b === j ? stayC : bestV) + logp[j * n + t];
      }
    }
    delta = Float64Array.from(next);
  }
  const path = new Int32Array(n);
  let last = 0;
  for (let i = 1; i < k; i++) if (delta[i] > delta[last]) last = i;
  path[n - 1] = last;
  for (let t = n - 1; t > 0; t--) path[t - 1] = back[path[t] * n + t];
  return path;
}

/** Lazy prior: `rows` rows of a [k, k] log-bonus matrix (flattened, index i * k + j = from i to j). */
export interface PriorRows {
  rows: number;
  row(r: number): ArrayLike<number>;
  /** true -> the prior is all zero (fast path). Without it the prior is assumed non-zero. */
  isZero?(): boolean;
}
export type Prior = Float32Array | Float64Array | PriorRows;

export interface EstimateOptions {
  /** 2nd-pass theory prior [rows, k, k] flattened; rows == n columns or n / perBeat beats. */
  prior?: Prior | null;
  perBeat?: number;
}

/** One ColumnChord per chroma column. `chroma` is row-major [12, n]. */
export function estimateChords(
  chroma: ArrayLike<number>,
  n: number,
  cfg: ChordsConfig,
  opts: EstimateOptions = {},
): ColumnChord[] {
  checkConfig(cfg);
  if (n === 0) return [];
  const perBeat = opts.perBeat ?? 1;
  if (perBeat < 1 || n % perBeat)
    throw new Error(`${n} columns is not a multiple of per_beat ${perBeat}`);
  if (chroma.length !== 12 * n)
    throw new Error(`chroma length ${chroma.length} != 12 * ${n}`);
  const c64 = Float64Array.from(chroma);
  const stay =
    perBeat === 1
      ? cfg.self_transition
      : Math.pow(cfg.self_transition, 1.0 / perBeat);
  const emisW = perBeat === 1 ? 1.0 : EIGHTH_EMIS;
  const sts = vocab.states(cfg);
  const k = sts.length;
  const s = scores(c64, n, sts, cfg);
  const silent = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    let e = c64[t];
    for (let j = 1; j < 12; j++) e += c64[j * n + t];
    if (e < cfg.no_chord_energy) {
      silent[t] = 1;
      for (let i = 0; i < k; i++) s[i * n + t] = 0;
    }
  }
  const nMove = vocab.moveStates(cfg);
  let emis = s;
  if (perBeat > 1) {
    emis = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) emis[i] = s[i] * emisW;
  }
  const path = viterbi(emis, k, n, stay, opts.prior ?? null, perBeat, nMove);
  const wantPost = cfg.confidence === 'posterior' || cfg.candidates;
  const post = !wantPost
    ? null
    : chordPosterior(
        (() => {
          const e = new Float64Array(s.length);
          const f = perBeat > 1 ? BETA * emisW : BETA;
          for (let i = 0; i < s.length; i++) e[i] = f * s[i];
          return e;
        })(),
        k,
        n,
        stay,
        nMove,
      );
  const out: ColumnChord[] = [];
  for (let t = 0; t < n; t++) {
    let col: Float64Array | null = null;
    if (post && cfg.candidates) {
      col = new Float64Array(k);
      for (let i = 0; i < k; i++) col[i] = post[i * n + t];
    }
    if (silent[t]) {
      out.push({
        root: null,
        quality: 'maj',
        confidence: 1.0,
        bass: null,
        posterior: col,
      });
      continue;
    }
    const st = sts[path[t]];
    let conf: number;
    if (post && cfg.confidence === 'posterior') conf = post[path[t] * n + t];
    else {
      // margin: chosen score minus the best score among states with a different root
      let other = -Infinity;
      for (let i = 0; i < k; i++)
        if (sts[i].root !== st.root) other = Math.max(other, s[i * n + t]);
      conf = s[path[t] * n + t] - (other === -Infinity ? 0 : other);
    }
    out.push({
      root: st.root,
      quality: st.quality,
      confidence: Math.min(Math.max(conf, 0), 1),
      bass: null,
      posterior: col,
    });
  }
  return out;
}

/**
 * The beat-level chords the downbeat rule sees (py downbeat.downbeat_chords, default config): a separate
 * pass over the per-beat chroma `beat_chroma` [12, nBeats], 1 column per beat, MARGIN confidence, no
 * posterior/candidates, other chord settings unchanged.
 */
export function downbeatChords(
  beatChroma: ArrayLike<number>,
  nBeats: number,
  cfg: ChordsConfig,
): ColumnChord[] {
  return estimateChords(
    beatChroma,
    nBeats,
    { ...cfg, confidence: 'margin', candidates: false },
    { perBeat: 1 },
  );
}

/** The on-beat column of each beat (perBeat 1: as is). */
export function beatLevel<T>(chords: T[], perBeat = 1): T[] {
  if (perBeat === 1) return chords;
  if (chords.length % perBeat)
    throw new Error(
      `${chords.length} columns is not a multiple of per_beat ${perBeat}`,
    );
  return chords.filter((_, i) => i % perBeat === 0);
}

interface Run {
  a: number;
  b: number;
  root: number | null;
  quality: string;
}

/** Merge consecutive equal chords; runs shorter than merge_min_beats join the longer neighbour (previous on a tie). */
export function mergeChords(
  chords: readonly ColumnChord[],
  cfg: ChordsConfig,
  perBeat = 1,
): ChordSegment[] {
  if (chords.length === 0) return [];
  let runs: Run[] = [];
  chords.forEach((c, i) => {
    const quality = c.root !== null ? c.quality : 'maj';
    const last = runs[runs.length - 1];
    if (last && last.root === c.root && last.quality === quality)
      last.b = i + 1;
    else runs.push({ a: i, b: i + 1, root: c.root, quality });
  });
  const mn = cfg.merge_min_beats;
  while (runs.length > 1) {
    let k = -1;
    runs.forEach((r, j) => {
      if (r.b - r.a >= mn) return;
      if (k < 0 || r.b - r.a < runs[k].b - runs[k].a) k = j;
    });
    if (k < 0) break;
    const prevLen = k > 0 ? runs[k - 1].b - runs[k - 1].a : -1;
    const nextLen = k + 1 < runs.length ? runs[k + 1].b - runs[k + 1].a : -1;
    const tgt = prevLen >= nextLen ? k - 1 : k + 1;
    runs[tgt].a = Math.min(runs[tgt].a, runs[k].a);
    runs[tgt].b = Math.max(runs[tgt].b, runs[k].b);
    runs.splice(k, 1);
    const merged: Run[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.root === r.root && last.quality === r.quality)
        last.b = r.b;
      else merged.push(r);
    }
    runs = merged;
  }
  const confs = Float64Array.from(chords, (c) => c.confidence);
  return runs.map((r) => {
    const conf = pairwiseSum(confs, r.a, r.b - r.a) / (r.b - r.a);
    return {
      startBeat: r.a,
      endBeat: r.b,
      root: r.root,
      quality: r.quality,
      confidence: conf,
      lowConfidence: r.root !== null && conf < cfg.low_confidence,
      bass: null,
      candidates: [],
      perBeat,
    };
  });
}

/** analyze._merge on the default path: merge, then candidates from the column posteriors. */
export function mergeSegments(
  chords: readonly ColumnChord[],
  cfg: ChordsConfig,
  perBeat = 1,
): ChordSegment[] {
  const segs = mergeChords(chords, cfg, perBeat);
  return attachCandidates(
    segs,
    chords.map((c) => c.posterior),
    cfg,
  );
}
