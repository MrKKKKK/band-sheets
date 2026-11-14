/** Spike 6 T3: TS side of py/tools/bass_mireval_check.py (steps in that file). Local files only. */
import { readFileSync, writeFileSync } from 'node:fs';
import { bassNoteScores, mapVocab, scoreBass, type ScoreBeat, type ScoreChord } from './score';
import type { ScoreNote } from '../hum/score';

interface Cases {
  qualities: string[];
  notes: { name: string; ref: ScoreNote[]; est: ScoreNote[] }[];
  charts: { name: string; beats: ScoreBeat[]; truth: ScoreChord[]; result: ScoreChord[] }[];
}
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: tsx ts/bass/score_check.ts <cases.json> <ts_results.json>');
  process.exit(2);
}
const cases = JSON.parse(readFileSync(inPath, 'utf8')) as Cases;
const out = {
  vocab: Object.fromEntries(cases.qualities.map((q) => [q, mapVocab(q)])),
  notes: Object.fromEntries(cases.notes.map((c) => [c.name, bassNoteScores(c.ref, c.est)])),
  charts: Object.fromEntries(
    cases.charts.map((c) => {
      const s = scoreBass(c.truth, c.result, c.beats);
      return [c.name, { truthSlash: s.slash.truthSlash, hit: s.slash.hit, slashRecall: s.slashRecall, nPoints: s.nPoints }];
    }),
  ),
};
writeFileSync(outPath, JSON.stringify(out));
console.log(`scored ${cases.qualities.length} qualities, ${cases.notes.length} note cases, ${cases.charts.length} chart cases`);
