/**
 * Spike 5 T3: scoring of the drum analyzer (docs/audio-spike5-plan.md section 5).
 *
 * Onset metrics follow mir_eval 0.8.2 `onset.f_measure` (py/tools/drum_mireval_check.py compares to 1e-9):
 * a reference and an estimate match when ref is within [est - window, est + window] (withinWindow(); no rounding, unlike mir_eval.transcription), the
 * matching is a maximum 1:1 matching (util.match_events -> bipartite), precision = matched / nEst, recall = matched /
 * nRef, and an empty reference or estimate gives 0 / 0 / 0. For |r - e| <= tol on a line a sorted two-pointer greedy
 * IS a maximum matching (same size as mir_eval's; the test cross-checks it with Kuhn's algorithm).
 *
 * Definitions chosen where the plan is open (each pinned by score.test.ts):
 *  - per-instrument F: instruments with neither truth nor estimate are left out of the table; truth-free instrument
 *    with estimates scores 0/0/0 (mir_eval). `all` = micro (matches summed over instruments, per-instrument matching).
 *  - alignment: ONE shift s in [-maxShift, +maxShift] (1 ms steps), est' = est - s; maximise matched count (all
 *    instruments, per-instrument matching at the main tolerance), tie -> smaller sum of |d| of the pairs, tie -> smaller |s|.
 *  - confusion (取り違え): after per-instrument matching, each unmatched truth hit takes the nearest unmatched estimate
 *    within tolerance (any other instrument); table truth inst x est inst, with 'none' = missed (row inst) / extra (col).
 *  - grid match: multiset of (bar, tick, inst); P/R/F by exact key equality (mark ignored).
 *  - strength: over grid-matched pairs: agreement = same mark (g / ac / normal); ghost and accent P/R among those pairs.
 *  - swing: share of non-excluded truth bars with est kind == truth kind (absent est bar = 'none').
 *  - edits (直す手数), per bar, hits keyed (tick, inst, mark): matching truth to estimate hits at cost
 *    (inst differs: 1) + (mark differs: 1) + (shift in grid cells = ceil(|dtick| / gridTicks)); unmatched estimate = delete 1,
 *    unmatched truth = add 1 (minimum-cost assignment, Hungarian). Shuffle: 1 per maximal run of consecutive wrong bars.
 *    Hits are not moved across a barline (that is delete + add). Bars: every scored truth bar AND every bar that has
 *    estimates only (after the last truth bar, e.g. quantize.ts's closing head at bar = nBars): those estimates are deletes
 *    (T16, review should-fix 2; the grid precision counted them already).
 *  - keyboard steps (from scratch with src/lib/drumInput.ts): events per bar = one per distinct onset tick (+ a rest event
 *    for a leading gap / an empty bar), length = ticks to the next onset (bar end for the last). Steps = 1 per event
 *    (instrument key or R) + 1 per extra simultaneous hit (Shift+key) + 1 per ghost (S) + 1 per accent (A) + 1 per change
 *    of length (current length starts at an 8th = 8 ticks; a dot is not told apart). Shuffle needs no keystroke here.
 *    'copy' variant: a bar whose hits equal an earlier counted bar costs 1.
 *  - level mapping: S-3 maps HO -> HH and drops everything but BD / SD / HH; S-9 drops the extension names; S-ext keeps all.
 *
 * Privacy: results are numbers and instrument-count tables only.
 */
import { DEFAULT_DRUM_CONFIG, type DrumConfig } from './config';
import { LEVEL_INSTRUMENTS, WHOLE_TICKS, TICKS_PER_16TH, type DrumLevel, type DrumMark } from './types';
import { maxBipartiteMatching } from '../hum/score';

export type Scores = Record<string, number>;

