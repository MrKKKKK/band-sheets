/**
 * Spike 7 T4: scoring of chords2 results (docs/audio-spike7-plan.md §5), in two vocabularies:
 *   'full' (全): the v2 vocabulary as it is. Truth quality = `originalQuality` (py/rec_truth.py --original-quality) when
 *                present, else `quality`; a truth chord outside FULL_QUALITIES (e.g. 13, aug7) is not scored.
 *   'down' (落): both sides mapped to v1a's vocabulary by mapDown.ts; a truth chord that maps to null is not scored.
 *
 * Why this does not call ts/bass/score.ts scoreBass / editCounts: they apply spike 6's `mapVocab` inside (so a "全"
 * quality would be dropped), and plan §4.1 keeps ts/bass/ unchanged. The point rules are the same as scoreBass's, and
 * score.test.ts checks that, with the same inputs and no mM7, 'down' gives scoreBass's / editCounts's numbers exactly:
 *  - Points: two per truth beat (25 % / 75 % of the beat window, weight 0.5 each; beatWindows from ts/bass/score.ts).
 *    The chord at t is "start <= t < end"; N / empty-root chords are ignored. The truth goes through normalizeTruthSlash
 *    (a truth X/X is not a slash chord); a result /X counts as /X even if it equals the root (as in scoreBass).
 *  - 名前 (コード名の当たり): root, quality and /X all match (both without /X, or the same bass pitch class).
 *  - 区間単位: each truth segment with a scored point is one unit; it is a hit when at least half of its scored points
 *    (by weight) are hits. The Wilson interval (z = 1.96) is on these units (plan §3.3 "区間単位の数で Wilson"): it is
 *    the interval of the UNIT rate only. A line on a POINT rate (spike 8 plan §3, carry-over 5) takes its interval
 *    from segmentTallies + bootstrap.ts segmentBootstrap (segments resampled, the point rate recomputed).
 *  - ベースにだけある音 (user decision 2026-11-15, plan §5): when the note that makes a truth chord's quality is only in
 *    the bass (`AmM7/G#` = Am over G#, `Am7/G`, `Am6/F#`; and the other way round `C/D` = `Cadd9/D`, `Am/G` = `Am7/G`),
 *    both names are a hit (name, edit counts), and those points are left out of `byQuality` and counted in `bassOnly`
 *    instead. `{ bassOnly: false }` turns this off (spike 6's scorer has no such rule: the parity test uses it).
 *  - 足す音の列 (spike 8 plan §5, T5; `added` and the segmentTallies measures, predicates in POINT_MEASURES):
 *    3 和音 = a truth whose full-vocabulary quality is its own triad (vocab.ts triadOf: maj, min, dim).
 *    triadName: the name rule on 3 和音 points (ベースにだけある音 points left out, as byQuality).
 *    overAdd (足しすぎ): 3 和音 points without /X where the result's quality is a triad plus an added tone (7, maj7, min7,
 *      m7b5, 6, m6, mM7, ...; any root: an Am7 on a C truth adds A to the triad too). No result chord = not over-added.
 *    asTriad (7th を 3 和音に読む): root matched and truth `7` / `min7` (E1; E2 also `6`, `m6`, `mM7`) read as their triad,
 *      full names in both vocabularies and every point counted (as spike 7's gate.ts seventhAsTriad, which reads it here).
 *    addedCandidate (候補を出した点): a shown candidate (candidates.ts cap) with the answer's root and triad but another
 *      quality (C7 under C, C6 under C7). Per 100 beats = rate x 100 (two points per beat).
 *    addedRecallE1 / addedPrecisionE1 (spike 8 T7, the E1 決め手): byQuality's root + quality rule over the E1 qualities
 *      pooled (7, maj7, min7, m7b5), truth side / result side; use them with vocab 'full'.
 */
import { noteToPc, beatWindows, normalizeTruthSlash, type ScoreBeat, type ScoreChord } from '../../bass/score';
import { at } from '../../bass/evalCommon';
import { fMeasure } from '../../drum/score';
import { shownCandidates } from '../candidates';
import { addedQualities, templates, stageQualities, triadOf } from '../vocab';
import { fullQuality, mapDown } from './mapDown';

