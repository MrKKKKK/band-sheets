/**
 * Per-bar key tracking (port of py/dsp/keytrack.py, profile 'theory' = the default path).
 *
 * Default config (hash adec583eb3c6), analyze.py call site:
 *   keytrack.estimate(beat_level(chords1, per_beat), bar_of_col, [s.start_bar for s in sections], cfg)
 * - chords: the FIRST-pass chords at beat level (on-beat column of each beat: chords.ts `beatLevel`);
 *   only root and quality are read (confidence / posterior are not).
 * - barOfCol: (beat - downbeat phase) // beats_per_bar per beat (negative = pickup, ignored).
 * - sectionBars: start bar of every detected section (sections.ts).
 * - table: ts/tables/key_fit.json (generated from py/dsp/tables/key_fit.toml).
 * - cfg.key.change_cost_mid / change_cost_boundary: 0.0 = use the table (default).
 *
 * A 24-state HMM over bars (KEYS order: majors 0-11, minors 12-23), emissions = mean key_fit score of the
 * bar's chords, Viterbi path with resolution bonuses re-estimated up to MAX_PASSES times; per-bar confidence =
 * forward-backward posterior of the chosen key on the [confidence] scale-sharpened scores. The decisions
 * (Viterbi argmax: first index on ties, as np.argmax) use the same float64 operations in the same order as
 * Python, so paths are bit-identical; the posterior's sums differ from numpy only in summation order (~1e-16).
 */
import keyFitJson from '../tables/key_fit.json' with { type: 'json' };
import { npSum, type Mode } from './keyest';

export const MAX_PASSES = 4;
export const NOT_CONVERGED_WARNING = 'keytrack-not-converged';