export function fMeasure(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/* ------------------------------------------------------------------ onset matching (mir_eval.onset) */

export interface OnsetScore {
  precision: number;
  recall: number;
  f: number;
  matched: number;
  nRef: number;
  nEst: number;
}

/**
 * mir_eval's window test (util._fast_hit_windows): ref in [est - window, est + window], the bounds computed in floating
 * point. NOT |r - e| <= window: e.g. ref 1.0, est 1.05, window 0.05 matches here (1.05 - 0.05 <= 1.0) although
 * 1.05 - 1.0 = 0.050000000000000044.
 */
export function withinWindow(r: number, e: number, tol: number): boolean {
  return r >= e - tol && r <= e + tol;
}

/** Maximum 1:1 matching of two time lists with |r - e| <= tol. Returns index pairs (ref index, est index). */
export function matchOnsets(ref: readonly number[], est: readonly number[], tol: number): [number, number][] {
  const ri = ref.map((_, i) => i).sort((a, b) => ref[a] - ref[b]);
  const ei = est.map((_, i) => i).sort((a, b) => est[a] - est[b]);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < ri.length && j < ei.length) {
    const r = ref[ri[i]];
    const e = est[ei[j]];
    if (withinWindow(r, e, tol)) {
      pairs.push([ri[i], ei[j]]);
      i++;
      j++;
    } else if (e < r) j++;
    else i++;
  }
  return pairs;
}

/** mir_eval.onset.f_measure. */
export function onsetScores(ref: readonly number[], est: readonly number[], tol: number): OnsetScore {
  if (ref.length === 0 || est.length === 0) return { precision: 0, recall: 0, f: 0, matched: 0, nRef: ref.length, nEst: est.length };
  const matched = matchOnsets(ref, est, tol).length;
  const precision = matched / est.length;
  const recall = matched / ref.length;
  return { precision, recall, f: fMeasure(precision, recall), matched, nRef: ref.length, nEst: est.length };
}

/** Reference cross-check (Kuhn, as in hum/score.ts) used by the tests: matching size only. */
export function matchOnsetsKuhn(ref: readonly number[], est: readonly number[], tol: number): number {
  const adj = ref.map((r) => est.flatMap((e, j) => (withinWindow(r, e, tol) ? [j] : [])));
  return maxBipartiteMatching(ref.length, est.length, adj).size;
}

/* ------------------------------------------------------------------ data model */

export interface TimedHit {
  t: number;
  inst: string;
}
export interface TruthHit extends TimedHit {
  bar: number;
  /** Ticks from the bar start (whole note = 64). */
  tick: number;
  mark?: DrumMark;
}
export interface TruthSwingBar {
  bar: number;
  kind: 'none' | '8' | '16';
}
export interface DrumTruth {
  hits: TruthHit[];
  /** Ticks per bar (64 for 4/4). */
  barTicks: number;
  /** Audio second of each bar start, plus the end of the last bar (length = nBars + 1). */
  barStartsSec: number[];
  /** Bars missing here are 'none'. */
  swingBars?: TruthSwingBar[];
  bpm?: number;
}
/** The parts of a DrumAnalysisResult the scorer reads. */
export interface EstResult {
  drums: { t: number; inst: string; bar?: number; tick?: number; mark?: DrumMark }[];
  swingBars?: { bar: number; kind: 'none' | '8' | '16' }[];
  drum?: { quantized?: { bpm: number; ts: [number, number]; startSec: number; hits: { bar: number; tick: number; inst: string; mark?: DrumMark }[] } };
}

/** HO -> HH for S-3, then keep the level's instruments. */
export function mapInst(inst: string, level: DrumLevel): string | null {
  const i = level === 'S-3' && inst === 'HO' ? 'HH' : inst;
  return (LEVEL_INSTRUMENTS[level] as readonly string[]).includes(i) ? i : null;
}
function mapHits<T extends { inst: string }>(hits: readonly T[], level: DrumLevel): T[] {
  const out: T[] = [];
  for (const h of hits) {
    const i = mapInst(h.inst, level);
    if (i !== null) out.push({ ...h, inst: i });
  }
  return out;
}

/* ------------------------------------------------------------------ offset alignment */

export interface Alignment {
  /** est' = est - offsetSec. Positive = the analyzer (or the player) is late. */
  offsetSec: number;
  matched: number;
}

function matchStats(ref: TimedHit[], est: TimedHit[], tol: number, shift: number): { matched: number; absSum: number } {
  const byInst = (hs: TimedHit[]) => {
    const m = new Map<string, number[]>();
    for (const h of hs) m.set(h.inst, [...(m.get(h.inst) ?? []), h.t]);
    return m;
  };
  const R = byInst(ref);
  const E = byInst(est);
  let matched = 0;
  let absSum = 0;
  for (const [inst, rt] of R) {
    const et = (E.get(inst) ?? []).map((t) => t - shift);
    for (const [a, b] of matchOnsets(rt, et, tol)) {
      matched++;
      absSum += Math.abs(rt[a] - et[b]);
    }
  }
  return { matched, absSum };
}