export type Vocab = 'full' | 'down';

export interface EvalChord extends ScoreChord {
  /** Quality before it was collapsed (rec_truth.py --original-quality); truth only. */
  originalQuality?: string;
  /** Other readings of the same segment (result only): a name edit that one of them would fix is counted separately. */
  candidates?: { root: string; quality: string }[];
}

const W = 0.5;
const UNMAPPED = '?'; // a result quality outside the "落" vocabulary: matches nothing

const isNoChord = (c: ScoreChord): boolean => c.root === null || c.root === undefined || ['', 'N'].includes(String(c.root).trim());
const track = (cs: readonly ScoreChord[]): EvalChord[] => cs.filter((c) => !isNoChord(c)).sort((a, b) => a.start - b.start);

function bassPcOf(c: ScoreChord | undefined | null): number | null {
  const b = c?.bass;
  if (b === null || b === undefined || String(b).trim() === '') return null;
  try {
    return noteToPc(b);
  } catch {
    return null;
  }
}

/** Truth quality in the vocabulary, or null = not scored. */
export function truthQuality(c: EvalChord, vocab: Vocab): string | null {
  const q = c.originalQuality ?? c.quality;
  return vocab === 'full' ? fullQuality(q) : mapDown(q);
}
/** Result quality in the vocabulary (never null: an unmappable one cannot match). */
export function resultQuality(c: EvalChord, vocab: Vocab): string {
  return vocab === 'full' ? c.quality : (mapDown(c.quality) ?? UNMAPPED);
}

export interface ScoreOptions {
  /** the ベースにだけある音 rule (default true) */
  bassOnly?: boolean;
  /** editCounts only: called once per truth run (consecutive scored beats with the same truth name), in order; changes no count */
  onRun?: (r: EditRun) => void;
}

/** One truth run of editCounts (pitch classes; qualities in the call's vocabulary): its dominant result piece and name edit. */
export interface EditRun {
  truth: { root: number; q: string };
  /** the longest-overlap result piece (null = a stretch without a result chord) */
  dom: { root: number; q: string; bass: number | null } | null;
  beats: number;
  nameEdit: boolean;
  /** the name edit is fixed by a shown candidate (counted in nameFixableByCandidate) */
  fixable: boolean;
}

const V3 = stageQualities('V3');
const pcKey = (xs: Iterable<number>): string => [...new Set(xs)].sort((a, b) => a - b).join(',');
const sets = (q: string): string[] => templates(q).map((t) => pcKey(t));

/**
 * The other name of a truth chord whose quality-making note is only in the bass (full-vocabulary quality names), or
 * null. `rel` = the bass in semitones above the root. A: the quality has a template that is a 3-note quality's template
 * plus `rel` (AmM7/G# -> min). B: a 3-note quality whose template lacks `rel`, and the quality with that note added
 * (C/D -> add9, Am/G -> min7). A bass that is an ordinary chord tone (C/E, C6/E, Fm6/C) has no other name.
 */
export function bassOnlyAlternative(quality: string, rel: number): string | null {
  if (!V3.includes(quality)) return null;
  const triads = V3.filter((q) => templates(q).some((t) => t.length === 3));
  for (const t of templates(quality)) {
    if (t.length < 4 || !t.includes(rel)) continue;
    const rest = pcKey(t.filter((i) => i !== rel));
    const alt = triads.find((q) => sets(q).includes(rest));
    if (alt) return alt;
  }
  for (const t of templates(quality)) {
    if (t.length !== 3 || t.includes(rel)) continue;
    const plus = pcKey([...t, rel]);
    const alt = V3.find((q) => q !== quality && sets(q).includes(plus));
    if (alt) return alt;
  }
  return null;
}

/* ------------------------------------------------------------ Wilson */

