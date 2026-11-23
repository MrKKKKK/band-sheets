/**
 * Spike 7 G1 (user, 2026-11-22; docs/audio-spike7-plan.md「G1 の決定」): the bookkeeping the gate tables need on top of
 * score.ts / baselineAgg.ts. Pure counting only (no tuning, no thresholds chosen from results):
 *  - seventhAsTriad: the recorded column "7th read as a triad" (`7→maj`, `m7→m`; root matched, full vocabulary);
 *  - newQualityOutput: points where the result says a new quality of the stage (the a-f false-output watch, <= 2 %);
 *  - fixedBroken: truth segments a candidate setting fixed / broke against a base on the same file (paired view);
 *  - handEdits / handEditsPer100: edits without the ones a candidate would fix (the main edit view);
 *  - choosePairRule: the G3 rule chosen before the look (difference < 5 conflict segments -> 'bassRoot').
 */
import { at } from '../../bass/evalCommon';
import { beatWindows, normalizeTruthSlash, type ScoreBeat } from '../../bass/score';
import { stageQualities, type Stage } from '../vocab';
import type { Summary } from './baselineAgg';
import { scoreChords, truthQuality, type EditCounts, type EvalChord, type Vocab } from './score';

const W = 0.5; // weight of one scored point (two per beat), as in score.ts

/** Points (weight 0.5) where the truth 7 / min7 was read as maj / min with the right root (full vocabulary; score.ts `added.asTriad`). */
export function seventhAsTriad(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[]): { d7AsMaj: number; m7AsMin: number } {
  const a = scoreChords(truth, result, beats, 'full').added.asTriad;
  return { d7AsMaj: a['7'], m7AsMin: a.min7 };
}

/** Qualities a stage adds to v1a's vocabulary (V1 .. stage). */
export const addedQualities = (stage: Stage): string[] => {
  const base = new Set(stageQualities('V0'));
  return stageQualities(stage).filter((q) => !base.has(q));
};

/**
 * Scored points (a truth chord present, quality scorable in the full vocabulary) where the result's quality is one the
 * stage added. On takes without new qualities (spike 6 a-f) every such point is a false output.
 */
export function newQualityOutput(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[], stage: Stage): { points: number; n: number } {
  const added = new Set(addedQualities(stage));
  const tt = normalizeTruthSlash(truth) as EvalChord[];
  let points = 0;
  let n = 0;
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const t = w[0] + f * (w[2] - w[0]);
      const tc = at(tt, t);
      if (!tc || truthQuality(tc, 'full') === null) continue;
      n += W;
      const rc = at(result, t);
      if (rc && added.has(rc.quality)) points += W;
    }
  return { points, n };
}

/**
 * Paired comparison on one file: truth segments whose name (score.ts unit rule: half of the segment's points) is
 * missed by `base` and hit by `cand` (fixed), and the reverse (broken). Segments are scored one at a time with
 * scoreChords, so the rule stays the one of score.ts.
 */
export function fixedBroken(truth: readonly EvalChord[], base: readonly EvalChord[], cand: readonly EvalChord[], beats: readonly ScoreBeat[], vocab: Vocab): { fixed: number; broken: number; units: number } {
  let fixed = 0;
  let broken = 0;
  let units = 0;
  for (const seg of truth) {
    const a = scoreChords([seg], base, beats, vocab).name.units;
    if (!a.n) continue; // not scored (no beat point / quality dropped)
    const b = scoreChords([seg], cand, beats, vocab).name.units;
    units++;
    if (!a.hit && b.hit) fixed++;
    if (a.hit && !b.hit) broken++;
  }
  return { fixed, broken, units };
}

/** Edits a user makes by hand: all edits minus those a shown candidate would fix. */
export const handEdits = (e: EditCounts): number => e.total - e.nameFixableByCandidate;
/** The same per 100 beats from an aggregate (null when there are no beats). */
export const handEditsPer100 = (s: Summary): number | null => (s.editsPer100 === null || s.editsFixablePer100 === null ? null : s.editsPer100 - s.editsFixablePer100);

/** G1: the G3 pair rule. Conflict-example segments hit by each rule; a difference under `margin` keeps the simple rule. */
export function choosePairRule(contextHits: number, bassRootHits: number, margin = 5): 'context' | 'bassRoot' {
  return contextHits - bassRootHits >= margin ? 'context' : 'bassRoot';
}
