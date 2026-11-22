/**
 * Spike 7 T10: the candidates shown with a chord (user decision 2026-11-22, fixed before the V1 tuning): at most
 * CANDIDATE_CAP readings besides the answer. The other reading of an identical pair (plan §2.3, `chordCandidates`) is
 * always among them and comes first; the rest are the top-k posterior candidates in their order. The answer itself and
 * repeats are skipped (a repeat or the answer cannot fix a name edit). The scorer (eval/score.ts editCounts, "選べば直せる")
 * reads only these, so every row (v1a, v1a + bass, chords2) is scored with the same cap.
 */

export interface CandidateName {
  root: string;
  quality: string;
}

/** Readings shown besides the answer (plan §5 "候補の数は T10 の前に固定"). */
export const CANDIDATE_CAP = 2;

const key = (c: CandidateName): string => `${c.root}|${c.quality}`;

/** The shown candidates of a chord whose answer is `answer`: `list` (pair reading first) without the answer and repeats, capped. */
export function shownCandidates(answer: CandidateName, list: readonly CandidateName[], cap = CANDIDATE_CAP): CandidateName[] {
  const seen = new Set([key(answer)]);
  const out: CandidateName[] = [];
  for (const c of list) {
    if (out.length >= cap) break;
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    out.push({ root: c.root, quality: c.quality });
  }
  return out;
}
