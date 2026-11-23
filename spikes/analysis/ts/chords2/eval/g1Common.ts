/**
 * Spike 7 / 8: the parts of the G1 gate lines (plan「G1 の決定」) that t8.ts (`g1Lines`) and t10.ts (`g1LinesV1`) share:
 * the line record, the per-group summary lookup, the "≤ max" line, and the two line families whose wording and
 * thresholds are the same in both (3 誤った /X, 5 手で直す数). The lines that differ per stage stay in their own file.
 */
import { newAgg, summarize, type Agg, type Summary } from './baselineAgg';
import { f1, f3 } from './baseline';
import { handEditsPer100 } from './gate';
import type { Vocab } from './score';

export interface Line {
  line: string;
  value: string;
  target: string;
  pass: boolean | null;
  /** between the target and the stop line (−.01 .. −.02): the user decides (G1) */
  user?: boolean;
}

/** Anything with the aggregates keyed `${vocab}|${row}|${group}` (both stages' Tally). */
export interface AggTally {
  agg: Record<string, Agg>;
}

export const summaryOf = (T: AggTally, v: Vocab, row: string, g: string): Summary => summarize(T.agg[`${v}|${row}|${g}`] ?? newAgg());
/** The row has at least one file in the group (落 vocabulary, as the lines are only listed when the group exists). */
export const hasGroup = (T: AggTally, row: string, g: string): boolean => (T.agg[`down|${row}|${g}`]?.files ?? 0) > 0;

export const leLine = (line: string, x: number | null, max: number): Line => ({ line, value: f3(x), target: `≤ ${f3(max)}`, pass: x === null ? null : x <= max + 1e-9 });

/** Line 3: wrong /X on the recordings (≤ .02) and on the synthetic LR set (≤ .05). */
export function wrongSlashLines(T: AggTally, row: string): Line[] {
  const out: Line[] = [];
  if (hasGroup(T, row, 'REC')) out.push(leLine('3 誤った /X 録音 ALL', summaryOf(T, 'down', row, 'REC').wrongSlash, 0.02));
  if (hasGroup(T, row, 'LR')) out.push(leLine('3 誤った /X 合成 LR', summaryOf(T, 'down', row, 'LR').wrongSlash, 0.05));
  return out;
}

/**
 * Line 5: hand edits per 100 beats must be 1.5 below the base row (REC and SYN groups).
 * `vocab`: which vocabulary's numbers; `base`: the base row; `synLabel` / `baseLabel`: the wording of the line.
 */
export function handEditsLines(T: AggTally, row: string, o: { vocab: Vocab; base: string; vocabLabel: string; synLabel: string; baseLabel: string }): Line[] {
  const out: Line[] = [];
  for (const g of ['REC', 'SYN'])
    if (hasGroup(T, row, g)) {
      const x = handEditsPer100(summaryOf(T, o.vocab, row, g));
      const b = handEditsPer100(summaryOf(T, o.vocab, o.base, g));
      out.push({ line: `5 手で直す数 / 100 拍 ${o.vocabLabel} ${g === 'REC' ? '録音 ALL' : o.synLabel}（${o.baseLabel} −1.5）`, value: f1(x), target: `≤ ${f1(b === null ? null : b - 1.5)}`, pass: x === null || b === null ? null : x <= b - 1.5 + 1e-9 });
    }
  return out;
}
