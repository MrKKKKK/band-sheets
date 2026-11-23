/**
 * Spike 8 T4: the octave-aware pitch front end F1 "harmonic sum + subtract" (docs/audio-spike8-plan.md §2.1).
 *
 *   y -> octaveCqt (ts/bass lowCqt with 7 octaves, C1-B7, semitone rows; called, not changed) -> per-beat mean spectrum
 *   (whitened: the CQT's sqrt(f) roll-off undone, so a partial's value is its amplitude) -> per beat, repeat:
 *     1. salience of every candidate C1-B5 = weighted mean of its harmonics h = 1..8 (g(h) = h^-p, harmonics above B7
 *        are not counted and the weights are renormalised: "届かない倍音は数えず個数でならす");
 *     2. phantom guard: the fundamental or an odd harmonic (3, 5, 7) must hold >= guard x the salience, so a note an
 *        octave (or two) below a real one, fed only by even harmonics, is never taken;
 *     3. take the best guarded candidate, then subtract its harmonics only up to a SMOOTH envelope (the mean of the
 *        neighbouring harmonics' amplitudes in the beat spectrum, Klapuri's estimate-and-subtract idea, written here
 *        from the published idea), so a partial shared with another note keeps that note's part;
 *     4. stop when the best salience < stopRatio x the first pick, or after maxNotes.
 * Output per beat: the picked notes (MIDI, salience at the pick) in pick order. Notes C1-B1 are not pitch output (plan:
 * output C2-B5); they count only as `lowest`. No ground truth is read here. No network: computation only.
 */
import type { MemTracker } from '../../dsp/core/mem';
import { cqtPlan } from '../../dsp/core/cqt';
import { LOW_HOP, LOW_SR, lowCqt, type LowCqt } from '../../bass/lowCqt';
import type { BassConfig } from '../../bass/config';
import { DEFAULT_F1_CONFIG, type F1Config } from './config';

export interface F1Note {
  midi: number;
  /** Salience at the pick (whitened CQT amplitude units, weighted mean over the harmonics). */
  s: number;
}
export interface F1Beat {
  start: number;
  end: number;
  /** Picked notes in pick order (C1-B5). */
  notes: F1Note[];
}

/** The 7-octave unfolded CQT of 22,050 Hz mono `y` (rows C1-B7). */
export function octaveCqt(y: Float32Array, cfg: F1Config = DEFAULT_F1_CONFIG, opts: { mem?: MemTracker; tuning?: number } = {}): LowCqt {
  return lowCqt(y, cfg.cqt, opts);
}

/**
 * The lower octaves of a wider CQT as the bass stage's LowCqt (no copy). Same fmin / bins per octave required. The values
 * equal the bass stage's own CQT (same decimation levels and kernels; `cli.ts share`, docs/audio-spike8-t4.md); use
 * bassCqtFrom, which also checks the column count.
 */
export function bassView(wide: LowCqt, bass: BassConfig['lowCqt'], f1: F1Config['cqt'] = DEFAULT_F1_CONFIG.cqt): LowCqt {
  if (bass.fminHz !== f1.fminHz || bass.binsPerOctave !== f1.binsPerOctave || bass.octaves > f1.octaves) throw new Error('bassView: the bass CQT is not the lower part of this CQT');
  const nSemis = bass.octaves * 12;
  return { ...wide, semi: wide.semi.subarray(0, nSemis * wide.cols), nSemis };
}

/**
 * The bass stage's CQT taken from the wide one when the column counts agree (the 7-octave plan has one column fewer
 * than the 5-octave plan for about 0.6 % of input lengths: the last frame), else computed on its own. Plan decision 10.
 */
export function bassCqtFrom(y: Float32Array, wide: LowCqt, bass: BassConfig['lowCqt'], opts: { mem?: MemTracker } = {}): LowCqt {
  const own = cqtPlan(y.length, { sr: LOW_SR, hop: LOW_HOP, fmin: bass.fminHz, nBins: bass.octaves * bass.binsPerOctave, bpo: bass.binsPerOctave, tuning: wide.tuning }).cols;
  return own === wide.cols ? bassView(wide, bass) : lowCqt(y, bass, { tuning: wide.tuning, mem: opts.mem });
}

