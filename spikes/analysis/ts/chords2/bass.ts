/**
 * NOT ADOPTED (G2, user 2026-11-22: none of M1-M3; spike 6's bass config stays). Kept as switches (bass.method, default
 * 'off'); nothing in the app calls this file.
 *
 * Spike 7 T8: method B "use the bass for the root" (docs/audio-spike7-plan.md §2.1, G1 decision 8; docs/audio-spike7-t8.md).
 *
 * v1a reads full-band chroma, so a low bass note and its 3rd harmonic (its 5th) push the chord built on the bass
 * (`C/E` read as `Em`, root offset +4). Three methods, switched by `bass.method` (Chords2Config; values and the tuning in
 * config.ts DEFAULT_BASS_METHOD_VALUES):
 *  - M1 (chord stage): the templates are scored on the full chroma minus `m1.trebleWeight` x the v1a bass-band chroma
 *    (C1-B3, per chord column), so the bass note no longer votes for the chord built on it. `scoreChroma` below; the
 *    no-chord test still reads the full chroma (analyze.ts).
 *  - M3 (after the chord stage, per segment): spike 6's `redecideRoot` generalized. Only a segment whose root IS its
 *    bass b (B-1, ts/bass/segmentBass.ts) is re-decided: that is the error M3 is for (`C/E` read as `Em`). Among the
 *    chords of the same size class (triads maj / min, sevenths 7 / maj7 / min7) that contain b, the one whose template
 *    fits the treble chroma best (above C3 with b's harmonics taken out, ts/bass/redecide.ts trebleChroma; cosine)
 *    replaces v1a's root-position reading when it beats it by `margin` (a close treble keeps the root position).
 *    Chords with the same notes as the current one (identical pairs) are never chosen (plan §2.3 decides those).
 *    Both restrictions come from the tuning split (docs/audio-spike7-t8.md): without them a left hand playing
 *    5-1-5'-1 (LR) leaves its 5th's harmonics in the treble and M3 moved `C` to `G` (LR name .806 -> .78).
 *  - M2 (chord stage, G1: built because M1 and M3 both missed G1 lines on the tuning split): the states become
 *    (chord, one of its tones as the bass); emission = the M1 score + `bassWeight` x that tone's bass-band chroma
 *    (+ `rootBonus` for the root). The prior is the chord's (ExpandedPrior); the decoded chord and its posterior are
 *    the chord parts (analyze.ts). About 3.5 x the states of V0.
 * All three then go through spike 6's slash marks (B-1 / B-2 / B-3 `bassChords`, called, not changed) with `marksConfig()`
 * = the G2 default without spike 6's own root re-decision (M3 replaces it; M1 / M2 are compared without it).
 * Ground truth is never read here. No network: computation only.
 */
import { bassChords, type V1aChord } from '../bass/analyze';
import type { BassConfig } from '../bass/config';
import type { LowCqt } from '../bass/lowCqt';
import { trebleChroma } from '../bass/redecide';
import { segmentBass, type SegmentBass } from '../bass/segmentBass';
import type { SlashFields } from '../bass/slash';
import { chordName, NOTE_NAMES } from '../dsp/chords';
import type { PriorRows } from '../dsp/chords';
import { intervals, type ChordState } from '../dsp/vocab';
import { templates } from './vocab';
import { appBassConfig, bassValues, type BassMethodValues, type Chords2Config } from './config';

/** Spike 6 marks used by every T8 method: G2 default (split on, weakMinConfidence 0.4) without `redecideRoot` (= config.ts appBassConfig). */
export const marksConfig = appBassConfig;

/**
 * M1: the chroma the templates are scored on, [12, n]: max(0, full - w * bass). `bass` is v1a's bass-band chroma per
 * chord column (same frames and column bounds as `full`). Without M1 / M2 (or without `bass`) the full chroma itself.
 */