export interface Interval {
  lo: number;
  hi: number;
}
/** Wilson score interval of k successes in n units (z = 1.96: 95 %); null when n is 0. */
export function wilson(k: number, n: number, z = 1.96): Interval | null {
  if (!n) return null;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/* ------------------------------------------------------------ the scored points */

interface Point {
  seg: number; // index of the truth segment
  tc: EvalChord;
  rc: EvalChord | null;
  tq: string;
  rq: string | null;
  tRoot: number;
  rRoot: number | null;
  tBass: number | null;
  rBass: number | null;
  /** the other truth name (in `vocab`) under the ベースにだけある音 rule, or null */
  tAlt: string | null;
}

/** The other truth quality in `vocab` (ベースにだけある音), or null. */
function truthAlt(tc: EvalChord, vocab: Vocab, on: boolean): string | null {
  const b = bassPcOf(tc);
  const q = fullQuality(tc.originalQuality ?? tc.quality);
  if (!on || b === null || q === null) return null;
  const alt = bassOnlyAlternative(q, (b - noteToPc(tc.root) + 12) % 12);
  return alt === null ? null : vocab === 'full' ? alt : mapDown(alt);
}

/** Scored points, plus the weight of truth points that were not scored (dropped quality). */
function scoredPoints(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab, on: boolean): { pts: Point[]; droppedPoints: number } {
  const tt = track(normalizeTruthSlash(truth) as EvalChord[]);
  const rt = track(result);
  const pts: Point[] = [];
  let droppedPoints = 0;
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const t = w[0] + f * (w[2] - w[0]);
      const tc = at(tt, t);
      if (!tc) continue;
      const tq = truthQuality(tc, vocab);
      if (tq === null) {
        droppedPoints += W;
        continue;
      }
      const rc = at(rt, t) ?? null;
      pts.push({
        seg: tt.indexOf(tc),
        tc,
        rc,
        tq,
        rq: rc ? resultQuality(rc, vocab) : null,
        tRoot: noteToPc(tc.root),
        rRoot: rc ? noteToPc(rc.root) : null,
        tBass: bassPcOf(tc),
        rBass: bassPcOf(rc),
        tAlt: truthAlt(tc, vocab, on),
      });
    }
  return { pts, droppedPoints };
}

/* ------------------------------------------------------------ metrics */

export interface Rate {
  hit: number;
  n: number;
  rate: number | null;
}
export interface UnitRate extends Rate {
  wilson: Interval | null;
}
const rate = (hit: number, n: number): Rate => ({ hit, n, rate: n ? hit / n : null });

/** Per-point hits of `ok` over `pts`, as weighted points and as truth-segment units. */
function tally(pts: readonly Point[], ok: (p: Point) => boolean, inScope: (p: Point) => boolean = () => true): { points: Rate; units: UnitRate } {
  let hit = 0;
  let n = 0;
  const seg = new Map<number, { hit: number; n: number }>();
  for (const p of pts) {
    if (!inScope(p)) continue;
    n += W;
    const s = seg.get(p.seg) ?? { hit: 0, n: 0 };
    s.n += W;
    if (ok(p)) {
      hit += W;
      s.hit += W;
    }
    seg.set(p.seg, s);
  }
  const uHit = [...seg.values()].filter((s) => s.hit * 2 >= s.n).length;
  return { points: rate(hit, n), units: { ...rate(uHit, seg.size), wilson: wilson(uHit, seg.size) } };
}

export interface QualityRow {
  /** truth points of this quality / of those, root and quality matched */
  truth: Rate;
  /** result points of this quality over scored points / of those, root and quality matched */
  result: Rate;
}