/** Harmonic offsets in semitones, round(12 log2 h), h = 1..H. */
export const harmonicOffsets = (h: number): number[] => Array.from({ length: h }, (_, i) => Math.round(12 * Math.log2(i + 1)));

/**
 * Mean whitened spectrum per beat: row-major [nBeats, nSemis]. Beat i spans [beats[i], beats[i+1]) (the last one up to
 * `end`); a frame belongs to the beat its centre (t x frameSec) falls in. Gain 2^(row / 24) undoes the CQT's 1/sqrt(f)
 * level (measured: a constant-amplitude sine loses 1/sqrt(2) per octave), so harmonic amplitudes compare across rows.
 */
export function beatSpectra(low: LowCqt, beats: readonly number[], end: number): Float64Array {
  const nb = beats.length;
  const { nSemis, cols, semi, frameSec } = low;
  const out = new Float64Array(nb * nSemis);
  const gain = Float64Array.from({ length: nSemis }, (_, r) => 2 ** (r / 24));
  for (let i = 0; i < nb; i++) {
    const t0 = Math.max(0, Math.ceil(beats[i] / frameSec - 1e-9));
    const t1 = Math.min(cols, Math.ceil((i + 1 < nb ? beats[i + 1] : end) / frameSec - 1e-9));
    if (t1 <= t0) continue;
    for (let r = 0; r < nSemis; r++) {
      let s = 0;
      const row = r * cols;
      for (let t = t0; t < t1; t++) s += semi[row + t];
      out[i * nSemis + r] = (gain[r] * s) / (t1 - t0);
    }
  }
  return out;
}

export interface Prepared {
  offs: number[];
  w: number[];
}
const prepare = (cfg: F1Config): Prepared => {
  const offs = harmonicOffsets(cfg.harmonics);
  return { offs, w: offs.map((_, i) => (i + 1) ** -cfg.weightPow) };
};

/** Salience of candidate row c in the residual r (weighted mean over the in-range harmonics). */
function salienceAt(r: Float64Array, c: number, p: Prepared): number {
  let s = 0;
  let ws = 0;
  for (let h = 0; h < p.offs.length; h++) {
    const k = c + p.offs[h];
    if (k >= r.length) break;
    s += p.w[h] * r[k];
    ws += p.w[h];
  }
  return ws > 0 ? s / ws : 0;
}

/** Largest residual at the fundamental or an odd harmonic (h = 1, 3, 5, 7) of row c. */
function oddMax(r: Float64Array, c: number, p: Prepared): number {
  let m = 0;
  for (let h = 0; h < p.offs.length; h += 2) {
    const k = c + p.offs[h];
    if (k >= r.length) break;
    m = Math.max(m, r[k]);
  }
  return m;
}

/**
 * Subtract row c's harmonics from the residual r up to the smooth envelope: at harmonic h, min(r, mean of the BEAT
 * spectrum x at harmonics h-k..h+k). The envelope is read from x, not from r: an earlier pick (often the bass, whose
 * partials fall on the chord tones) has already taken part of this note's partials, and an envelope from r would then
 * leave this note's unshared partials (the 3rd partial of a 3rd = a false major 7th) standing.
 */
function subtract(r: Float64Array, x: ArrayLike<number>, c: number, p: Prepared, k: number): void {
  const amps: number[] = [];
  for (const o of p.offs) {
    if (c + o >= r.length) break;
    amps.push(x[c + o]);
  }
  amps.forEach((_, h) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, h - k); j <= Math.min(amps.length - 1, h + k); j++) {
      s += amps[j];
      n++;
    }
    const i = c + p.offs[h];
    r[i] -= Math.min(r[i], s / n);
  });
}

/**
 * F1 on one whitened beat spectrum `x` (rows from MIDI `midi0`; not changed). `floor` = the absolute salience below which
 * nothing is taken (0 = none). Returns the picked notes in pick order.
 */
