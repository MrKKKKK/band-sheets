/**
 * Spike 7 T17: the re-aggregation that was run after look dev-2 (T8) with an untracked tool (`out/chords2-t8/diag/m1rec.ts`,
 * created 17:39:22, after look-done 17:38:19). It only re-sums the name hits of the ALREADY COMPUTED dev-2 results
 * (`out/chords2-t8/look/*.json`, recordings only) with 5 decimals (docs/audio-spike7-t8.md: ".6266, line .6272"). No new
 * analysis, no tuning: not a second look. Kept in git so the numbers can be reproduced (plan §11).
 *
 *   npx tsx ts/chords2/eval/t8_m1rec.ts     (from spikes/analysis; needs out/chords2-t8/look and the dev recordings' truth)
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { json } from '../../bass/evalCommon';
import { scoreChords } from './score';

const dir = join(process.cwd(), 'out/chords2-t8/look');
const acc: Record<string, [number, number]> = {};
for (const f of readdirSync(dir)) {
  const c = json<any>(join(dir, f));
  if (c.kind !== 'rec') continue;
  const t = json<any>(join(process.cwd(), 'recordings', `${c.name}.truth.json`));
  for (const r of ['bassT8', 'M1', 'M2', 'M3']) {
    const s = scoreChords(t.chords, c.rows[r], t.beats, 'down').name.points;
    const a = (acc[r] ??= [0, 0]);
    a[0] += s.hit;
    a[1] += s.n;
  }
}
for (const [r, [h, n]] of Object.entries(acc)) console.log(r, h, n, (h / n).toFixed(5));