export interface ChordScores {
  vocab: Vocab;
  /** weighted scored points (0.5 per point) */
  nPoints: number;
  /** weight of truth points not scored (quality outside the vocabulary) */
  droppedPoints: number;
  /** weight of scored points where the result has no chord */
  noChordPoints: number;
  name: { points: Rate; units: UnitRate };
  root: Rate;
  /** truth has /X: the result root matches */
  slashRoot: { points: Rate; units: UnitRate };
  /** truth has /X: the result bass pitch class is the truth's (recall) / result has /X: it is the truth's (precision) */
  slash: { truthSlash: number; resultSlash: number; hit: number; recall: number | null; precision: number | null; f: number };
  /** truth has no /X: the share where the result has one (of all such points / of those with a result chord) */
  wrongSlash: { noSlashTruth: number; falseSlash: number; rate: number | null; onChordPoints: Rate };
  /** per quality of the vocabulary: recall (truth side) and precision (result side) of root + quality; the bassOnly points are left out */
  byQuality: Record<string, QualityRow>;
  /** points whose truth has a ベースにだけある音 (both names hit): the name hits on them, kept apart from byQuality */
  bassOnly: { points: Rate; units: UnitRate };
  /** spike 8 §5 足す音の列 (header; per segment: segmentTallies with the same measure) */
  added: {
    triadName: Rate;
    overAdd: Rate;
    addedCandidate: Rate;
    /** points of each truth quality (`7`, `min7`, E2's `6`, `m6`, `mM7`) read as its triad (AS_TRIAD) */
    asTriad: Record<AsTriadTruth, number>;
  };
}

/* ------------------------------------------------------------ 足す音の列 (spike 8 §5) */

/** Plan §5 "7th を 3 和音に読む": truth quality -> the triad reading counted, per range (E2 = E1 + 6 / m6 / mM7). */
export const AS_TRIAD = {
  E1: { '7': 'maj', min7: 'min' },
  E2: { '7': 'maj', min7: 'min', '6': 'maj', m6: 'min', mM7: 'min' },
} as const satisfies Record<string, Record<string, string>>;
export type AsTriadTruth = keyof (typeof AS_TRIAD)['E2'];

const fullTruth = (p: Point): string | null => truthQuality(p.tc, 'full');
const isTriad = (q: string | null): boolean => q !== null && triadOf(q) === q;
/** a triad plus an added tone (vocab.ts triadOf family, not the triad itself) */
const isAdded = (q: string): boolean => triadOf(q) !== null && triadOf(q) !== q;
const asTriadOf = (p: Point, map: Readonly<Record<string, string>>): boolean => {
  const tq = fullTruth(p);
  return p.rc !== null && p.rRoot === p.tRoot && tq !== null && tq in map && p.rc.quality === map[tq];
};
/** The added-tone candidates a result chord shows: shown (candidates.ts cap), the answer's root and triad, another quality. */
export const shownAddedCandidates = (rc: EvalChord): { root: string; quality: string }[] =>
  triadOf(rc.quality) === null ? [] : shownCandidates({ root: rc.root, quality: rc.quality }, rc.candidates ?? []).filter((c) => noteToPc(c.root) === noteToPc(rc.root) && c.quality !== rc.quality && triadOf(c.quality) === triadOf(rc.quality));
const addedCandidateOk = (p: Point): boolean => p.rc !== null && shownAddedCandidates(p.rc).length > 0;

/** the truth's own (root, quality) is among the SHOWN candidates of the result piece */
const correctShown = (p: Point): boolean => {
  const rc = p.rc;
  if (!rc) return false;
  return shownCandidates({ root: rc.root, quality: rc.quality }, rc.candidates ?? []).some((c) => noteToPc(c.root) === p.tRoot && c.quality === fullTruth(p));
};

const E1_Q = new Set(addedQualities('E1')); // 7, maj7, min7, m7b5
const rootQualityOk = (p: Point): boolean => p.rRoot === p.tRoot && p.rq === p.tq;
const nameOk = (p: Point): boolean => p.rc !== null && p.rRoot === p.tRoot && (p.rq === p.tq || (p.tAlt !== null && p.rq === p.tAlt)) && p.rBass === p.tBass;
const rootOk = (p: Point): boolean => p.rRoot === p.tRoot;

