/**
 * Spike 7 T3: the chord analyzer v2 entry (plan §2.0, decision U1).
 *
 * analyze(input, cfg) re-solves the chord Viterbi over the stage's expanded state space (vocab.states) from the
 * per-column chroma, with the 2nd-pass theory prior (prior.FamilyPrior) from v1a's per-bar keys and bar numbers.
 * Beats, chroma, downbeats and keys are v1a's (the caller runs ts/dsp up to keytrack); only the chord stage is new.
 * With stage V0 it is estimateChordsPass2 of v1a bit for bit (chords2.golden.test.ts).
 * Reused from v1a by import: vocab.gateScores (V0 states), chordPosterior, mergeChords, segmentCandidates.
 * New code only where v2 differs: multi-template scores, the gate for the new qualities, the Viterbi over the
 * expanded states (a copy of v1a's, which is not exported and frozen), names.
 */
import { checkConfig, mergeChords, NOTE_NAMES, type ColumnChord, type PriorRows } from '../dsp/chords';
import type { MemTracker } from '../dsp/core/mem';
import type { BarKey } from '../dsp/keytrack';
import { chordPosterior, segmentCandidates } from '../dsp/posterior';
import * as v1 from '../dsp/vocab';
import type { ChordState } from '../dsp/vocab';
import { bassValues, type Chords2Config } from './config';
import { collapsePosterior, ExpandedPrior, m2Expand, scoreChroma } from './bass';
import type { Chords2Segment } from './pairRule';
import { addedCandidates, applyD2, d2Candidates } from './d2';
import type { F1Beat } from './front/f1';
import { FamilyPrior } from './prior';
import * as vocab from './vocab';

// Copies of v1a's hand-set emission constants (not exported from the frozen ts/dsp/chords.ts); the V0 golden test
// fails if they drift.
const BETA = 20.0;
const EIGHTH_EMIS = 0.75;

export interface Chords2Input {
  /** Per-column chroma, row-major [12, n] (v1a cols.cChroma). */
  chroma: ArrayLike<number>;
  n: number;
  perBeat: number;
  /** Per-bar keys of v1a's keytrack and the bar of each beat (length n / perBeat). */
  barKeys: readonly BarKey[];
  barOfBeat: ArrayLike<number>;
  /** v1a's bass-band chroma (C1-B3) per chord column, row-major [12, n]: needed by bass.method M1 (T8, bass.ts). */
  bassChroma?: ArrayLike<number>;
  /** F1's per-beat output folded to 12 pitch classes, row-major [12, n] (octaveChroma.ts foldF1): needed by cfg.octaveChroma (D1). */
  f1Chroma?: ArrayLike<number>;
  /** F1's notes per beat (n / perBeat entries; front/f1.ts f1Beats): needed by cfg.d2 (D2, d2.ts). */
  f1Beats?: readonly F1Beat[];
  mem?: MemTracker;
}

export interface Chords2Output {
  columns: ColumnChord[];
  /**
   * `chordCandidates` (shown before the top-k) is set only by D2 (cfg.d2: its candidates and the identical pair's other
   * reading); the identical-pair rule, which also sets it, is not run here (pipeline.ts pairsAfterBass does)
   */
  segments: Chords2Segment[];
  states: ChordState[];
}

export function chordName(root: number | null, quality: string, bass: number | null = null): string {
  if (root === null) return 'N';
  let name = NOTE_NAMES[root % 12] + vocab.suffix(quality);
  if (bass !== null && bass % 12 !== root % 12) name += '/' + NOTE_NAMES[bass % 12];
  return name;
}

function checkSwitches(cfg: Chords2Config): void {
  checkConfig(cfg.chords);
  if (cfg.chords.confidence !== 'posterior') throw new Error('chords2: only chords.confidence=posterior is supported');
  // One place applies the identical-pair rule (T17): pipeline.ts pairsAfterBass, after the bass marks (T10's form).
  if (cfg.pairRule !== 'off') throw new Error("chords2: analyze() does not apply pairRule; use pipeline.ts pairsAfterBass (config.ts PairRule)");
  if (cfg.d2 && cfg.stage !== 'V0') throw new Error('chords2: d2 reads the V0 Viterbi (plan §2.2), stage must be V0');
}