export function estimateBeat(x: ArrayLike<number>, midi0: number, cfg: F1Config = DEFAULT_F1_CONFIG, floor = 0, p: Prepared = prepare(cfg)): F1Note[] {
  const r = Float64Array.from(x);
  const lo = Math.max(0, cfg.candLo - midi0);
  const hi = Math.min(r.length - 1, cfg.candHi - midi0);
  const notes: F1Note[] = [];
  const taken = new Set<number>();
  let first = 0;
  while (notes.length < cfg.maxNotes) {
    let best = -1;
    let bestSal = 0;
    for (let c = lo; c <= hi; c++) {
      if (taken.has(c)) continue;
      const s = salienceAt(r, c, p);
      if (s > bestSal && oddMax(r, c, p) >= cfg.guard * s) {
        best = c;
        bestSal = s;
      }
    }
    if (best < 0 || bestSal <= floor || (notes.length > 0 && bestSal < cfg.stopRatio * first)) break;
    if (notes.length === 0) first = bestSal;
    notes.push({ midi: midi0 + best, s: bestSal });
    taken.add(best);
    subtract(r, x, best, p, cfg.envHalfWidth);
  }
  return notes;
}

/** F1 over a whole signal's beats. The floor is floorRatio x the median first-pick salience of the file's beats. */
export function f1Beats(low: LowCqt, beats: readonly number[], end: number, cfg: F1Config = DEFAULT_F1_CONFIG): F1Beat[] {
  return f1FromSpectra(beatSpectra(low, beats, end), low.nSemis, low.midi0, beats, end, cfg);
}

/** f1Beats on precomputed beatSpectra (the tuning sweep reuses one spectrum per file). */
export function f1FromSpectra(spec: Float64Array, nSemis: number, midi0: number, beats: readonly number[], end: number, cfg: F1Config = DEFAULT_F1_CONFIG): F1Beat[] {
  const p = prepare(cfg);
  const row = (i: number) => spec.subarray(i * nSemis, (i + 1) * nSemis);
  const firsts = beats.map((_, i) => estimateBeat(row(i), midi0, { ...cfg, maxNotes: 1 }, 0, p)[0]?.s ?? 0);
  const sorted = [...firsts].sort((a, b) => a - b);
  const floor = cfg.floorRatio * (sorted.length ? sorted[sorted.length >> 1] : 0);
  return beats.map((b, i) => ({
    start: b,
    end: i + 1 < beats.length ? beats[i + 1] : end,
    notes: firsts[i] > floor ? estimateBeat(row(i), midi0, cfg, floor, p) : [],
  }));
}

/** The lowest picked note (C1 upward), or null. */
export const lowestNote = (notes: readonly F1Note[]): F1Note | null => notes.reduce<F1Note | null>((a, n) => (a === null || n.midi < a.midi ? n : a), null);

/** Strength per output semitone C2..B5 (index midi - outLo; 0 = not picked). */
export function strengthRow(notes: readonly F1Note[], cfg: F1Config = DEFAULT_F1_CONFIG): Float64Array {
  const out = new Float64Array(cfg.candHi - cfg.outLo + 1);
  for (const n of notes) if (n.midi >= cfg.outLo && n.midi <= cfg.candHi) out[n.midi - cfg.outLo] = n.s;
  return out;
}

/**
 * Pitch-class strength s(p) of plan §2.2 step 2: max over the output octaves (C2-B5) of the picked notes. With
 * `excludeLowest` the lowest picked note (the bass) is left out (the numerator of ρ); without it (the denominator) it
 * counts, also when it is below C2.
 */
export function pcStrength(notes: readonly F1Note[], excludeLowest: boolean, cfg: F1Config = DEFAULT_F1_CONFIG): Float64Array {
  const low = lowestNote(notes);
  const s = new Float64Array(12);
  for (const n of notes) {
    if (n === low ? excludeLowest : n.midi < cfg.outLo) continue;
    const pc = n.midi % 12;
    s[pc] = Math.max(s[pc], n.s);
  }
  return s;
}
