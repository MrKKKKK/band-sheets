/**
 * Music-theory transition prior for the 2nd chord pass (port of py/dsp/harmony.py, DEFAULT path only:
 * `transition`; `resolve_power` is only reached with chords.power, which is off and throws in vocab.states).
 *
 *   tierMatrix(mode) -> Float64Array [132 * 132]   tier of (degree, quality) -> (degree, quality), tonic 0
 *   colKeys(barKeys, barOfBeat) -> BarKey[]          key of each beat (pickup -> first bar, gap -> earlier bar)
 *   new TheoryPrior(states, barKeys, barOfBeat, strength).row(t) -> Float64Array [k * k]   prior of beat t
 *   estimateChordsPass2(colChroma, n, cfg, {perBeat, barKeys, barOfBeat}) -> ColumnChord[]   (analyze's chords2)
 *
 * Memory (plan section 2): Python's transition() builds the whole (n_beats, k, k) float64 array (5 minutes,
 * 120 states: ~70-140 MB). Here a row is computed when it is first read and kept in a small LRU keyed by the
 * same signature Python's `done` cache uses (key, confidence, [previous key, confidence]), so only a handful of
 * k * k rows exist at a time. Recomputing a row gives bit-identical values, so the LRU cannot change results.
 * TheoryPrior is a chords.PriorRows: the Viterbi fetches row(floor(t / perBeat)) once per column.
 *
 * The prior is per BEAT (bar_of_col in analyze.py is per beat, length n_beats); estimate_chords repeats each
 * beat row on the per_beat columns of that beat (np.repeat), which chords.ts does with rowDiv = perBeat.
 *
 * Floats follow Python: b = (strength * max(conf, 0)) * tier, np.maximum at a key change, row normalization
 * shift = log(sum_j exp(b[i, j]) / (k - 1)) with numpy's pairwise row sum (core/npmath.pairwiseSum).
 */
import harmonyJson from '../tables/harmony.json' with { type: 'json' };
import {
  estimateChords,
  type ChordsConfig,
  type ColumnChord,
  type PriorRows,
} from './chords';
import type { MemTracker } from '../core/mem';
import { pairwiseSum } from '../core/npmath';
import type { Mode } from './keyest';
import type { BarKey } from './keytrack';
import * as vocab from './vocab';
import type { ChordState } from './vocab';

/** chords.theory_prior of the default config (adec583eb3c6). */
export const DEFAULT_THEORY_PRIOR = 1.0;
export const QUALITIES = [
  'maj',
  'min',
  '7',
  'maj7',
  'min7',
  'dim',
  'aug',
  'sus4',
  'm7b5',
  'dim7',
  '5',
] as const;
const QI: Record<string, number> = Object.fromEntries(
  QUALITIES.map((q, i) => [q, i]),
);
const POWER = '5';
export const NQ = QUALITIES.length;
const N = 12 * NQ;

interface Rule {
  from: string[];
  to: string[];
}
interface ModeTable {
  diatonic: string[];
  borrowed: string[];
  strong?: Rule[];
  medium?: Rule[];
  weak?: Rule[];
}
export interface HarmonyTable {
  family: Record<string, string[]>;
  tier: Record<'strong' | 'medium' | 'weak', number>;
  generic: Record<string, { tier: 'strong' | 'medium' | 'weak' }>;
  major: ModeTable;
  minor: ModeTable;
}
export const HARMONY: HarmonyTable = harmonyJson as unknown as HarmonyTable;

type Chord = readonly [number, string];
const mod12 = (x: number) => ((x % 12) + 12) % 12;
const key = (c: Chord) => `${c[0]} ${c[1]}`;

class ChordSet {
  private m = new Map<string, Chord>();
  add(c: Chord): void {
    this.m.set(key(c), c);
  }
  has(c: Chord): boolean {
    return this.m.has(key(c));
  }
  values(): Chord[] {
    return [...this.m.values()];
  }
}

function quals(token: string, fam: Record<string, string[]>): string[] {
  const out = new Set<string>();
  for (const part of token.split('+')) {
    if (part in fam) for (const q of fam[part]) out.add(q);
    else if (part in QI && part !== POWER) out.add(part);
    else throw new Error(`harmony.toml: unknown family / quality '${part}'`);
  }
  return [...out];
}

