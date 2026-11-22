/**
 * Spike 7 T4: scoring of the identical-note pairs (plan §2.3, §5 "音が同じ組"). One unit = one pair reading: the truth
 * reading (root, quality) and the reading a rule chose. The main view is the 食い違う例 subset (`conflict`: the bass is not
 * the truth reading's root; TRUTH_ROWS marks them), the whole set is recorded beside it. Candidates are always kept, so
 * only the chosen reading is scored. Two reference rules for the table of §5:
 *   ベースだけ: the reading whose root is the bass; when neither reading's root is the bass, the "音だけ" reading.
 *   音だけ:     the reading whose quality is in the current vocabulary (v1a's tie rule; for every pair of §2.3 exactly one is).
 * The interval is Wilson (z = 1.96) over the units of the subset (see score.ts `wilson`).
 */
import { noteToPc } from '../../bass/score';
import { IDENTICAL_PAIRS } from '../identicalPairs';
import { STAGE_ADDS, stageQualities, suffix } from '../vocab';
import { wilson, type UnitRate } from './score';

export interface Reading {
  root: number;
  quality: string;
}

const BY_SUFFIX = new Map(stageQualities('V3').map((q) => [suffix(q), q] as const));

/** 'F#m7b5' -> { root: 6, quality: 'm7b5' }; names as `suffix` writes them (no /X). Throws on an unknown suffix. */
export function parseReading(name: string): Reading {
  const m = /^([A-G][#b]?)(.*)$/.exec(name);
  const quality = m ? BY_SUFFIX.get(m[2]) : undefined;
  if (!m || quality === undefined) throw new Error(`bad chord name: ${name}`);
  return { root: noteToPc(m[1]), quality };
}

/** Both readings of the identical pair `r` belongs to (r first), or null when `r` is in no pair. */
export function pairReadings(r: Reading): [Reading, Reading] | null {
  for (const p of IDENTICAL_PAIRS) {
    if (r.quality === p.a) return [r, { root: (r.root + p.offset) % 12, quality: p.b }];
    if (r.quality === p.b) return [r, { root: (r.root - p.offset + 12) % 12, quality: p.a }];
  }
  return null;
}

const CURRENT = new Set<string>(STAGE_ADDS.V0);
/** 音だけ: the reading in the current (v1a) vocabulary. */
export const soundOnlyReading = (pair: readonly [Reading, Reading]): Reading => pair.find((r) => CURRENT.has(r.quality)) ?? pair[0];
/** ベースだけ: the reading rooted on the bass; else 音だけ. */
export const bassOnlyReading = (pair: readonly [Reading, Reading], bassPc: number): Reading => pair.find((r) => r.root === bassPc) ?? soundOnlyReading(pair);

/** The reading of a result chord (null = none), and equality of a reading with a pair member. Shared by the eval tools. */
export const readingOf = (c: { root: string; quality: string } | undefined): Reading | null => (c ? { root: noteToPc(c.root), quality: c.quality } : null);
export const sameReading = (a: Reading | null, b: Reading): boolean => a !== null && a.root === b.root && a.quality === b.quality;

/** One truth-table row of an identical-pair segment, as the eval tools need it (T17: the one place that parses them). */
export interface PairUnit {
  id: string;
  conflict: boolean;
  truth: Reading;
  /** both readings of the truth's identical pair (truth first); null = the truth is in no pair */
  pair: [Reading, Reading] | null;
  /** middle of the truth segment, in seconds: where the result chord is read */
  mid: number;
  /** the row's bass (TRUTH_ROWS): the slash note, else the root */
  trueBass: number;
}
export function pairUnits(segments: readonly { start: number; end: number; rows?: readonly { id: string; truth: string; conflict: boolean }[] }[] | undefined): PairUnit[] {
  const out: PairUnit[] = [];
  for (const seg of segments ?? [])
    for (const row of seg.rows ?? []) {
      const truth = parseReading(row.truth.split('/')[0]);
      out.push({ id: row.id, conflict: row.conflict, truth, pair: pairReadings(truth), mid: (seg.start + seg.end) / 2, trueBass: row.truth.includes('/') ? noteToPc(row.truth.split('/')[1]) : truth.root });
    }
  return out;
}

export interface PairItem {
  id: string;
  conflict: boolean;
  truth: Reading;
  /** the reading a rule chose; null = none (a miss) */
  got: Reading | null;
}
export interface PairScores {
  conflict: UnitRate;
  nonConflict: UnitRate;
  all: UnitRate;
}

const unit = (xs: readonly PairItem[]): UnitRate => {
  const hit = xs.filter((x) => x.got !== null && x.got.root === x.truth.root && x.got.quality === x.truth.quality).length;
  return { hit, n: xs.length, rate: xs.length ? hit / xs.length : null, wilson: wilson(hit, xs.length) };
};
export const scorePairs = (items: readonly PairItem[]): PairScores => ({
  conflict: unit(items.filter((x) => x.conflict)),
  nonConflict: unit(items.filter((x) => !x.conflict)),
  all: unit(items),
});