/** Weighted cosine scores [nStates, n] (chords._scores with the new qualities and multi-template states). */
function scores(chroma: Float64Array, n: number, sts: readonly ChordState[], cfg: Chords2Config): Float64Array {
  const c = cfg.chords;
  const k = sts.length;
  const unit = new Float64Array(12 * n);
  for (let t = 0; t < n; t++) {
    let sq = 0;
    for (let j = 0; j < 12; j++) sq += chroma[j * n + t] * chroma[j * n + t];
    const norm = Math.sqrt(sq);
    const d = norm > 0 ? norm : 1.0;
    for (let j = 0; j < 12; j++) unit[j * n + t] = chroma[j * n + t] / d;
  }
  const s = new Float64Array(k * n);
  const nTones = new Int32Array(k); // largest template of the state
  for (let i = 0; i < k; i++) {
    let first = true;
    for (const iv of vocab.templates(sts[i].quality)) {
      nTones[i] = Math.max(nTones[i], iv.length);
      const w = 1.0 / Math.sqrt(iv.length);
      const tones = iv.map((x) => (sts[i].root + x) % 12).sort((a, b) => a - b);
      for (let t = 0; t < n; t++) {
        let acc = 0;
        for (const j of tones) acc += w * unit[j * n + t];
        s[i * n + t] = first ? acc : Math.max(s[i * n + t], acc);
      }
      first = false;
    }
  }
  // v1a gate on the v1a states (they come first, so their rows are the head of s), then the same clear-win gate
  // for the new qualities against the best base (maj / min / 7 / maj7 / min7) score.
  const n0 = vocab.states('V0', c).length;
  v1.gateScores(s.subarray(0, n0 * n), unit, sts.slice(0, n0), n, c);
  if (k > n0) {
    const base = sts.slice(0, n0).map((st) => !v1.isExtra(st.quality));
    for (let t = 0; t < n; t++) {
      let bestBase = -Infinity;
      for (let i = 0; i < n0; i++) if (base[i]) bestBase = Math.max(bestBase, s[i * n + t]);
      for (let i = n0; i < k; i++) {
        const se = s[i * n + t] * c.vocab_weight;
        s[i * n + t] = se >= bestBase + cfg.newQualityMargin ? se : 0;
      }
    }
  }
  // seventh gate: v1a's 4-note states plus the new states with a template of 4 or more notes; the new states use
  // cfg.newSeventh when set (T10), else v1a's seventh_weight / seventh_margin
  const sev = sts.map((st, i) => (i < n0 ? v1.intervals(st.quality).length === 4 : nTones[i] >= 4));
  const sevW = (i: number) => (i >= n0 && cfg.newSeventh ? cfg.newSeventh.weight : c.seventh_weight);
  const sevM = (i: number) => (i >= n0 && cfg.newSeventh ? cfg.newSeventh.margin : c.seventh_margin);
  if (sev.some(Boolean)) {
    for (let t = 0; t < n; t++) {
      let bestTriad = -Infinity;
      for (let i = 0; i < k; i++) if (!sev[i]) bestTriad = Math.max(bestTriad, s[i * n + t]);
      for (let i = 0; i < k; i++) {
        if (!sev[i]) continue;
        const s7 = s[i * n + t] * sevW(i);
        s[i * n + t] = s7 >= bestTriad + sevM(i) ? s7 : 0;
      }
    }
  }
  return s;
}