/** ["7 D+s", ...] -> {(7, '7'), (7, 'maj'), (7, 'sus4'), ...} */
export function parseChords(
  items: readonly string[],
  fam: Record<string, string[]>,
): ChordSet {
  const out = new ChordSet();
  for (const item of items) {
    const parts = item.trim().split(/\s+/);
    if (parts.length !== 2)
      throw new Error(`harmony.toml: bad chord item '${item}'`);
    const d = Number.parseInt(parts[0], 10);
    if (!(d >= 0 && d < 12))
      throw new Error(`harmony.toml: degree out of range in '${item}'`);
    for (const q of quals(parts[1], fam)) out.add([d, q]);
  }
  return out;
}

const idx = (d: number, q: string) => mod12(d) * NQ + QI[q];

const tierCache = new Map<string, Float64Array>();

/** (12*NQ)^2 tier value of the move (degree a, quality a) -> (degree b, quality b), tonic 0. Diagonal 0. */
export function tierMatrix(
  mode: Mode,
  table: HarmonyTable = HARMONY,
): Float64Array {
  const ck = table === HARMONY ? mode : '';
  const hit = ck ? tierCache.get(ck) : undefined;
  if (hit) return hit;
  const fam = table.family;
  const tv = table.tier;
  const md = table[mode];
  const gen: Record<string, number> = {};
  for (const [name, g] of Object.entries(table.generic)) gen[name] = tv[g.tier];
  const [M, D, m, o] = (['M', 'D', 'm', 'o'] as const).map((k) => fam[k]);
  const dia = parseChords(md.diatonic, fam);
  const borrowed = parseChords(md.borrowed, fam);
  const T = new Float64Array(N * N);
  const put = (a: Chord, b: Chord, v: number) => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    const p = idx(a[0], a[1]) * N + idx(b[0], b[1]);
    T[p] = Math.max(T[p], v);
  };
  for (const tier of ['strong', 'medium', 'weak'] as const) {
    for (const rule of md[tier] ?? []) {
      const to = parseChords(rule.to, fam).values();
      for (const a of parseChords(rule.from, fam).values())
        for (const b of to) put(a, b, tv[tier]);
    }
  }
  const stable = new Set([...M, ...m, ...D]);
  const diaVals = dia.values();
  const diaRoots = [
    ...new Set(diaVals.filter(([, q]) => stable.has(q)).map(([d]) => d)),
  ].sort((a, b) => a - b);
  const targets = diaRoots.filter((x) => x !== 0);
  const technique = new ChordSet();
  for (const c of borrowed.values()) if (!dia.has(c)) technique.add(c);
  for (const x of targets) {
    const y = (x + 7) % 12;
    const srcs = D.map((q) => [y, q] as Chord).filter((c) => !dia.has(c));
    for (const s of srcs) technique.add(s);
    for (const s of srcs)
      for (const q of stable) put(s, [x, q], gen.secondary_dominant);
    for (const q of [...m, ...o])
      for (const d of srcs) put([(y + 7) % 12, q], d, gen.two_five);
  }
  for (const x of diaRoots) {
    const tgt = diaVals.filter((c) => c[0] === x);
    const srcs = D.map((q) => [(x + 1) % 12, q] as Chord).filter(
      (c) => !dia.has(c),
    ); // tritone substitute
    for (const s of srcs) technique.add(s);
    for (const s of srcs) for (const b of tgt) put(s, b, gen.tritone_sub);
    for (let d0 = 0; d0 < 12; d0++) {
      // passing diminished
      for (const q of o) {
        const tones =
          q === 'dim7' ? [0, 3, 6, 9].map((k) => (d0 + k) % 12) : [d0];
        if (tones.includes(mod12(x - 1))) {
          const s: Chord = [d0, q];
          if (!dia.has(s)) technique.add(s);
          for (const b of tgt) put(s, b, gen.passing_dim);
        }
      }
    }
    for (const qa of m)
      for (const qb of D)
        put([(x + 2) % 12, qa], [(x + 1) % 12, qb], gen.backdoor_two_five); // ii/x -> subV/x
  }
  for (let d = 0; d < 12; d++)
    for (const q of [...M, ...D]) put([d, 'sus4'], [d, q], gen.sus4_resolution);
  const tech = technique.values();
  for (const a of diaVals) {
    for (const b of diaVals) if (a[0] !== b[0]) put(a, b, gen.diatonic_other);
    for (const b of tech) put(a, b, gen.into_technique);
  }
  // power chords: max over maj / min, as source (rows) and then as target (columns)
  for (let d = 0; d < 12; d++) {
    const p = idx(d, POWER),
      mj = idx(d, 'maj'),
      mn = idx(d, 'min');
    for (let j = 0; j < N; j++)
      T[p * N + j] = Math.max(T[mj * N + j], T[mn * N + j]);
  }
  for (let d = 0; d < 12; d++) {
    const p = idx(d, POWER),
      mj = idx(d, 'maj'),
      mn = idx(d, 'min');
    for (let i = 0; i < N; i++)
      T[i * N + p] = Math.max(T[i * N + mj], T[i * N + mn]);
  }
  for (let i = 0; i < N; i++) T[i * N + i] = 0;
  if (ck) tierCache.set(ck, T);
  return T;
}

