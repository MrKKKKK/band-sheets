/**
 * Spike 4 T2: TS side of the mir_eval agreement check (py/tools/hum_mireval_check.py).
 *
 *   npx tsx ts/hum/score_check.ts <cases.json> <ts_results.json>
 *
 * cases.json is written by `hum_mireval_check.py gen`; this script scores every case with score.ts and writes the
 * numbers (note scores per variant, f0 scores) for `hum_mireval_check.py compare`. Reads and writes local files only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { f0Scores, noteScoreSet, type ScoreNote } from './score';

interface NoteCase {
  name: string;
  ref: ScoreNote[];
  est: ScoreNote[];
}
interface F0Case {
  name: string;
  refTime: number[];
  refHz: number[];
  estTime: number[];
  estHz: number[];
}
interface Cases {
  notes: NoteCase[];
  f0: F0Case[];
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: tsx ts/hum/score_check.ts <cases.json> <ts_results.json>');
  process.exit(2);
}
const cases = JSON.parse(readFileSync(inPath, 'utf8')) as Cases;
const result = {
  notes: Object.fromEntries(cases.notes.map((c) => [c.name, noteScoreSet(c.ref, c.est)])),
  f0: Object.fromEntries(cases.f0.map((c) => [c.name, f0Scores(c.refTime, c.refHz, c.estTime, c.estHz)])),
};
writeFileSync(outPath, JSON.stringify(result));
console.log(`scored ${cases.notes.length} note cases and ${cases.f0.length} f0 cases -> ${outPath}`);