/** A point-rate measure: the points in scope and the hit rule. */
interface PointMeasure {
  scope: (p: Point) => boolean;
  ok: (p: Point) => boolean;
}
const all = (): boolean => true;
const POINT_MEASURES = {
  root: { scope: all, ok: rootOk },
  name: { scope: all, ok: nameOk },
  slashRoot: { scope: (p) => p.tBass !== null, ok: rootOk },
  triadName: { scope: (p) => p.tAlt === null && isTriad(fullTruth(p)), ok: nameOk },
  overAdd: { scope: (p) => p.tBass === null && isTriad(fullTruth(p)), ok: (p) => p.rc !== null && isAdded(p.rc.quality) },
  addedCandidate: { scope: all, ok: addedCandidateOk },
  asTriadE1: { scope: (p) => (fullTruth(p) ?? '') in AS_TRIAD.E1, ok: (p) => asTriadOf(p, AS_TRIAD.E1) },
  asTriadE2: { scope: (p) => (fullTruth(p) ?? '') in AS_TRIAD.E2, ok: (p) => asTriadOf(p, AS_TRIAD.E2) },
  // spike 8 T7 (plan §5 決め手): the E1 qualities pooled, root + quality as byQuality (ベースにだけある音 points left out)
  // spike 8 G1 §2 (candidates-only E1): decision 9's points whose correct 7th is also NOT among the shown candidates, and the
  // 3 和音 points that carry an added-tone candidate (the share of them, a-f recordings)
  asTriadHidden: { scope: (p) => (fullTruth(p) ?? '') in AS_TRIAD.E1, ok: (p) => asTriadOf(p, AS_TRIAD.E1) && !correctShown(p) },
  triadCandidate: { scope: (p) => p.tAlt === null && isTriad(fullTruth(p)), ok: addedCandidateOk },
  addedRecallE1: { scope: (p) => p.tAlt === null && E1_Q.has(p.tq), ok: rootQualityOk },
  addedPrecisionE1: { scope: (p) => p.tAlt === null && p.rq !== null && E1_Q.has(p.rq), ok: rootQualityOk },
} satisfies Record<string, PointMeasure>;
export type Measure = keyof typeof POINT_MEASURES;
const measure = (pts: readonly Point[], m: Measure) => tally(pts, POINT_MEASURES[m].ok, POINT_MEASURES[m].scope);

export function scoreChords(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab, opts: ScoreOptions = {}): ChordScores {
  const { pts, droppedPoints } = scoredPoints(truth, result, beats, vocab, opts.bassOnly ?? true);
  const slashRoot = measure(pts, 'slashRoot');
  let truthSlash = 0, resultSlash = 0, slashHit = 0, noSlash = 0, falseSlash = 0, noSlashChord = 0, falseSlashChord = 0, noChord = 0;
  for (const p of pts) {
    if (!p.rc) noChord += W;
    if (p.rBass !== null) resultSlash += W;
    if (p.tBass !== null) {
      truthSlash += W;
      if (p.rBass === p.tBass) slashHit += W;
    } else {
      noSlash += W;
      if (p.rc) noSlashChord += W;
      if (p.rBass !== null) {
        falseSlash += W;
        falseSlashChord += W;
      }
    }
  }
  const recall = truthSlash ? slashHit / truthSlash : null;
  const precision = resultSlash ? slashHit / resultSlash : null;
  const byQuality: Record<string, QualityRow> = {};
  const row = (q: string): QualityRow => (byQuality[q] ??= { truth: rate(0, 0), result: rate(0, 0) });
  const bump = (r: Rate, hit: boolean): void => {
    r.n += W;
    if (hit) r.hit += W;
    r.rate = r.hit / r.n;
  };
  for (const p of pts) {
    if (p.tAlt !== null) continue;
    const both = p.rRoot === p.tRoot && p.rq === p.tq;
    bump(row(p.tq).truth, both);
    if (p.rq !== null) bump(row(p.rq).result, both);
  }
  return {
    vocab,
    nPoints: pts.length * W,
    droppedPoints,
    noChordPoints: noChord,
    name: measure(pts, 'name'),
    root: measure(pts, 'root').points,
    slashRoot,
    slash: { truthSlash, resultSlash, hit: slashHit, recall, precision, f: recall && precision ? fMeasure(precision, recall) : 0 },
    wrongSlash: { noSlashTruth: noSlash, falseSlash, rate: noSlash ? falseSlash / noSlash : null, onChordPoints: rate(falseSlashChord, noSlashChord) },
    byQuality,
    bassOnly: tally(pts, nameOk, (p) => p.tAlt !== null),
    added: {
      triadName: measure(pts, 'triadName').points,
      overAdd: measure(pts, 'overAdd').points,
      addedCandidate: measure(pts, 'addedCandidate').points,
      asTriad: Object.fromEntries(Object.entries(AS_TRIAD.E2).map(([tq, rq]) => [tq, tally(pts, (p) => asTriadOf(p, { [tq]: rq })).points.hit])) as Record<AsTriadTruth, number>,
    },
  };
}