/**
 * Note section 6.4 in place: shift each row's off-diagonal entries so that sum_{j != i} exp(b[i, j]) = k - 1;
 * the diagonal stays 0. `e` is a k-long scratch row.
 */
export function normalizeRows(
  b: Float64Array,
  k: number,
  e: Float64Array = new Float64Array(k),
): Float64Array {
  if (k < 2) return b.fill(0);
  for (let i = 0; i < k; i++) {
    const o = i * k;
    for (let j = 0; j < k; j++) e[j] = Math.exp(b[o + j]);
    e[i] = 0;
    const shift = Math.log(pairwiseSum(e, 0, k) / (k - 1));
    for (let j = 0; j < k; j++) b[o + j] -= shift;
    b[o + i] = 0;
  }
  return b;
}

/** harmony._col_keys: the BarKey of each entry of `barOfBeat`; pickup -> first bar, missing -> nearest earlier. */
export function colKeys(
  barKeys: readonly BarKey[],
  barOfBeat: ArrayLike<number>,
): BarKey[] {
  const byBar = new Map<number, BarKey>();
  for (const k of barKeys) byBar.set(k.bar, k);
  const bars = [...byBar.keys()].sort((a, b) => a - b);
  const out: BarKey[] = [];
  for (let t = 0; t < barOfBeat.length; t++) {
    const b = Math.trunc(barOfBeat[t]);
    const hit = byBar.get(b);
    if (hit) {
      out.push(hit);
      continue;
    }
    let prev: number | undefined;
    for (const x of bars) if (x <= b) prev = x;
    out.push(byBar.get(prev ?? bars[0])!);
  }
  return out;
}

export interface TheoryPriorOptions {
  /** Typed arrays of the row cache / scratch are accounted here (plan section 2 memory). */
  mem?: MemTracker;
  /** Rows kept (LRU). Viterbi reads beat rows in order, so 2 already suffices; 4 by default. */
  cacheRows?: number;
}

/** harmony.transition, one beat row at a time. Rows are shared and must not be modified. */
export class TheoryPrior implements PriorRows {
  readonly k: number;
  readonly rows: number;
  /** Rows computed so far (cache misses), for tests. */
  computed = 0;
  private readonly keys: BarKey[];
  private readonly sigs: (string | null)[];
  private readonly st: { root: number; qi: number }[];
  private readonly ixCache = new Map<number, Int32Array>();
  private readonly strength: number;
  private readonly zero: Float64Array;
  private readonly scratch: Float64Array;
  private readonly cache = new Map<string, Float64Array>();
  private readonly cacheRows: number;
  private readonly mem?: MemTracker;
  private readonly allZero: boolean;

  constructor(
    states: readonly ChordState[],
    barKeys: readonly BarKey[],
    barOfBeat: ArrayLike<number>,
    strength = DEFAULT_THEORY_PRIOR,
    opts: TheoryPriorOptions = {},
  ) {
    this.k = states.length;
    this.rows = barOfBeat.length;
    this.strength = strength;
    this.mem = opts.mem;
    this.cacheRows = Math.max(1, opts.cacheRows ?? 4);
    for (const s of states)
      if (!(s.quality in QI))
        throw new Error(`harmony: unknown quality ${s.quality}`);
    this.st = states.map((s) => ({ root: s.root, qi: QI[s.quality] }));
    this.zero = this.alloc(this.k * this.k);
    this.scratch = this.alloc(this.k);
    const n = this.rows;
    this.sigs = new Array<string | null>(n).fill(null);
    this.keys = [];
    if (strength <= 0 || barKeys.length === 0 || n < 2) {
      this.allZero = true;
      return;
    }
    this.keys = colKeys(barKeys, barOfBeat);
    let any = false;
    for (let t = 1; t < n; t++) {
      const cur = this.keys[t],
        prev = this.keys[t - 1];
      const same =
        mod12(cur.tonic) === mod12(prev.tonic) && cur.mode === prev.mode;
      // b.any() is false only when every factor is 0 (the tier matrices are never all zero for k >= 2)
      const f = strength * Math.max(cur.confidence, 0);
      const fp = same ? 0 : strength * Math.max(prev.confidence, 0);
      if (!(f > 0 || fp > 0) || this.k < 2) continue;
      this.sigs[t] =
        `${mod12(cur.tonic)},${cur.mode},${cur.confidence}` +
        (same ? '' : `|${mod12(prev.tonic)},${prev.mode},${prev.confidence}`);
      any = true;
    }
    this.allZero = !any;
  }