/** Best path (copy of v1a's chords.viterbi, which is not exported; ties: stay first, then the lowest state). */
function viterbi(emis: Float64Array, k: number, n: number, stay0: number, prior: PriorRows | null, perBeat: number, nMove: number): Int32Array {
  const m = nMove;
  const stay = Math.min(Math.max(stay0, 1 / m + 1e-9), 1 - 1e-9);
  const lStay = Math.log(stay);
  const lMove = Math.log((1 - stay) / (m - 1));
  const logp = new Float64Array(k * n);
  for (let i = 0; i < k * n; i++) logp[i] = BETA * emis[i];
  const usePrior = prior !== null && !(prior.isZero?.() ?? false);
  let rowDiv = 1;
  if (usePrior && prior) {
    if (prior.rows === n) rowDiv = 1;
    else if (perBeat > 1 && prior.rows * perBeat === n) rowDiv = perBeat;
    else throw new Error(`prior has ${prior.rows} rows != ${n} columns`);
  }
  let delta = new Float64Array(k);
  for (let i = 0; i < k; i++) delta[i] = logp[i * n];
  const back = new Int32Array(k * n);
  const next = new Float64Array(k);
  for (let t = 1; t < n; t++) {
    if (!usePrior || !prior) {
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
      const P = prior.row(Math.floor(t / rowDiv));
      for (let j = 0; j < k; j++) {
        let bestI = 0;
        let bestV = -Infinity;
        for (let i = 0; i < k; i++) {
          const c = delta[i] + (i === j ? lStay : lMove) + P[i * k + j];
          if (c > bestV) {
            bestV = c;
            bestI = i;
          }
        }
        const stayC = delta[j] + lStay + P[j * k + j];
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

/** One ColumnChord per column over the stage's state space (estimateChordsPass2 of v1a, expanded). */
export function estimateColumns(input: Chords2Input, cfg: Chords2Config): { columns: ColumnChord[]; states: ChordState[] } {
  checkSwitches(cfg);
  const { n, perBeat } = input;
  const c = cfg.chords;
  const sts = vocab.states(cfg.stage, c);
  if (n === 0) return { columns: [], states: sts };
  if (perBeat < 1 || n % perBeat) throw new Error(`${n} columns is not a multiple of per_beat ${perBeat}`);
  if (input.chroma.length !== 12 * n) throw new Error(`chroma length ${input.chroma.length} != 12 * ${n}`);
  if (input.barOfBeat.length * perBeat !== n) throw new Error(`barOfBeat has ${input.barOfBeat.length} beats for ${n} columns at perBeat ${perBeat}`);
  const c64 = Float64Array.from(input.chroma);
  const stay = perBeat === 1 ? c.self_transition : Math.pow(c.self_transition, 1.0 / perBeat);
  const emisW = perBeat === 1 ? 1.0 : EIGHTH_EMIS;
  const k = sts.length;
  if (cfg.octaveChroma && (!input.f1Chroma || input.f1Chroma.length !== 12 * n)) throw new Error(`chords2: octaveChroma needs input.f1Chroma of length 12 * ${n}`);
  // D1: the templates are scored on F1's folded chroma instead of v1a's (the silence test below still reads v1a's)
  const s = scores(cfg.octaveChroma ? Float64Array.from(input.f1Chroma as ArrayLike<number>) : scoreChroma(c64, input.bassChroma, cfg), n, sts, cfg); // M1: the bass band taken out (bass.ts); no-chord test below reads the full chroma
  const silent = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    let e = c64[t];
    for (let j = 1; j < 12; j++) e += c64[j * n + t];
    if (e < c.no_chord_energy) {
      silent[t] = 1;
      for (let i = 0; i < k; i++) s[i * n + t] = 0;
    }
  }
  const nMove = v1.moveStates(c);
  const emis = perBeat > 1 ? s.map((v) => v * emisW) : s;
  const prior = new FamilyPrior(sts, input.barKeys, input.barOfBeat, cfg.theoryPrior, input.mem);
  const f = perBeat > 1 ? BETA * emisW : BETA;
  let path: Int32Array;
  let post: Float64Array;
  if (cfg.bass.method === 'M2') {
    // M2 (bass.ts): states (chord, bass tone); the decoded chord is the state's base, the posterior summed per base
    const ex = m2Expand(s, sts, input.bassChroma, n, bassValues(cfg));
    const nMoveE = Math.round((nMove * ex.k) / k);
    const pathE = viterbi(perBeat > 1 ? ex.emis.map((v) => v * emisW) : ex.emis, ex.k, n, stay, prior.isZero() ? null : new ExpandedPrior(prior, ex.base, k), perBeat, nMoveE);
    path = pathE.map((i) => ex.base[i]);
    post = collapsePosterior(chordPosterior(ex.emis.map((v) => f * v), ex.k, n, stay, nMoveE), ex.base, k, n);
  } else {
    path = viterbi(emis, k, n, stay, prior.isZero() ? null : prior, perBeat, nMove);
    post = chordPosterior(s.map((v) => f * v), k, n, stay, nMove);
  }
  const columns: ColumnChord[] = [];
  for (let t = 0; t < n; t++) {
    const col = new Float64Array(k);
    for (let i = 0; i < k; i++) col[i] = post[i * n + t];
    if (silent[t]) {
      columns.push({ root: null, quality: 'maj', confidence: 1.0, bass: null, posterior: col });
      continue;
    }
    const st = sts[path[t]];
    columns.push({ root: st.root, quality: st.quality, confidence: Math.min(Math.max(post[path[t] * n + t], 0), 1), bass: null, posterior: col });
  }
  return { columns, states: sts };
}

/**
 * The v2 chord stage: columns, merged segments (with the top-k candidates), and the state list. With cfg.d2 the V0
 * columns get D2's added tones (d2.ts) before they are merged, and the segments D2's readings in `chordCandidates`.
 */
export function analyze(input: Chords2Input, cfg: Chords2Config): Chords2Output {
  const est = estimateColumns(input, cfg);
  const { states } = est;
  let d2: ReturnType<typeof applyD2> | null = null;
  if (cfg.d2) {
    if (!input.f1Beats || !cfg.f1) throw new Error('chords2: d2 needs input.f1Beats and cfg.f1 (resolveChords2Config sets f1)');
    // output 'candidate' (spike 8 G1 §1): the V0 columns are not rewritten (no applyD2: no renaming, no HMM)
    if (cfg.d2.output !== 'candidate') d2 = applyD2(est.columns, input.f1Beats, input.perBeat, cfg.d2, cfg.f1);
  }
  const columns = d2 ? d2.columns : est.columns;
  const segs = mergeChords(columns, cfg.chords, input.perBeat);
  const n = columns.length;
  const k = states.length;
  let segments: Chords2Segment[] = segs;
  if (cfg.chords.candidates && n > 0) {
    const post = new Float64Array(k * n);
    for (let t = 0; t < n; t++) {
      const col = columns[t].posterior as Float64Array;
      for (let i = 0; i < k; i++) post[i * n + t] = col[i];
    }
    segments = segs.map((seg) =>
      seg.root === null ? seg : { ...seg, candidates: segmentCandidates(post, states, n, seg.startBeat, seg.endBeat, cfg.chords.candidates_k) },
    );
  }
  if (cfg.d2?.output === 'candidate') {
    // the added tone's reading per segment (before the bass stage), shown with the top-k as `chordCandidates`
    if (input.f1Beats!.length * input.perBeat !== n) throw new Error(`chords2: ${input.f1Beats!.length} F1 beats for ${n} columns at perBeat ${input.perBeat}`);
    const added = addedCandidates(segs, input.f1Beats!, input.perBeat, cfg.d2, cfg.f1!);
    segments = segments.map((seg, i) => (added[i].length ? { ...seg, chordCandidates: added[i] } : seg));
  } else if (d2 && cfg.d2) {
    const { cands } = d2;
    const range = cfg.d2.range;
    segments = segments.map((seg) => {
      const rs = seg.root === null ? [] : d2Candidates(cands, seg.startBeat, seg.endBeat, seg.root, seg.quality, range);
      return rs.length ? { ...seg, chordCandidates: rs } : seg;
    });
  }
  return { columns, segments, states };
}