/** One truth segment of a point-rate line: its hit points and scored points (weights, 0.5 per point). */
export interface SegmentTally {
  hit: number;
  n: number;
}

/** A SegmentTally with its truth segment (index in the file's truth track, as score.ts numbers it): pairs rows on the same segment (spike 8 T7). */
export interface SegmentUnit extends SegmentTally {
  seg: number;
}

/**
 * The points of a `scoreChords` measure per truth segment (segments with a point in the measure's scope only, in truth
 * order), with the segment's index, so two rows on the same file can be paired segment by segment (bootstrap.ts
 * pairUnits) and a line against a base row gets a paired interval. Their sums are the line's points (hit / n).
 */
export function segmentUnits(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab, measure: Measure, opts: ScoreOptions = {}): SegmentUnit[] {
  const { pts } = scoredPoints(truth, result, beats, vocab, opts.bassOnly ?? true);
  const { ok, scope } = POINT_MEASURES[measure];
  const seg = new Map<number, SegmentUnit>();
  for (const p of pts) {
    if (!scope(p)) continue;
    const s = seg.get(p.seg) ?? { seg: p.seg, hit: 0, n: 0 };
    s.n += W;
    if (ok(p)) s.hit += W;
    seg.set(p.seg, s);
  }
  return [...seg.values()].sort((a, b) => a.seg - b.seg);
}

/**
 * segmentUnits without the segment index, so a point-rate or point-count line gets its interval from the same unit:
 * segmentBootstrap(..., pointRate / pointSum) in bootstrap.ts. Their sums are the line's points (hit / n): name,
 * slashRoot.points, added.*.
 */
export const segmentTallies = (...a: Parameters<typeof segmentUnits>): SegmentTally[] => segmentUnits(...a).map(({ hit, n }) => ({ hit, n }));

/* ------------------------------------------------------------ edit counts (直す手数) */

export interface EditCounts {
  name: number;
  slashAdd: number;
  slashRemove: number;
  slashChange: number;
  split: number;
  merge: number;
  total: number;
  nBeats: number;
  /** name edits where the truth (root, quality; or its ベースにだけある音 other name) is among the SHOWN candidates of the dominant result piece (candidates.ts cap; "選べば直せる"; a subset of `name`) */
  nameFixableByCandidate: number;
}
interface Label {
  root: number;
  q: string;
  bass: number | null;
  piece: number;
  cands: string[];
}