  private alloc(n: number): Float64Array {
    return this.mem ? this.mem.f64(n) : new Float64Array(n);
  }

  /** True when every row is 0 (Python: transition returns zeros; estimate_chords takes the fast path). */
  isZero(): boolean {
    return this.allZero;
  }

  /** Prior of beat t ([k, k] row-major, from state i at t-1 to state j at t). */
  row(t: number): Float64Array {
    const sig = this.sigs[t];
    if (sig === null || sig === undefined) return this.zero;
    const hit = this.cache.get(sig);
    if (hit) {
      this.cache.delete(sig); // LRU: move to the end
      this.cache.set(sig, hit);
      return hit;
    }
    let buf: Float64Array;
    if (this.cache.size >= this.cacheRows) {
      const [oldest, arr] = this.cache.entries().next().value as [
        string,
        Float64Array,
      ];
      this.cache.delete(oldest);
      buf = arr;
    } else buf = this.alloc(this.k * this.k);
    this.fill(buf, this.keys[t], this.keys[t - 1]);
    this.cache.set(sig, buf);
    this.computed++;
    return buf;
  }

  private fill(b: Float64Array, cur: BarKey, prev: BarKey): void {
    const k = this.k;
    const same =
      mod12(cur.tonic) === mod12(prev.tonic) && cur.mode === prev.mode;
    this.tiers(b, cur, this.strength * Math.max(cur.confidence, 0), false);
    if (!same)
      this.tiers(b, prev, this.strength * Math.max(prev.confidence, 0), true); // note section 6.3
    let any = false;
    for (let i = 0; i < b.length && !any; i++) any = b[i] !== 0;
    if (any) normalizeRows(b, k, this.scratch);
    else b.fill(0);
  }

  /** b = f * tiers(key)  (max into b when `maxInto`); diagonal 0. */
  private tiers(
    b: Float64Array,
    key: BarKey,
    f: number,
    maxInto: boolean,
  ): void {
    const k = this.k;
    const T = tierMatrix(key.mode);
    const tonic = mod12(key.tonic);
    const ix = this.tierIndex(tonic);
    for (let i = 0; i < k; i++) {
      const row = ix[i] * N;
      for (let j = 0; j < k; j++) {
        const v = i === j ? 0 : f * T[row + ix[j]];
        const p = i * k + j;
        b[p] = maxInto ? Math.max(b[p], v) : v;
      }
    }
  }

  /** state -> tier-matrix index relative to `tonic` (harmony._state_tiers' idx). */
  private tierIndex(tonic: number): Int32Array {
    let ix = this.ixCache.get(tonic);
    if (!ix) {
      ix = Int32Array.from(this.st, (s) => mod12(s.root - tonic) * NQ + s.qi);
      this.ixCache.set(tonic, ix);
    }
    return ix;
  }
}

export interface Pass2Options {
  perBeat?: number;
  /** Per-bar keys (keytrack.estimate(...).keys; analyze uses them when key.track == 'sections'). */
  barKeys: readonly BarKey[];
  /** Bar of each BEAT, length n / perBeat (analyze.py: (arange(n_beats) - phase) // beats_per_bar). */
  barOfBeat: ArrayLike<number>;
  /** chords.theory_prior (default 1.0). */
  strength?: number;
  mem?: MemTracker;
}

/**
 * analyze.py's 2nd chord pass: harmony.transition(vocab.states(cfg), bar_keys, bar_of_col, cfg) fed to
 * estimate_chords(..., prior, per_beat). All-zero prior -> `prior: null` (the same fast path Python takes).
 */
export function estimateChordsPass2(
  colChroma: ArrayLike<number>,
  n: number,
  cfg: ChordsConfig,
  opts: Pass2Options,
): ColumnChord[] {
  const perBeat = opts.perBeat ?? 1;
  if (opts.barOfBeat.length * perBeat !== n) {
    throw new Error(
      `barOfBeat has ${opts.barOfBeat.length} beats for ${n} columns at perBeat ${perBeat}`,
    );
  }
  const p = new TheoryPrior(
    vocab.states(cfg),
    opts.barKeys,
    opts.barOfBeat,
    opts.strength ?? DEFAULT_THEORY_PRIOR,
    { mem: opts.mem },
  );
  return estimateChords(colChroma, n, cfg, {
    perBeat,
    prior: p.isZero() ? null : p,
  });
}
