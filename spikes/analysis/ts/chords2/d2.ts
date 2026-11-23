/**
 * Spike 8 T5, D2 "triad first, then the added tone" (docs/audio-spike8-plan.md §2.2, §2.3; docs/audio-spike8-t5.md).
 * Runs on chords2's V0 (= v1a) Viterbi columns, before they are merged into segments, so `C – C7` and a cliché are not
 * squashed into one segment (spike 7 U1):
 *   1. per column: root and triad (vocab.ts triadOf: 7 / maj7 -> maj, min7 -> min, m7b5 -> dim) of the Viterbi state;
 *      dim7 / aug / sus4 columns and no-chord columns pass through unchanged;
 *   2-4. ρ(d) on the column's beat (front/ratio.ts addedRatios; the formula is not copied here) for the range's d
 *      (ADDS); the stronger of the minor / major 7th only; 6 and 7 both: the 7th, the 6th a candidate (`evalAdded`);
 *   5. over each run of columns with the same root and triad, a 2-state ("plain" / "added") Viterbi with one switch
 *      penalty (`smooth`; "added" scores ρ - θ per beat, "plain" 0), then the added tone's name per column. The caller
 *      merges the columns into segments again (mergeChords), so a different added tone splits a segment.
 * Candidates (`d2Candidates`): θ_low <= ρ < θ gives a candidate only; the other reading of an identical pair
 * (pairRule.ts otherReading; E2 only, C6 = Am7, Am6 = F#m7b5) always comes first (spike 7 decision 8). No pair rule here.
 * No ground truth is read. No network: computation only.
 */
import type { ColumnChord } from '../dsp/chords';
import type { AddedRange, D2Values } from './config';
import type { F1Config } from './front/config';
import type { F1Beat, F1Note } from './front/f1';
import { addedRatios } from './front/ratio';
import { otherReading, type Reading } from './pairRule';
import { ADDS, TRIADS, triadOf, type Stage, type Triad } from './vocab';

/** The vocabulary stage whose identical pairs a range can output (E2's 6 / m6 / mM7 are V1's qualities). */
const PAIR_STAGE: Record<AddedRange, Stage> = { E1: 'V0', E2: 'V1' };

export interface AddedEval {
  /** ρ(d) per interval of the range */
  rho: Record<number, number>;
  /** the quality the "added" state names, and max ρ - θ (the "added" state's score before the per-beat weight) */
  added: string;
  evidence: number;
  /** max ρ >= θ_low (a column below it takes its added tone from its neighbours in `applyD2`) */
  strong: boolean;
  /** candidate qualities (θ_low <= ρ) when the column ends up "added" / "plain" */
  candIfAdded: string[];
  candIfPlain: string[];
}

/** Plan §2.2 step 4 on one beat's F1 notes for root pitch class `root` over `triad`. */
export function evalAdded(notes: readonly F1Note[], root: number, triad: Triad, v: D2Values, f1: F1Config): AddedEval {
  const adds = ADDS[v.range][triad];
  const ds = Object.keys(adds).map(Number);
  const rs = addedRatios(notes, root, TRIADS[triad], ds, v.thetaLow, f1);
  const rho: Record<number, number> = {};
  ds.forEach((d, i) => (rho[d] = rs[i]));
  // the stronger 7th only (a tie keeps the minor 7th); every triad has d = 10
  const sev = 11 in adds && rho[11] > rho[10] ? 11 : 10;
  const six = 9 in adds ? 9 : null;
  const r6 = six === null ? -Infinity : rho[six];
  // 7th >= θ, or the larger of the two below θ: the 7th (6 and 7 both added -> 7, plan §2.2); else the 6th
  const primary = rho[sev] >= v.theta || rho[sev] >= r6 ? sev : (six as number);
  const other = primary === sev ? six : sev;
  const max = Math.max(rho[sev], r6);
  const atLow = (d: number | null): d is number => d !== null && rho[d] >= v.thetaLow;
  return {
    rho,
    added: adds[primary],
    evidence: max - v.theta,
    strong: max >= v.thetaLow,
    candIfAdded: atLow(other) ? [adds[other]] : [],
    candIfPlain: [sev, six]
      .filter(atLow)
      .sort((a, b) => rho[b] - rho[a])
      .map((d) => adds[d]),
  };
}