export function scoreChroma(full: Float64Array, bass: ArrayLike<number> | undefined, cfg: Chords2Config): Float64Array {
  if (cfg.bass.method !== 'M1' && cfg.bass.method !== 'M2') return full; // M2 scores its chords on the M1 chroma too
  if (!bass) throw new Error(`chords2: bass.method=${cfg.bass.method} needs the per-column bass chroma (input.bassChroma)`);
  if (bass.length !== full.length) throw new Error(`chords2: bassChroma length ${bass.length} != chroma length ${full.length}`);
  const v = bassValues(cfg);
  const w = cfg.bass.method === 'M1' ? v.m1.trebleWeight : v.m2.trebleWeight;
  const out = new Float64Array(full.length);
  for (let i = 0; i < full.length; i++) out[i] = Math.max(0, full[i] - w * bass[i]);
  return out;
}

/* ------------------------------------------------------------------ M2 */

export interface M2States {
  /** expanded emission [k, n]: chord score (M1 chroma, gated) + bassWeight x bass chroma of the tone + rootBonus at the root */
  emis: Float64Array;
  k: number;
  /** the chord state of each expanded state */
  base: Int32Array;
}

/**
 * M2: every chord state times each of its tones as the bass (a state's first template). Emission of (chord i, tone b)
 * = s[i] + bassWeight * B[b] + rootBonus * [b is the root], where B is the column's bass-band chroma divided by its
 * maximum (0 for a silent bass). A state the gates switched off (s = 0, also every state of a no-chord column) stays 0.
 */
export function m2Expand(s: Float64Array, sts: readonly ChordState[], bassChroma: ArrayLike<number> | undefined, n: number, v: BassMethodValues): M2States {
  if (!bassChroma || bassChroma.length !== 12 * n) throw new Error('chords2: bass.method=M2 needs the per-column bass chroma (input.bassChroma)');
  const base: number[] = [];
  const tone: number[] = [];
  sts.forEach((st, i) => templates(st.quality)[0].forEach((iv) => (base.push(i), tone.push((st.root + iv) % 12))));
  const k = base.length;
  const bn = new Float64Array(12 * n);
  for (let t = 0; t < n; t++) {
    let mx = 0;
    for (let j = 0; j < 12; j++) mx = Math.max(mx, bassChroma[j * n + t]);
    if (mx > 0) for (let j = 0; j < 12; j++) bn[j * n + t] = bassChroma[j * n + t] / mx;
  }
  const emis = new Float64Array(k * n);
  for (let e = 0; e < k; e++) {
    const i = base[e];
    const isRoot = tone[e] === sts[i].root % 12 ? v.m2.rootBonus : 0;
    for (let t = 0; t < n; t++) {
      const x = s[i * n + t];
      emis[e * n + t] = x === 0 ? 0 : x + v.m2.bassWeight * bn[tone[e] * n + t] + isRoot;
    }
  }
  return { emis, k, base: Int32Array.from(base) };
}

/** The chord prior seen by the expanded states: entry (a, b) = the chord prior's (base[a], base[b]). Rows are cached. */
export class ExpandedPrior implements PriorRows {
  readonly rows: number;
  private last = -1;
  private readonly buf: Float64Array;
  constructor(private readonly inner: PriorRows, private readonly base: Int32Array, private readonly k0: number) {
    this.rows = inner.rows;
    this.buf = new Float64Array(base.length * base.length);
  }
  isZero(): boolean {
    return this.inner.isZero?.() ?? false;
  }
  row(r: number): ArrayLike<number> {
    if (r === this.last) return this.buf;
    const P = this.inner.row(r);
    const k = this.base.length;
    for (let a = 0; a < k; a++) {
      const o = this.base[a] * this.k0;
      for (let b = 0; b < k; b++) this.buf[a * k + b] = P[o + this.base[b]];
    }
    this.last = r;
    return this.buf;
  }
}

/** Posterior of the expanded states summed per chord state: [k0, n]. */
export function collapsePosterior(post: Float64Array, base: Int32Array, k0: number, n: number): Float64Array {
  const out = new Float64Array(k0 * n);
  base.forEach((i, e) => {
    for (let t = 0; t < n; t++) out[i * n + t] += post[e * n + t];
  });
  return out;
}

/* ------------------------------------------------------------------ M3 */

