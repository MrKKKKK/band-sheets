/**
 * Spike 7 T9: the identical-pair reading (docs/audio-spike7-plan.md §2.3, decision 8; theory note §3.7, §3.8, §6.7).
 *
 * A post-pass. T10's form (pipeline.ts `pairsAfterBass`) runs it AFTER the spike 6 bass marks; that is the only form the
 * app-side code uses (NOT ADOPTED, G3 2026-11-22). The segment form here (applyDecisions, segmentBassPc) is T9's
 * measurement form, used by eval/t9_pairs.ts and the tests only. Every segment whose
 * reading is one reading of an identical pair of the stage (IDENTICAL_PAIRS: C6 = Am7, Am6 = F#m7b5, Csus2 = Gsus4)
 * is re-decided between the two readings with these points only (they are not added to the HMM, so nothing is
 * counted twice). Left to right: the previous segment is the reading already decided here, the next one is the
 * Viterbi reading. Values are the note's tier values, fixed (no tuning):
 *   bass              +1.0 when the bass note b is the reading's root
 *   context           tier(prev -> r) x confidence of r's key + tier(r -> next) x confidence of next's key
 *                     (strong 1.0 / medium 0.6 / weak 0.3 from harmony.json, new qualities through their family,
 *                     note §1.4; sus2 -> same-root major / minor / dominant family = medium, note §3.7 / §6.2)
 *   root continuation +0.6 when r's root is the root of the previous or the next segment (note §3.8)
 * `pairRule` 'context' uses all three; 'bassRoot' sets the context points to 0 (user, 2026-11-15).
 * The higher total wins; a tie (|difference| <= TIE_EPS) goes to the reading in the current (v1a) vocabulary.
 * The other reading is ALWAYS kept as a candidate (`chordCandidates`, no threshold; user, 2026-11-15).
 * aug and dim7 (same-quality symmetric groups) are outside this rule: their root stays v1a's ROOT_TIE.
 */
import type { ChordSegment } from '../dsp/chords';
import { colKeys, HARMONY, NQ, QUALITIES, tierMatrix } from '../dsp/harmony';
import type { BarKey } from '../dsp/keytrack';
import type { PairRule } from './config';
import { IDENTICAL_PAIRS } from './identicalPairs';
import { familyOf, STAGE_ADDS, stageQualities, type Stage } from './vocab';

export interface Reading {
  root: number;
  quality: string;
}

/** Plan §2.3 point values (fixed, not tuned). */
export const PAIR_POINTS = { bass: 1.0, rootContinuation: 0.6 } as const;
/** note §3.7 / §6.2 (v3 addition): sus2 -> the same root's major / minor / dominant family, medium. */
export const SUS2_RESOLUTION_TIER = HARMONY.tier.medium;
const SUS2_TARGETS = new Set([...HARMONY.family.M, ...HARMONY.family.m, ...HARMONY.family.D]);
/** Totals closer than this are a tie (sums of tier x confidence; guards float rounding only). */
export const TIE_EPS = 1e-9;

const CURRENT = new Set<string>(STAGE_ADDS.V0);
const N = 12 * NQ;
const QI = new Map<string, number>(QUALITIES.map((q, i) => [q, i]));
const mod12 = (x: number) => ((x % 12) + 12) % 12;
const same = (a: Reading, b: Reading) => a.root === b.root && a.quality === b.quality;

/** The other reading of `r`'s identical pair when both qualities exist at `stage`; else null (not a pair reading). */
export function otherReading(r: Reading, stage: Stage): Reading | null {
  const qs = stageQualities(stage);
  for (const p of IDENTICAL_PAIRS) {
    if (!qs.includes(p.a) || !qs.includes(p.b)) continue;
    if (r.quality === p.a) return { root: mod12(r.root + p.offset), quality: p.b };
    if (r.quality === p.b) return { root: mod12(r.root - p.offset), quality: p.a };
  }
  return null;
}

/**
 * Tier value (0, .3, .6, 1) of the move `from` -> `to` in `key` (harmony.json via tierMatrix, without the key
 * confidence). New qualities read their family's row / column (the max over a tuple family such as sus2's).
 */
export function transitionTier(from: Reading, to: Reading, key: Pick<BarKey, 'tonic' | 'mode'>): number {
  if (same(from, to)) return 0;
  const T = tierMatrix(key.mode);
  const da = mod12(from.root - key.tonic);
  const db = mod12(to.root - key.tonic);
  let v = 0;
  for (const qa of familyOf(from.quality))
    for (const qb of familyOf(to.quality)) {
      const i = da * NQ + (QI.get(qa) as number);
      const j = db * NQ + (QI.get(qb) as number);
      if (i !== j) v = Math.max(v, T[i * N + j]);
    }
  if (from.quality === 'sus2' && from.root === to.root && familyOf(to.quality).some((q) => SUS2_TARGETS.has(q))) v = Math.max(v, SUS2_RESOLUTION_TIER);
  return v;
}

/** What the points of one reading look at. */
export interface PairContext {
  prev: Reading | null;
  next: Reading | null;
  /** key at the segment's first beat (prev -> r) and at the next segment's first beat (r -> next); null = no key */
  key: BarKey | null;
  nextKey: BarKey | null;
  /** bass pitch class of the segment (the bass stage's note b); null = unknown (no bass points) */
  bass: number | null;
}
export interface PairScore {
  bass: number;
  context: number;
  root: number;
  total: number;
}