const MODES: readonly Mode[] = ['major', 'minor'];
const STAGES = ['other', 'secondary', 'borrowed', 'diatonic', 'tonic'] as const; // ascending
export const QUALITIES = ['maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'm7b5', 'dim7', 'sus4'] as const;
const NQ = QUALITIES.length;
const QUAL_INDEX: ReadonlyMap<string, number> = new Map(QUALITIES.map((q, i) => [q, i]));
const TARGET_MODE: Readonly<Record<string, Mode>> = { maj: 'major', maj7: 'major', min: 'minor', min7: 'minor' };
const isTarget = (q: string): boolean => Object.hasOwn(TARGET_MODE, q);

type StageName = (typeof STAGES)[number];
type ModeTable = Partial<Record<StageName | 'dominant', string[]>>;
export interface KeyFitTable {
  stage: Partial<Record<StageName | 'dominant', number>> & Record<StageName, number>;
  major: ModeTable;
  minor: ModeTable;
  change: { mid: number; boundary: number; near_factor: number };
  resolution: { dominant7: number; triad: number; min_bars: number };
  confidence: { scale: number };
  phrase?: { bars?: number; edge?: string };
}

export const KEY_FIT: KeyFitTable = keyFitJson as unknown as KeyFitTable;

export interface KeyConfig {
  change_cost_mid: number; // > 0 overrides key_fit [change] mid
  change_cost_boundary: number; // > 0 overrides key_fit [change] boundary
}
export const DEFAULT_KEY_CONFIG: KeyConfig = { change_cost_mid: 0.0, change_cost_boundary: 0.0 };

export interface KeyChord {
  root: number | null;
  quality: string;
}

export interface BarKey {
  bar: number;
  tonic: number; // 0-11
  mode: Mode;
  confidence: number; // 0-1
}

export interface KeyTrackResult {
  keys: BarKey[];
  passes: number; // resolution re-passes run
  converged: boolean; // false -> analyze adds NOT_CONVERGED_WARNING
}

/** Index in KEYS order: majors 0-11, minors 12-23. */
export function keyIndex(tonic: number, mode: Mode): number {
  return MODES.indexOf(mode) * 12 + (((tonic % 12) + 12) % 12);
}

/** (24 keys x 12 roots x NQ) flat index. */
const at = (k: number, r: number, q: number): number => (k * 12 + r) * NQ + q;

function* relativeDominants(table: KeyFitTable): Generator<[number, number, number, number]> {
  for (const item of table.minor.dominant ?? []) {
    const [deg, q] = item.split(' ');
    for (let tonic = 0; tonic < 12; tonic++) {
      yield [keyIndex(tonic, 'minor'), keyIndex(tonic + 3, 'major'), (tonic + Number(deg)) % 12, QUAL_INDEX.get(q)!];
    }
  }
}

/** keytrack.fit_matrix: (24, 12, NQ) fit score; a chord in several lists takes the highest stage. */
export function fitMatrix(table: KeyFitTable = KEY_FIT): Float64Array {
  const st = table.stage;
  const out = new Float64Array(24 * 12 * NQ).fill(st.other);
  for (const mode of MODES) {
    for (const stage of STAGES.slice(1)) {
      for (const item of table[mode][stage] ?? []) {
        const [deg, q] = item.split(' ');
        const qi = QUAL_INDEX.get(q);
        if (qi === undefined) throw new Error(`key_fit: unknown quality ${q}`);
        for (let tonic = 0; tonic < 12; tonic++) {
          const i = at(keyIndex(tonic, mode), (tonic + Number(deg)) % 12, qi);
          out[i] = Math.max(out[i], st[stage]);
        }
      }
    }
  }
  if (st.dominant !== undefined) {
    for (const [km, kr, r, qi] of relativeDominants(table)) {
      // out[km] = out[kr] = max(dominant, out[kr])  (Python chained assignment: the minor key's own value is replaced)
      const v = Math.max(st.dominant, out[at(kr, r, qi)]);
      out[at(km, r, qi)] = v;
      out[at(kr, r, qi)] = v;
    }
  }
  return out;
}

/** keytrack.neutral_matrix: harmonic-minor V / vii° of the minor key = V/vi of its relative major. */
export function neutralMatrix(table: KeyFitTable = KEY_FIT): Uint8Array {
  const out = new Uint8Array(24 * 12 * NQ);
  for (const [km, kr, r, qi] of relativeDominants(table)) out[at(km, r, qi)] = out[at(kr, r, qi)] = 1;
  return out;
}

/** Near keys: same mode a fifth up/down, relative, parallel. */
function near(a: number, b: number): boolean {
  const ma = Math.floor(a / 12);
  const ta = a % 12;
  const mb = Math.floor(b / 12);
  const tb = b % 12;
  if (ma === mb) {
    const d = (((tb - ta) % 12) + 12) % 12;
    return d === 5 || d === 7;
  }
  if (ma === 0) return tb === ta || tb === (ta + 9) % 12;
  return tb === ta || tb === (ta + 3) % 12;
}

/** (nBars, 24) mean per-column fit score of each key (profile 'theory'). */
function emissions(chords: readonly KeyChord[], barOfCol: Int32Array, nBars: number, fit: Float64Array): Float64Array {
  const em = new Float64Array(nBars * 24);
  const cnt = new Float64Array(nBars);
  for (let c = 0; c < chords.length; c++) {
    const b = barOfCol[c];
    if (b < 0) continue;
    cnt[b] += 1;
    const ch = chords[c];
    const qi = QUAL_INDEX.get(ch.quality);
    if (ch.root !== null && qi !== undefined) {
      const r = ch.root % 12;
      for (let k = 0; k < 24; k++) em[b * 24 + k] += fit[at(k, r, qi)];
    }
  }
  for (let b = 0; b < nBars; b++) {
    const d = Math.max(cnt[b], 1);
    for (let k = 0; k < 24; k++) em[b * 24 + k] /= d;
  }
  return em;
}

export interface Resolution {
  domBar: number;
  targetBar: number;
  tonic: number;
  mode: Mode;
  kind: 'dominant7' | 'triad';
  targetCols: [number, number]; // [start, end) of the target chord segment
}

function resolutionKind(dom: KeyChord, tgt: KeyChord): Resolution['kind'] | null {
  const step = (((tgt.root! - dom.root!) % 12) + 12) % 12;
  if (dom.quality === '7' && (step === 5 || step === 11)) return 'dominant7';
  if (dom.quality === 'maj' && step === 5) return 'triad';
  if ((dom.quality === 'dim' || dom.quality === 'm7b5') && step === 1) return 'dominant7';
  if (dom.quality === 'dim7' && step % 3 === 1) return 'dominant7';
  return null;
}

/** keytrack.resolutions: dominant -> target pairs between consecutive chord segments. */
export function resolutions(chords: readonly KeyChord[], barOfCol: Int32Array): Resolution[] {
  const segs: [KeyChord, number, number][] = [];
  let prev: KeyChord | null = null;
  chords.forEach((ch, c) => {
    if (prev === null || ch.root !== prev.root || ch.quality !== prev.quality) {
      segs.push([ch, barOfCol[c], c]);
      prev = ch;
    }
  });
  const ends = [...segs.slice(1).map((s) => s[2]), chords.length];
  const out: Resolution[] = [];
  for (let i = 0; i + 1 < segs.length; i++) {
    const [dom, db] = segs[i];
    const [tgt, tb, tc] = segs[i + 1];
    if (dom.root === null || tgt.root === null || !isTarget(tgt.quality) || tb < 0) continue;
    const kind = resolutionKind(dom, tgt);
    if (kind) out.push({ domBar: Math.max(db, 0), targetBar: tb, tonic: tgt.root % 12, mode: TARGET_MODE[tgt.quality], kind, targetCols: [tc, ends[i + 1]] });
  }
  return out;
}

/** keytrack.phrases: [first column, last column] of `length`-bar units, restarted at every section start. */
export function phrases(barOfCol: Int32Array, sectionBars: readonly number[], nBars: number, length: number, voiced: Uint8Array | null): [number, number][] {
  if (length <= 0 || nBars <= 0) return [];
  const starts = [...new Set([0, ...sectionBars.filter((b) => 0 < b && b < nBars)])].sort((x, y) => x - y);
  const bounds: number[] = [];
  starts.forEach((a, i) => {
    const z = i + 1 < starts.length ? starts[i + 1] : nBars;
    for (let b = a; b < z; b += length) bounds.push(b);
  });
  const out: [number, number][] = [];
  bounds.forEach((a, i) => {
    const z = i + 1 < bounds.length ? bounds[i + 1] : nBars;
    let first = -1;
    let last = -1;
    for (let c = 0; c < barOfCol.length; c++) {
      if (barOfCol[c] >= a && barOfCol[c] < z && (voiced === null || voiced[c])) {
        if (first < 0) first = c;
        last = c;
      }
    }
    if (first >= 0) out.push([first, last]);
  });
  return out;
}

/** keytrack.frames_phrase: the target chord covers a phrase's first or last column (no phrases -> true). */
export function framesPhrase(r: Resolution, units: readonly [number, number][]): boolean {
  if (units.length === 0) return true;
  const [a, z] = r.targetCols;
  return units.some(([p0, p1]) => (a <= p0 && p0 < z) || (a <= p1 && p1 < z));
}

/** keytrack._bar_diatonic: (nBars, 24) the bar's stable chords are all diatonic (or tonic) to the key. */
function barDiatonic(chords: readonly KeyChord[], barOfCol: Int32Array, nBars: number, fit: Float64Array, diatonic: number, neutral: Uint8Array): Uint8Array {
  const ok = new Uint8Array(nBars * 24).fill(1);
  const seen = new Uint8Array(nBars * 24);
  for (let c = 0; c < chords.length; c++) {
    const b = barOfCol[c];
    const ch = chords[c];
    if (b < 0 || ch.root === null || !isTarget(ch.quality)) continue;
    const q = QUAL_INDEX.get(ch.quality)!;
    const r = ch.root % 12;
    for (let k = 0; k < 24; k++) {
      const skip = neutral[at(k, r, q)];
      if (!skip) seen[b * 24 + k] = 1;
      if (!(fit[at(k, r, q)] >= diatonic || skip)) ok[b * 24 + k] = 0;
    }
  }
  for (let i = 0; i < ok.length; i++) ok[i] &= seen[i];
  return ok;
}

function modulates(dia: Uint8Array, nBars: number, targetBar: number, nw: number, prev: number, nNeed: number, backHome: ReadonlySet<number>, endCounts: boolean): boolean {
  let count = 0;
  for (let b = targetBar + 1; b < nBars; b++) {
    if (backHome.has(b)) return false;
    const inNew = dia[b * 24 + nw];
    const inPrev = dia[b * 24 + prev];
    if (inNew && !inPrev) {
      count += 1;
      if (count >= nNeed) return true;
    } else if (inPrev && !inNew) {
      return false;
    }
  }
  return endCounts;
}

interface Ctx {
  chords: readonly KeyChord[];
  barOfCol: Int32Array;
  nBars: number;
  table: KeyFitTable;
  dia: Uint8Array;
  resList: Resolution[]; // resolutions whose target frames a phrase
}

/** keytrack._resolution_bonus; path0 null = first guess (every 'dominant7' resolution, no tonicization test). */
function resolutionBonus(ctx: Ctx, path0: Int32Array | null): Float64Array {
  const res = ctx.table.resolution;
  const nNeed = Math.trunc(res.min_bars);
  const bonus = new Float64Array(ctx.nBars * 24);
  const add = (r: Resolution, k: number) => {
    for (const b of new Set([r.domBar, r.targetBar])) bonus[b * 24 + k] += res[r.kind];
  };
  for (const r of ctx.resList) {
    const k = keyIndex(r.tonic, r.mode);
    if (path0 === null) {
      if (r.kind === 'dominant7') add(r, k);
      continue;
    }
    const prev = path0[Math.max(r.domBar - 1, 0)];
    const backHome = new Set(ctx.resList.filter((q) => keyIndex(q.tonic, q.mode) === prev).map((q) => q.targetBar));
    if (k !== prev && !modulates(ctx.dia, ctx.nBars, r.targetBar, k, prev, nNeed, backHome, r.kind === 'dominant7')) continue;
    add(r, k);
  }
  return bonus;
}

/** trans(b): (24 from x 24 to) log-weight of the move from bar b-1 to bar b, flat [from * 24 + to]. */
type Trans = (b: number) => Float64Array;

function viterbi(em: Float64Array, nBars: number, trans: Trans): Int32Array {
  let score = em.slice(0, 24);
  const back = new Int32Array(nBars * 24);
  for (let b = 1; b < nBars; b++) {
    const t = trans(b);
    const next = new Float64Array(24);
    for (let to = 0; to < 24; to++) {
      let arg = 0;
      let best = score[0] + t[to];
      for (let from = 1; from < 24; from++) {
        const v = score[from] + t[from * 24 + to];
        if (v > best) {
          best = v;
          arg = from;
        }
      }
      back[b * 24 + to] = arg;
      next[to] = best + em[b * 24 + to];
    }
    score = next;
  }
  const path = new Int32Array(nBars);
  let arg = 0;
  for (let k = 1; k < 24; k++) if (score[k] > score[arg]) arg = k;
  path[nBars - 1] = arg;
  for (let b = nBars - 1; b > 0; b--) path[b - 1] = back[b * 24 + path[b]];
  return path;
}

/** m + log(sum(exp(x - m))) over n values read by get(i); sum in numpy order (pairwise when `pairwise`). */
function logsumexp(get: (i: number) => number, n: number, pairwise: boolean): number {
  let m = -Infinity;
  for (let i = 0; i < n; i++) m = Math.max(m, get(i));
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = Math.exp(get(i) - m);
  let s: number;
  if (pairwise) s = npSum(e);
  else {
    s = e[0];
    for (let i = 1; i < n; i++) s += e[i];
  }
  return m + Math.log(s);
}

function addArr(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

/**
 * keytrack.estimate (profile 'theory'). `chords`: beat-level first-pass chords; `barOfCol`: bar per column
 * (negative = pickup). Returns one BarKey per bar 0..max(barOfCol).
 */
export function estimate(
  chords: readonly KeyChord[],
  barOfCol: ArrayLike<number>,
  sectionBars: readonly number[],
  cfg: KeyConfig = DEFAULT_KEY_CONFIG,
  table: KeyFitTable = KEY_FIT,
): KeyTrackResult {
  const boc = Int32Array.from(barOfCol);
  if (boc.length !== chords.length) throw new Error(`barOfCol has ${boc.length} entries for ${chords.length} chords`);
  let maxBar = -1;
  for (const b of boc) maxBar = Math.max(maxBar, b);
  if (chords.length === 0 || maxBar < 0) return { keys: [], passes: 0, converged: true };
  const nBars = maxBar + 1;
  const fit = fitMatrix(table);
  const base = emissions(chords, boc, nBars, fit);

  const ch = table.change;
  const mid = cfg.change_cost_mid > 0 ? cfg.change_cost_mid : ch.mid;
  const bnd = cfg.change_cost_boundary > 0 ? cfg.change_cost_boundary : ch.boundary;
  const nearM = new Float64Array(24 * 24);
  for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) nearM[a * 24 + b] = a === b ? 0.0 : near(a, b) ? ch.near_factor : 1.0;
  const boundaries = new Set(sectionBars.map((b) => Math.trunc(b)));
  const tMid = nearM.map((v) => -mid * v);
  const tBnd = nearM.map((v) => -bnd * v);
  const trans: Trans = (b) => (boundaries.has(b) ? tBnd : tMid);

  const ph = table.phrase ?? {};
  const edge = ph.edge ?? 'column';
  if (edge !== 'chord' && edge !== 'column') throw new Error(`key_fit [phrase] edge must be "chord" or "column": ${edge}`);
  const voiced = edge === 'chord' ? Uint8Array.from(chords, (c) => (c.root !== null ? 1 : 0)) : null;
  const units = phrases(boc, sectionBars, nBars, Math.trunc(ph.bars ?? 0), voiced);
  const ctx: Ctx = {
    chords,
    barOfCol: boc,
    nBars,
    table,
    dia: barDiatonic(chords, boc, nBars, fit, table.stage.diatonic, neutralMatrix(table)),
    resList: resolutions(chords, boc).filter((r) => framesPhrase(r, units)),
  };

  let path = viterbi(addArr(base, resolutionBonus(ctx, null)), nBars, trans);
  let em = base;
  let passes = 0;
  let converged = false;
  for (let i = 0; i < MAX_PASSES; i++) {
    em = addArr(base, resolutionBonus(ctx, path));
    const nw = viterbi(em, nBars, trans);
    passes = i + 1;
    if (nw.every((v, j) => v === path[j])) {
      converged = true;
      break;
    }
    path = nw;
  }

  // forward-backward on the sharpened scores
  const s = table.confidence.scale;
  const sT = (b: number) => trans(b).map((v) => s * v);
  const fwd = new Float64Array(nBars * 24);
  const bwd = new Float64Array(nBars * 24);
  for (let k = 0; k < 24; k++) fwd[k] = s * em[k];
  for (let b = 1; b < nBars; b++) {
    const t = sT(b);
    for (let to = 0; to < 24; to++) {
      fwd[b * 24 + to] = logsumexp((from) => fwd[(b - 1) * 24 + from] + t[from * 24 + to], 24, false) + s * em[b * 24 + to];
    }
  }
  for (let b = nBars - 2; b >= 0; b--) {
    const t = sT(b + 1);
    const nxt = new Float64Array(24);
    for (let to = 0; to < 24; to++) nxt[to] = s * em[(b + 1) * 24 + to] + bwd[(b + 1) * 24 + to];
    for (let from = 0; from < 24; from++) bwd[b * 24 + from] = logsumexp((to) => t[from * 24 + to] + nxt[to], 24, true);
  }
  const keys: BarKey[] = [];
  for (let b = 0; b < nBars; b++) {
    const post = (k: number) => fwd[b * 24 + k] + bwd[b * 24 + k];
    const lse = logsumexp(post, 24, true);
    const p = Math.exp(post(path[b]) - lse);
    keys.push({ bar: b, tonic: path[b] % 12, mode: MODES[Math.floor(path[b] / 12)], confidence: Math.min(Math.max(p, 0), 1) });
  }
  return { keys, passes, converged };
}