const pc = (x: number): number => ((x % 12) + 12) % 12;
const TRIADS = ['maj', 'min'] as const;
const SEVENTHS = ['7', 'maj7', 'min7'] as const;
/** The size class M3 chooses within (null = M3 leaves the chord alone: dim, aug, sus4, m7b5, dim7, new qualities). */
const sizeClass = (q: string): readonly string[] | null => ((TRIADS as readonly string[]).includes(q) ? TRIADS : (SEVENTHS as readonly string[]).includes(q) ? SEVENTHS : null);
const tonesOf = (root: number, q: string): number[] => intervals(q).map((i) => pc(root + i));
const setKey = (xs: number[]): string => [...new Set(xs)].sort((a, b) => a - b).join(',');

export interface Reading {
  root: number;
  quality: string;
}

/** Template cosine of a reading on a treble chroma (any scale; 0 for an all-zero chroma). */
export function m3Score(r: Reading, treble: ArrayLike<number>): number {
  let norm = 0;
  for (let j = 0; j < 12; j++) norm += treble[j] * treble[j];
  norm = Math.sqrt(norm) || 1;
  const tones = tonesOf(r.root, r.quality);
  let s = 0;
  for (const t of tones) s += treble[t] / norm;
  return s / Math.sqrt(tones.length);
}

/** M3 on one segment: the re-chosen reading, or null (keep). Pure; `treble` = the segment's treble chroma. */
export function m3Choose(cur: Reading, bass: Pick<SegmentBass, 'pc' | 'confidence'>, treble: ArrayLike<number>, m3: BassMethodValues['m3'], minConfidence: number): Reading | null {
  const cls = sizeClass(cur.quality);
  const b = pc(bass.pc);
  if (!cls || bass.confidence < minConfidence || cur.root !== b) return null;
  const curSet = setKey(tonesOf(cur.root, cur.quality));
  let best: Reading | null = null;
  let bestScore = m3Score(cur, treble) + m3.margin;
  for (const quality of cls)
    for (let root = 0; root < 12; root++) {
      const tones = tonesOf(root, quality);
      if (!tones.includes(b) || setKey(tones) === curSet) continue; // must hold the bass; not itself / the same notes (§2.3)
      const s = m3Score({ root, quality }, treble);
      if (s >= bestScore) {
        best = { root, quality };
        bestScore = s;
      }
    }
  return best;
}

/** M3 over timed segments (same objects where nothing changed; `text` rebuilt, `candidates` kept as v1a's). */
export function m3Redecide<C extends V1aChord>(low: LowCqt, chords: readonly C[], sb: readonly SegmentBass[], cfg: Chords2Config, minConfidence: number): C[] {
  return chords.map((c, i) => {
    const rootPc = (NOTE_NAMES as readonly string[]).indexOf(c.root);
    if (rootPc < 0) throw new Error(`chords2 M3: unexpected chord root ${JSON.stringify(c.root)}`);
    if (!sizeClass(c.quality)) return c;
    const r = m3Choose({ root: rootPc, quality: c.quality }, sb[i], trebleChroma(low, c, sb[i].midi), bassValues(cfg).m3, minConfidence);
    if (!r) return c;
    const text = c.text === undefined ? undefined : `${chordName(r.root, r.quality)}${c.text.endsWith('?') ? '?' : ''}`;
    return { ...c, root: NOTE_NAMES[r.root], quality: r.quality, ...(text === undefined ? {} : { text }) };
  });
}

/**
 * The bass stage of chords2 on timed segments (`beats` = beat times): M3 re-decision when chosen, then spike 6's
 * marks (`bassChords`). `marks` must not turn spike 6's own `redecideRoot` on (M3 replaces it). Method 'off' = no
 * bass stage (the chords are returned as they are, no `/X`).
 */
export function bassStage<C extends V1aChord>(low: LowCqt, chords: readonly C[], beats: readonly number[], cfg: Chords2Config, marks: BassConfig = marksConfig()): (C & Partial<SlashFields>)[] {
  if (cfg.bass.method === 'off') return [...chords];
  if (!marks.enabled || marks.cliche.redecideRoot) throw new Error('chords2 bassStage: marks must be an enabled bass config without cliche.redecideRoot');
  const segs = cfg.bass.method === 'M3' ? m3Redecide(low, chords, segmentBass(low, chords, beats, marks.segment), cfg, marks.slash.minConfidence) : chords;
  return bassChords(low, segs, beats, marks);
}