export function alignOffset(ref: TimedHit[], est: TimedHit[], opts: { maxShiftSec?: number; stepSec?: number; tolSec?: number } = {}): Alignment {
  const maxShift = opts.maxShiftSec ?? 0.1;
  const step = opts.stepSec ?? 0.001;
  const tol = opts.tolSec ?? DEFAULT_DRUM_CONFIG.score.toleranceSec;
  const n = Math.round(maxShift / step);
  let best = { offsetSec: 0, matched: -1, absSum: Infinity };
  for (let k = -n; k <= n; k++) {
    const s = k * step;
    const { matched, absSum } = matchStats(ref, est, tol, s);
    const better =
      matched > best.matched ||
      (matched === best.matched && (absSum < best.absSum - 1e-12 || (Math.abs(absSum - best.absSum) <= 1e-12 && Math.abs(s) < Math.abs(best.offsetSec))));
    if (better) best = { offsetSec: s, matched, absSum };
  }
  return { offsetSec: best.offsetSec, matched: best.matched };
}

/* ------------------------------------------------------------------ per-instrument onsets and confusion */

export interface InstOnsetScores {
  perInst: Record<string, OnsetScore>;
  all: OnsetScore;
  /** truth inst -> est inst -> count; 'none' = missed (as a column) / extra (as a row). */
  confusion: Record<string, Record<string, number>>;
  /** est - truth seconds of the matched pairs, per instrument (timing spread for the pooled reports). */
  dev: Record<string, number[]>;
}

export function instrumentOnsets(ref: TimedHit[], est: TimedHit[], tol: number): InstOnsetScores {
  const insts = [...new Set([...ref.map((h) => h.inst), ...est.map((h) => h.inst)])].sort();
  const perInst: Record<string, OnsetScore> = {};
  const unR: TimedHit[] = [];
  const unE: TimedHit[] = [];
  const dev: Record<string, number[]> = {};
  let matched = 0;
  for (const inst of insts) {
    const r = ref.filter((h) => h.inst === inst);
    const e = est.filter((h) => h.inst === inst);
    perInst[inst] = onsetScores(
      r.map((h) => h.t),
      e.map((h) => h.t),
      tol,
    );
    const pairs = r.length && e.length ? matchOnsets(r.map((h) => h.t), e.map((h) => h.t), tol) : [];
    matched += pairs.length;
    if (pairs.length) dev[inst] = pairs.map(([i, j]) => e[j].t - r[i].t);
    const mr = new Set(pairs.map((p) => p[0]));
    const me = new Set(pairs.map((p) => p[1]));
    r.forEach((h, i) => mr.has(i) || unR.push(h));
    e.forEach((h, i) => me.has(i) || unE.push(h));
  }
  const confusion: Record<string, Record<string, number>> = {};
  const bump = (a: string, b: string) => {
    confusion[a] ??= {};
    confusion[a][b] = (confusion[a][b] ?? 0) + 1;
  };
  for (const inst of insts) {
    const m = perInst[inst].matched;
    if (m) confusion[inst] = { [inst]: m };
  }
  const used = new Set<number>();
  for (const r of [...unR].sort((a, b) => a.t - b.t)) {
    let bi = -1;
    let bd = Infinity;
    unE.forEach((e, i) => {
      const d = Math.abs(e.t - r.t);
      if (!used.has(i) && withinWindow(r.t, e.t, tol) && d < bd) {
        bd = d;
        bi = i;
      }
    });
    if (bi >= 0) {
      used.add(bi);
      bump(r.inst, unE[bi].inst);
    } else bump(r.inst, 'none');
  }
  unE.forEach((e, i) => used.has(i) || bump('none', e.inst));
  const nRef = ref.length;
  const nEst = est.length;
  const precision = nEst ? matched / nEst : 0;
  const recall = nRef ? matched / nRef : 0;
  return { perInst, all: { precision, recall, f: nRef && nEst ? fMeasure(precision, recall) : 0, matched, nRef, nEst }, confusion, dev };
}

/* ------------------------------------------------------------------ grid, strength, swing */

export interface GridHit {
  bar: number;
  tick: number;
  inst: string;
  mark?: DrumMark;
}
const tickKey = (h: GridHit) => `${h.bar}|${Math.round(h.tick * 1e6) / 1e6}|${h.inst}`;

export interface GridScore extends OnsetScore {
  strength: { pairs: number; agree: number; ghostP: number; ghostR: number; accentP: number; accentR: number };
}

