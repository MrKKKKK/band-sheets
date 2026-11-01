/** Spike 5 T3: scores the cases of py/tools/drum_mireval_check.py with onsetScores() (see that file for the steps). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { onsetScores } from './score';

const [casesPath, outPath] = process.argv.slice(2);
const { tols, cases } = JSON.parse(readFileSync(casesPath, 'utf8')) as { tols: number[]; cases: { name: string; ref: number[]; est: number[] }[] };
const results = cases.map((c) => ({ name: c.name, scores: tols.map((tol) => { const r = onsetScores(c.ref, c.est, tol); return { precision: r.precision, recall: r.recall, f: r.f }; }) }));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ results }));
console.log(`scored ${results.length} cases`);