/** Best 2-state path ("plain" = 0, "added" = 1) of per-column "added" scores `ev`, one penalty per switch. Ties: stay; at the end, "added". */
export function smooth(ev: readonly number[], penalty: number): Uint8Array {
  const n = ev.length;
  const path = new Uint8Array(n);
  if (n === 0) return path;
  const back = [new Uint8Array(n), new Uint8Array(n)];
  let d0 = 0;
  let d1 = ev[0];
  for (let t = 1; t < n; t++) {
    const stay0 = d0 >= d1 - penalty;
    const stay1 = d1 >= d0 - penalty;
    back[0][t] = stay0 ? 0 : 1;
    back[1][t] = stay1 ? 1 : 0;
    const n0 = stay0 ? d0 : d1 - penalty;
    const n1 = (stay1 ? d1 : d0 - penalty) + ev[t];
    d0 = n0;
    d1 = n1;
  }
  path[n - 1] = d1 >= d0 ? 1 : 0;
  for (let t = n - 1; t > 0; t--) path[t - 1] = back[path[t]][t];
  return path;
}

export interface D2Columns {
  /** the columns with D2's quality (root, confidence, posterior unchanged) */
  columns: ColumnChord[];
  /** candidate qualities per column (same root), strongest first */
  cands: string[][];
}

/**
 * Steps 1-5 over V0 columns. `f1` has one entry per beat (column t reads beat floor(t / perBeat)). The "added" score of
 * a column is (max ρ - θ) / perBeat, so the penalty is in beats whatever the column rate.
 */
export function applyD2(columns: readonly ColumnChord[], f1: readonly F1Beat[], perBeat: number, v: D2Values, f1cfg: F1Config): D2Columns {
  const n = columns.length;
  if (f1.length * perBeat !== n) throw new Error(`D2: ${f1.length} F1 beats for ${n} columns at perBeat ${perBeat}`);
  const out = columns.map((c) => ({ ...c }));
  const cands: string[][] = columns.map(() => []);
  const triads = columns.map((c) => (c.root === null ? null : triadOf(c.quality)));
  let a = 0;
  while (a < n) {
    const tri = triads[a];
    const root = columns[a].root;
    let b = a + 1;
    while (b < n && tri !== null && triads[b] === tri && columns[b].root === root) b++;
    if (tri === null || root === null) {
      a = b; // pass through
      continue;
    }
    const ev = Array.from({ length: b - a }, (_, i) => evalAdded(f1[Math.floor((a + i) / perBeat)].notes, root, tri, v, f1cfg));
    const path = smooth(
      ev.map((e) => e.evidence / perBeat),
      v.switchPenalty,
    );
    // a weak "added" column (max ρ < θ_low) names the added tone of the nearest strong column of its stretch (previous first)
    const named = ev.map((e) => (e.strong ? e.added : null));
    for (let i = 1; i < named.length; i++) if (named[i] === null && path[i] && path[i - 1]) named[i] = named[i - 1];
    for (let i = named.length - 2; i >= 0; i--) if (named[i] === null && path[i] && path[i + 1]) named[i] = named[i + 1];
    ev.forEach((e, i) => {
      out[a + i].quality = path[i] ? (named[i] ?? e.added) : tri;
      cands[a + i] = path[i] ? e.candIfAdded : e.candIfPlain;
    });
    a = b;
  }
  return { columns: out, cands };
}

/**
 * The always-shown readings of a segment [start, end) of D2 columns with root `root` and quality `quality`: the other
 * reading of an identical pair first, then the candidate qualities held by at least half of the segment's columns (most
 * columns first, then the first seen).
 */
export function d2Candidates(cands: readonly string[][], start: number, end: number, root: number, quality: string, range: AddedRange): Reading[] {
  const count = new Map<string, number>();
  for (let t = start; t < end; t++) for (const q of cands[t]) count.set(q, (count.get(q) ?? 0) + 1);
  const held = [...count.entries()]
    .filter(([q, c]) => c * 2 >= end - start && q !== quality)
    .sort((x, y) => y[1] - x[1])
    .map(([q]) => ({ root, quality: q }));
  const pair = otherReading({ root, quality }, PAIR_STAGE[range]);
  return pair ? [pair, ...held] : held;
}