/** Spike 6's editCounts (ts/bass/score.ts) over `vocab`: beats with no truth chord or an unscored truth quality are skipped. */
export function editCounts(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab, opts: ScoreOptions = {}): EditCounts {
  const tt = track(normalizeTruthSlash(truth) as EvalChord[]);
  const rt = track(result);
  const tl: { root: number; q: string; bass: number | null; alt: string | null }[] = [];
  const rl: (Label | null)[] = [];
  let piece = -1;
  let prevKey: string | null = null;
  for (const w of beatWindows(beats)) {
    const tc = at(tt, w[1]);
    const tq = tc ? truthQuality(tc, vocab) : null;
    if (!tc || tq === null) continue;
    tl.push({ root: noteToPc(tc.root), q: tq, bass: bassPcOf(tc), alt: truthAlt(tc, vocab, opts.bassOnly ?? true) });
    const rc = at(rt, w[1]);
    if (!rc) {
      rl.push(null);
      prevKey = null;
      continue;
    }
    const l = { root: noteToPc(rc.root), q: resultQuality(rc, vocab), bass: bassPcOf(rc) };
    const key = `${l.root}|${l.q}|${l.bass}`;
    if (key !== prevKey) piece++;
    prevKey = key;
    // the shown candidates only (candidates.ts: at most CANDIDATE_CAP besides the answer, pair reading first)
    const shown = shownCandidates({ root: rc.root, quality: rc.quality }, rc.candidates ?? []);
    rl.push({ ...l, piece, cands: shown.map((x) => `${noteToPc(x.root)}|${vocab === 'full' ? x.quality : (mapDown(x.quality) ?? UNMAPPED)}`) });
  }
  const c: EditCounts = { name: 0, slashAdd: 0, slashRemove: 0, slashChange: 0, split: 0, merge: 0, total: 0, nBeats: tl.length, nameFixableByCandidate: 0 };
  const k = (x: { root: number; q: string; bass: number | null }): string => `${x.root}|${x.q}|${x.bass}`;
  let i = 0;
  while (i < tl.length) {
    let j = i;
    while (j + 1 < tl.length && k(tl[j + 1]) === k(tl[i])) j++;
    const counts = new Map<number, { n: number; l: Label | null }>();
    let gapRun = -1;
    let prevNull = false;
    for (let b = i; b <= j; b++) {
      const l = rl[b];
      const id = l ? l.piece : prevNull ? gapRun : (gapRun = -1000 - b);
      prevNull = !l;
      const e = counts.get(id) ?? { n: 0, l };
      e.n++;
      counts.set(id, e);
    }
    c.merge += counts.size - 1;
    const dom = [...counts.values()].reduce((a, b) => (b.n > a.n ? b : a));
    const t = tl[i];
    const nameEdit = !dom.l || dom.l.root !== t.root || (dom.l.q !== t.q && dom.l.q !== t.alt);
    // either truth name fixes it (ベースにだけある音: the other name is a hit too)
    const fixable = nameEdit && !!dom.l && (dom.l.cands.includes(`${t.root}|${t.q}`) || (t.alt !== null && dom.l.cands.includes(`${t.root}|${t.alt}`)));
    if (nameEdit) c.name++;
    if (fixable) c.nameFixableByCandidate++;
    opts.onRun?.({ truth: { root: t.root, q: t.q }, dom: dom.l ? { root: dom.l.root, q: dom.l.q, bass: dom.l.bass } : null, beats: j - i + 1, nameEdit, fixable });
    const rb = dom.l ? dom.l.bass : null;
    if (t.bass === null && rb !== null) c.slashRemove++;
    else if (t.bass !== null && rb === null) c.slashAdd++;
    else if (t.bass !== null && rb !== t.bass) c.slashChange++;
    if (j + 1 < tl.length && rl[j] && rl[j + 1] && rl[j]!.piece === rl[j + 1]!.piece) c.split++;
    i = j + 1;
  }
  c.total = c.name + c.slashAdd + c.slashRemove + c.slashChange + c.split + c.merge;
  return c;
}

export interface EditDiff {
  withBass: EditCounts;
  withoutBass: EditCounts;
  /** (without - with) / nBeats * 100; positive = the bass analysis saves edits. null without scored beats. */
  savedPer100Beats: number | null;
}
export function editDiff(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab, opts: ScoreOptions = {}): EditDiff {
  const withBass = editCounts(truth, result, beats, vocab, opts);
  const withoutBass = editCounts(truth, result.map((c) => ({ ...c, bass: null })), beats, vocab, opts);
  return { withBass, withoutBass, savedPer100Beats: withBass.nBeats ? ((withoutBass.total - withBass.total) / withBass.nBeats) * 100 : null };
}