export function gridScores(truth: GridHit[], est: GridHit[]): GridScore {
  const pool = new Map<string, GridHit[]>();
  for (const h of est) pool.set(tickKey(h), [...(pool.get(tickKey(h)) ?? []), h]);
  const pairs: [GridHit, GridHit][] = [];
  for (const t of truth) {
    const a = pool.get(tickKey(t));
    if (a?.length) pairs.push([t, a.shift()!]);
  }
  const matched = pairs.length;
  const precision = est.length ? matched / est.length : 0;
  const recall = truth.length ? matched / truth.length : 0;
  const cnt = (f: (t: DrumMark | undefined, e: DrumMark | undefined) => boolean) => pairs.filter(([t, e]) => f(t.mark, e.mark)).length;
  const ratio = (a: number, b: number) => (b ? a / b : 0);
  const agree = cnt((t, e) => t === e);
  return {
    precision,
    recall,
    f: truth.length && est.length ? fMeasure(precision, recall) : 0,
    matched,
    nRef: truth.length,
    nEst: est.length,
    strength: {
      pairs: matched,
      agree: ratio(agree, matched),
      ghostP: ratio(cnt((t, e) => t === 'g' && e === 'g'), cnt((_t, e) => e === 'g')),
      ghostR: ratio(cnt((t, e) => t === 'g' && e === 'g'), cnt((t) => t === 'g')),
      accentP: ratio(cnt((t, e) => t === 'ac' && e === 'ac'), cnt((_t, e) => e === 'ac')),
      accentR: ratio(cnt((t, e) => t === 'ac' && e === 'ac'), cnt((t) => t === 'ac')),
    },
  };
}

export type SwingKind = 'none' | '8' | '16';
export const SWING_KINDS: SwingKind[] = ['none', '8', '16'];

export function swingScores(truth: { bar: number; kind: SwingKind }[] | undefined, est: { bar: number; kind: SwingKind }[] | undefined, bars: number[]) {
  const tm = new Map((truth ?? []).map((b) => [b.bar, b.kind]));
  const em = new Map((est ?? []).map((b) => [b.bar, b.kind]));
  const confusion: Record<string, Record<string, number>> = {};
  let ok = 0;
  const wrong: boolean[] = [];
  for (const b of bars) {
    const t = tm.get(b) ?? 'none';
    const e = em.get(b) ?? 'none';
    confusion[t] ??= {};
    confusion[t][e] = (confusion[t][e] ?? 0) + 1;
    if (t === e) ok++;
    wrong.push(t !== e);
  }
  return { acc: bars.length ? ok / bars.length : 0, nBars: bars.length, confusion, wrong };
}

/* ------------------------------------------------------------------ edits and keyboard steps */

/** Minimum-cost assignment on a square matrix (Hungarian, O(n^3)). Returns col for each row. */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

export interface BarHit {
  tick: number;
  inst: string;
  mark?: DrumMark;
}

/** Edits to turn est into truth within ONE bar (see header). */
export function barEdits(truth: BarHit[], est: BarHit[], gridTicks = TICKS_PER_16TH): number {
  const n = truth.length;
  const m = est.length;
  if (!n || !m) return n + m;
  const N = n + m;
  const BIG = 1e6;
  const cost: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i < n && j < m) {
        const t = truth[i];
        const e = est[j];
        cost[i][j] = (t.inst !== e.inst ? 1 : 0) + (t.mark !== e.mark ? 1 : 0) + Math.ceil(Math.abs(t.tick - e.tick) / gridTicks - 1e-9);
      } else if (i < n) cost[i][j] = j - m === i ? 1 : BIG; // truth i left alone = add
      else if (j < m) cost[i][j] = i - n === j ? 1 : BIG; // est j left alone = delete
      else cost[i][j] = 0;
    }
  }
  const a = hungarian(cost);
  return a.reduce((s, j, i) => s + cost[i][j], 0);
}

