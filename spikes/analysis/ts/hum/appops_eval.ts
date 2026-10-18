/**
 * Spike 4 T15 (review S1): edit counts priced as the app can do them ("app-ops": split = 2, merge = 2) next to the
 * lower bound (split = merge = 1), for DEV recordings, aggregate only (mean over the dev recordings, no per-take line).
 * Held-out recordings are skipped by the same guard as the CLI. Synthetic numbers come from baseline.ts rows.
 *
 *   npx tsx ts/hum/appops_eval.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { analyzeHum } from './analyze';
import { firstNoteTickFromTruthInfo } from './cli';
import { humConfigHash, resolveHumConfig } from './config';
import { heldOutRefusal } from './heldout_guard';
import { recScore, type RecTruth } from './rec_score';

const SA = join(import.meta.dirname, '..', '..');
interface RecVariant { name: string; heldOut: boolean; truth: string; wav: string; bpm: number; ts: [number, number] }

const man = JSON.parse(readFileSync(join(SA, 'out', 'rec', 'manifest.hum.json'), 'utf8')) as { variants: RecVariant[] };
const ids = (JSON.parse(readFileSync(join(SA, 'recordings', 'hum-ids.local.json'), 'utf8')) as { recordings: Record<string, { heldOut?: boolean }> }).recordings;
const cfg = resolveHumConfig();
const rows: Record<string, number>[] = [];
for (const v of man.variants) {
  if (v.heldOut || heldOutRefusal(v.wav, { syn: [], rec: man.variants, ids })) continue; // dev recordings only
  const truth = JSON.parse(readFileSync(join(SA, v.truth), 'utf8')) as RecTruth;
  if (truth.heldOut) continue;
  const wav = decodeWav(new Uint8Array(readFileSync(join(SA, v.wav))));
  const res = analyzeHum(toMono(wav.channels), wav.sampleRate, { bpm: v.bpm, ts: v.ts, firstNoteSec: truth.info.firstNoteSec, firstNoteTick: firstNoteTickFromTruthInfo(truth.info) }, { config: cfg, sourceKind: 'recording' });
  rows.push(recScore(truth, res.melody.notes, res.melody.quantized, 'grid'));
}
const mean = (k: string) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(3);
const sum = (k: string) => rows.reduce((a, r) => a + r[k], 0);
process.stdout.write(
  `dev recordings n=${rows.length} config ${humConfigHash(cfg)}: edits/keyboard lower-bound ${mean('edit.ratioToKeyboard')}, app-ops ${mean('edit.appOps.ratioToKeyboard')}; pooled edits ${sum('edit.count')} -> ${sum('edit.appOps.count')} (keyboard steps ${sum('edit.keyboardSteps')})\n`,
);
