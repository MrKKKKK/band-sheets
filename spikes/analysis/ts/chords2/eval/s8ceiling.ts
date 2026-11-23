/**
 * Spike 8 G1 (docs/audio-spike8-g1.md §2): the CEILING of the candidates-only E1 on the decisive line, from the already
 * looked-at 's8-dev-1' BASE row (appBassConfig(), saved in out/chords2-s8dev1/look/files/). Post-look aggregation of a
 * fixed row with a tool in git: no new look, no beginLook, no log line, hold-out never listed. From spikes/analysis:
 *
 *   npx tsx ts/chords2/eval/s8ceiling.ts        counts per group (stdout, aggregates only)
 *
 * A truth run (editCounts' unit, vocabulary 全) is REACHABLE when the base row has a name edit there that its shown
 * candidates do not fix, the truth quality is an E1 quality (vocab.ts ADDS.E1: 7 / maj7 -> maj, min7 -> min,
 * m7b5 -> dim), and the run's dominant result piece has the truth root and exactly that triad (any /X). Only those runs
 * can turn "fixable" when an added-tone candidate is attached to the triad, so reachable / truth beats x 100 bounds how
 * far candidates-only can lower the hand edits per 100 beats (the right one of 7 / maj7 assumed, no push-out counted).
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '../../bass/evalCommon';
import { ADDS, type Triad } from '../vocab';
import { readRegistry, ROOT, synthSplit } from './guard';
import { devTakes } from './r2';
import { devSynItems, type FileRec } from './s8dev1';
import { editCounts, type EditRun, type EvalChord } from './score';
import { loadTruth, recItems, type Item } from './t8';

/** E1 quality -> its triad (from ADDS, not copied) */
const E1_TRIAD: ReadonlyMap<string, Triad> = new Map(Object.entries(ADDS.E1).flatMap(([tri, m]) => Object.values(m).map((q) => [q, tri as Triad] as const)));

export const reachable = (r: EditRun): boolean => r.nameEdit && !r.fixable && r.dom !== null && r.dom.root === r.truth.root && E1_TRIAD.has(r.truth.q) && r.dom.q === E1_TRIAD.get(r.truth.q);

export interface Ceiling {
  beats: number;
  runs: number;
  nameEdits: number;
  fixable: number;
  reachable: number;
}

export function ceilingOf(truth: readonly EvalChord[], result: readonly EvalChord[], beats: Parameters<typeof editCounts>[2]): Ceiling & { check: { name: number; fixable: number } } {
  const c: Ceiling = { beats: 0, runs: 0, nameEdits: 0, fixable: 0, reachable: 0 };
  const e = editCounts(truth, result, beats, 'full', {
    onRun: (r) => {
      c.runs++;
      if (r.nameEdit) c.nameEdits++;
      if (r.fixable) c.fixable++;
      if (reachable(r)) c.reachable++;
    },
  });
  c.beats = e.nBeats;
  return { ...c, check: { name: e.name, fixable: e.nameFixableByCandidate } };
}

function main(): void {
  const dir = join(ROOT, 'out', 'chords2-s8dev1', 'look', 'files');
  const items = new Map<string, Item>([...devSynItems(), ...recItems(devTakes(readRegistry()))].map((i) => [i.name, i]));
  const groups = ['REC', 'a-f', 'g-j', 'SYN', 'Lpool', 'LR'];
  const sum = new Map(groups.map((g) => [g, { beats: 0, runs: 0, nameEdits: 0, fixable: 0, reachable: 0 } as Ceiling]));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const rec = json<FileRec>(join(dir, f));
    const it = items.get(rec.name);
    if (!it) throw new Error(`${rec.name}: not a dev item`);
    if (it.kind === 'syn' && synthSplit(it.name) !== 'dev') throw new Error(`${it.name}: recipe split is not dev`);
    const t = loadTruth(it, 'dev');
    const c = ceilingOf(t.chords, rec.rows.base, t.beats);
    const saved = rec.scores.base.eFull;
    if (c.check.name !== saved.name || c.check.fixable !== saved.nameFixableByCandidate || c.beats !== saved.nBeats) throw new Error(`${rec.name}: recomputed base edit counts differ from the saved look`);
    for (const g of rec.groups) {
      const s = sum.get(g);
      if (!s) continue;
      for (const k of Object.keys(s) as (keyof Ceiling)[]) s[k] += c[k];
    }
  }
  console.log('| 区分 | 正解の拍 | 正解の続き | 名前の手直し | 候補で直せる（基準） | 足す音の候補で届く | 天井 / 100 拍 |\n|---|---:|---:|---:|---:|---:|---:|');
  for (const [g, s] of sum) console.log(`| ${g} | ${s.beats} | ${s.runs} | ${s.nameEdits} | ${s.fixable} | ${s.reachable} | ${s.beats ? ((s.reachable / s.beats) * 100).toFixed(2) : '-'} |`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