/** Keyboard steps to enter one bar from scratch; `cur` = current length in ticks (returned for the next bar). */
export function barKeyboardSteps(hits: BarHit[], barTicks: number, cur: number): { steps: number; cur: number } {
  const ticks = [...new Set(hits.map((h) => h.tick))].sort((a, b) => a - b);
  let steps = 0;
  const event = (len: number) => {
    steps++;
    if (len !== cur) {
      steps++;
      cur = len;
    }
  };
  if (ticks.length === 0) event(barTicks);
  else if (ticks[0] > 0) event(ticks[0]);
  ticks.forEach((t, i) => {
    event((i + 1 < ticks.length ? ticks[i + 1] : barTicks) - t);
    const hs = hits.filter((h) => h.tick === t);
    steps += hs.length - 1; // Shift+key for each simultaneous hit
    steps += hs.filter((h) => h.mark === 'g').length + hs.filter((h) => h.mark === 'ac').length;
  });
  return { steps, cur };
}

const barSig = (hits: BarHit[]) =>
  hits
    .map((h) => `${h.tick}|${h.inst}|${h.mark ?? ''}`)
    .sort()
    .join(';');

export interface EditScore {
  hitEdits: number;
  swingEdits: number;
  edits: number;
  keyboardSteps: number;
  keyboardStepsCopy: number;
  ratio: number;
  ratioCopy: number;
}

/** `bars` = the scored truth bars; `est` must already leave out excluded bars (any est bar not in `bars` is deleted). */
export function editScores(truth: GridHit[], est: GridHit[], bars: number[], opts: { barTicks: number; gridTicks?: number; swingWrong?: boolean[] }): EditScore {
  const byBar = (hs: GridHit[]) => {
    const m = new Map<number, BarHit[]>();
    for (const h of hs) m.set(h.bar, [...(m.get(h.bar) ?? []), { tick: h.tick, inst: h.inst, mark: h.mark }]);
    return m;
  };
  const T = byBar(truth);
  const E = byBar(est);
  let hitEdits = 0;
  let kb = 0;
  let kbCopy = 0;
  let cur = 8;
  let curCopy = 8;
  const seen = new Set<string>();
  const scored = new Set(bars);
  for (const b of [...bars, ...[...E.keys()].filter((k) => !scored.has(k))]) hitEdits += barEdits(T.get(b) ?? [], E.get(b) ?? [], opts.gridTicks);
  for (const b of bars) {
    const t = T.get(b) ?? [];
    const r = barKeyboardSteps(t, opts.barTicks, cur);
    kb += r.steps;
    cur = r.cur;
    const sig = barSig(t);
    if (seen.has(sig)) kbCopy += 1;
    else {
      const rc = barKeyboardSteps(t, opts.barTicks, curCopy);
      kbCopy += rc.steps;
      curCopy = rc.cur;
      seen.add(sig);
    }
  }
  let swingEdits = 0;
  (opts.swingWrong ?? []).forEach((w, i, a) => {
    if (w && !(i > 0 && a[i - 1])) swingEdits++;
  });
  const edits = hitEdits + swingEdits;
  return { hitEdits, swingEdits, edits, keyboardSteps: kb, keyboardStepsCopy: kbCopy, ratio: kb ? edits / kb : 0, ratioCopy: kbCopy ? edits / kbCopy : 0 };
}

/* ------------------------------------------------------------------ one take */

export interface TakeInput {
  truth: DrumTruth;
  result: EstResult;
  level: DrumLevel;
  cfg?: DrumConfig;
  /** 楽譜と違って叩いた小節 (0-based bars): dropped from truth, estimate and every metric. */
  excludedBars?: number[];
  /** Recordings: find one global shift (not given to the analyzer). Default false. */
  align?: boolean;
  maxShiftSec?: number;
  gridTicks?: number;
}

export interface TakeScore {
  scores: Scores;
  /** truth inst -> est inst counts at the main tolerance. */
  confusion: Record<string, Record<string, number>>;
  swingConfusion: Record<string, Record<string, number>>;
  /** Instruments present in truth or estimate (for the table columns). */
  insts: string[];
  alignment: Alignment;
  /** Raw counts for pooling over takes (pool.ts sums these, so pooled and per-take tables use the same bars and tolerance). */
  counts: {
    onset: Record<string, { matched: number; nRef: number; nEst: number }>;
    /** est - truth seconds of the matched pairs at the main tolerance. */
    devSec: Record<string, number[]>;
    grid?: { matched: number; nRef: number; nEst: number };
  };
}