export function pairScore(r: Reading, c: PairContext, rule: Exclude<PairRule, 'off'>): PairScore {
  const bass = c.bass !== null && mod12(c.bass) === r.root ? PAIR_POINTS.bass : 0;
  let context = 0;
  if (rule === 'context') {
    if (c.prev && c.key) context += transitionTier(c.prev, r, c.key) * Math.max(c.key.confidence, 0);
    if (c.next && c.nextKey) context += transitionTier(r, c.next, c.nextKey) * Math.max(c.nextKey.confidence, 0);
  }
  const root = (c.prev && c.prev.root === r.root) || (c.next && c.next.root === r.root) ? PAIR_POINTS.rootContinuation : 0;
  return { bass, context, root, total: bass + context + root };
}

/** One segment as the post-pass sees it. root null = no chord. */
export interface PairSegment {
  root: number | null;
  quality: string;
  bass: number | null;
  key: BarKey | null;
}
export interface PairDecision {
  /** the Viterbi reading, the reading chosen here, and the other reading (always a candidate) */
  viterbi: Reading;
  chosen: Reading;
  other: Reading;
  scores: { chosen: PairScore; other: PairScore };
  tie: boolean;
}

/** Choose between the two readings; a tie goes to the reading in the current vocabulary (plan §2.3). */
export function choose(a: Reading, b: Reading, c: PairContext, rule: Exclude<PairRule, 'off'>): { chosen: Reading; other: Reading; sa: PairScore; sb: PairScore; tie: boolean } {
  const sa = pairScore(a, c, rule);
  const sb = pairScore(b, c, rule);
  const tie = Math.abs(sa.total - sb.total) <= TIE_EPS;
  const aWins = tie ? CURRENT.has(a.quality) : sa.total > sb.total;
  return aWins ? { chosen: a, other: b, sa, sb, tie } : { chosen: b, other: a, sa: sb, sb: sa, tie };
}

/** The post-pass over a segment list: one decision per segment (null = not a pair reading at `stage`). */
export function resolvePairs(segs: readonly PairSegment[], rule: Exclude<PairRule, 'off'>, stage: Stage): (PairDecision | null)[] {
  const reading = (s: PairSegment | undefined): Reading | null => (s && s.root !== null ? { root: mod12(s.root), quality: s.quality } : null);
  const out: (PairDecision | null)[] = [];
  let prev: Reading | null = null; // decided reading of the previous segment
  segs.forEach((s, i) => {
    const r = reading(s);
    const other = r ? otherReading(r, stage) : null;
    if (!r || !other) {
      out.push(null);
      prev = r;
      return;
    }
    const c: PairContext = { prev, next: reading(segs[i + 1]), key: s.key, nextKey: segs[i + 1]?.key ?? null, bass: s.bass };
    const d = choose(r, other, c, rule);
    out.push({ viterbi: r, chosen: d.chosen, other: d.other, scores: { chosen: d.sa, other: d.sb }, tie: d.tie });
    prev = d.chosen;
  });
  return out;
}

/** A chords2 segment: v1a's segment plus the other reading of an identical pair (plan §2.3, always kept). */
export type Chords2Segment = ChordSegment & { chordCandidates?: Reading[] };

/**
 * Bass note b the rule reads for a segment. With the B method off there is no bass stage: null (no bass points).
 * With a B method on, the segment's chord contains b (M3, plan §2.1): b = the slash bass, else the root.
 * T9's form only: T10 does not call this (pipeline.ts takes b from the marks, else spike 6's B-1 bass).
 */
export function segmentBassPc(seg: ChordSegment, bassMethod: string): number | null {
  if (bassMethod === 'off' || seg.root === null) return null;
  return seg.bass ?? seg.root;
}

/** Keys per segment (the BarKey of the segment's first beat); null without keys. */
export function segmentKeys(segs: readonly ChordSegment[], barKeys: readonly BarKey[], barOfBeat: ArrayLike<number>): (BarKey | null)[] {
  if (barKeys.length === 0 || barOfBeat.length === 0) return segs.map(() => null);
  const keys = colKeys(barKeys, barOfBeat);
  return segs.map((s) => keys[Math.min(Math.floor(s.startBeat / s.perBeat), keys.length - 1)] ?? null);
}

/**
 * Apply the decisions to segments: the chosen reading replaces root / quality (b stays the bass: `/b` when it is not
 * the new root; unknown b keeps the segment's bass), the other reading goes to `chordCandidates`. Other fields and
 * the top-k `candidates` are unchanged; segments that are no pair reading are returned as they are.
 */
export function applyDecisions(segs: readonly ChordSegment[], decisions: readonly (PairDecision | null)[], bass: readonly (number | null)[]): Chords2Segment[] {
  return segs.map((s, i) => {
    const d = decisions[i];
    if (!d) return s;
    const b = bass[i];
    const newBass = b === null ? s.bass : mod12(b) === d.chosen.root ? null : mod12(b);
    return { ...s, root: d.chosen.root, quality: d.chosen.quality, bass: same(d.chosen, d.viterbi) ? s.bass : newBass, chordCandidates: [d.other] };
  });
}