export function scoreTake(inp: TakeInput): TakeScore {
  const cfg = inp.cfg ?? DEFAULT_DRUM_CONFIG;
  const tol = cfg.score.toleranceSec;
  const tight = cfg.score.tightSec;
  const excl = new Set(inp.excludedBars ?? []);
  const nBars = Math.max(0, inp.truth.barStartsSec.length - 1);
  const bars = Array.from({ length: nBars }, (_, i) => i).filter((b) => !excl.has(b));
  const inExcluded = (t: number) => {
    for (const b of excl) if (t >= inp.truth.barStartsSec[b] && t < inp.truth.barStartsSec[b + 1]) return true;
    return false;
  };
  const truthHits = mapHits(inp.truth.hits, inp.level).filter((h) => !excl.has(h.bar));
  const estAll = mapHits(inp.result.drums, inp.level);
  const alignment = inp.align
    ? alignOffset(
        truthHits,
        estAll.filter((h) => !inExcluded(h.t)),
        { maxShiftSec: inp.maxShiftSec ?? 0.1, tolSec: tol },
      )
    : { offsetSec: 0, matched: 0 };
  const estHits = estAll.map((h) => ({ ...h, t: h.t - alignment.offsetSec })).filter((h) => !inExcluded(h.t));

  const s: Scores = {};
  const main = instrumentOnsets(truthHits, estHits, tol);
  const tightRes = instrumentOnsets(truthHits, estHits, tight);
  const put = (prefix: string, r: InstOnsetScores) => {
    for (const [inst, v] of Object.entries(r.perInst)) {
      s[`${prefix}.f.${inst}`] = v.f;
      s[`${prefix}.p.${inst}`] = v.precision;
      s[`${prefix}.r.${inst}`] = v.recall;
    }
    s[`${prefix}.f.all`] = r.all.f;
    s[`${prefix}.p.all`] = r.all.precision;
    s[`${prefix}.r.all`] = r.all.recall;
  };
  put('onset', main);
  put('onset25', tightRes);
  const counts: TakeScore['counts'] = { onset: Object.fromEntries(Object.entries(main.perInst).map(([k, v]) => [k, { matched: v.matched, nRef: v.nRef, nEst: v.nEst }])), devSec: main.dev };
  s['align.offsetMs'] = alignment.offsetSec * 1000;

  const tq = truthHits.map((h) => ({ bar: h.bar, tick: h.tick, inst: h.inst, mark: h.mark }));
  const q = inp.result.drum?.quantized;
  if (q) {
    const eq = mapHits(q.hits, inp.level).filter((h) => !excl.has(h.bar));
    const g = gridScores(tq, eq);
    s['grid.f'] = g.f;
    s['grid.p'] = g.precision;
    s['grid.r'] = g.recall;
    s['strength.agree'] = g.strength.agree;
    s['strength.ghostP'] = g.strength.ghostP;
    s['strength.ghostR'] = g.strength.ghostR;
    s['strength.accentP'] = g.strength.accentP;
    s['strength.accentR'] = g.strength.accentR;
    const sw = swingScores(inp.truth.swingBars, inp.result.swingBars, bars);
    s['swing.acc'] = sw.acc;
    const ed = editScores(tq, eq, bars, { barTicks: inp.truth.barTicks, gridTicks: inp.gridTicks, swingWrong: sw.wrong });
    s['edit.count'] = ed.edits;
    s['edit.hits'] = ed.hitEdits;
    s['edit.swing'] = ed.swingEdits;
    s['edit.keyboardSteps'] = ed.keyboardSteps;
    s['edit.keyboardStepsCopy'] = ed.keyboardStepsCopy;
    s['edit.ratioToKeyboard'] = ed.ratio;
    s['edit.ratioToKeyboardCopy'] = ed.ratioCopy;
    if (inp.truth.bpm) s['tempo.relErr'] = Math.abs(q.bpm - inp.truth.bpm) / inp.truth.bpm;
    const barSec = (60 / q.bpm) * q.ts[0] * (4 / q.ts[1]);
    const heads = bars.map((b) => q.startSec + b * barSec - alignment.offsetSec);
    s['barHead.f'] = onsetScores(
      bars.map((b) => inp.truth.barStartsSec[b]),
      heads,
      tol,
    ).f;
    return { scores: s, confusion: main.confusion, swingConfusion: sw.confusion, insts: Object.keys(main.perInst), alignment, counts: { ...counts, grid: { matched: g.matched, nRef: g.nRef, nEst: g.nEst } } };
  }
  return { scores: s, confusion: main.confusion, swingConfusion: {}, insts: Object.keys(main.perInst), alignment, counts };
}

export { WHOLE_TICKS };
