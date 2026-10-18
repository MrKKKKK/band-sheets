/**
 * Synthetic take scoring of the held-out driver (moved out of heldout_eval.ts in T15 so it can be exercised on dev
 * variants without running the driver). Each take is analyzed twice (bar-head start, first note -0.7 beat with tick) and
 * the two score rows are averaged. Numbers only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { resolveStart } from './analyze';
import { scoreTake as scoreSynTake } from './baseline';
import { variantStart } from './cli';
import type { HumConfig } from './config';
import { estimateF0 } from './f0';
import { extractNotes, frameLevelDb } from './notes';
import { quantize } from './quantize';
import type { Scores } from './report';

const HUM = join(import.meta.dirname, '..', '..', 'out', 'hum');
const SR = 22050;
const mean = (rows: Scores[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;

export interface SynVariant { name: string; level: string; split: string; heldOut: boolean; wav: string; truth: string; bpm: number; ts: [number, number]; startSec: number }

export function synScore(v: SynVariant, cfg: HumConfig): { both: Scores; bar: Scores; first: Scores } {
  const truth = JSON.parse(readFileSync(join(HUM, v.truth), 'utf8'));
  const wav = decodeWav(new Uint8Array(readFileSync(join(HUM, v.wav))));
  const x = resampleSinc(toMono(wav.channels), wav.sampleRate, SR);
  const f = estimateF0(x, SR, cfg);
  const level = frameLevelDb(x, SR, f.track);
  const infos = [variantStart(v, 'bar', 0), variantStart(v, 'first-note', -0.7, truth)];
  const rows = infos.map((info) => {
    const nr = extractNotes(f.track, level, info, cfg);
    const st = resolveStart(info);
    const q = quantize(nr.notes, { bpm: info.bpm, ts: info.ts, startSec: st.startSec, firstNoteSec: st.firstNoteSec, firstNoteTick: st.firstNoteTick }, cfg.grid);
    return scoreSynTake(truth as never, nr.notes, q);
  });
  const both: Scores = {};
  for (const k of new Set(rows.flatMap((r) => Object.keys(r)))) both[k] = mean(rows, k);
  return { both, bar: rows[0], first: rows[1] };
}


/** Per level: n and the mean of `keys` over the takes (3 decimals). */
export function aggregateByLevel(sel: SynVariant[], cfg: HumConfig, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const L of [...new Set(sel.map((v) => v.level))].sort()) {
    const vs = sel.filter((v) => v.level === L);
    const rows = vs.map((v) => synScore(v, cfg).both);
    out[L] = { n: vs.length, ...Object.fromEntries(keys.map((k) => [k, +mean(rows, k).toFixed(3)])) };
  }
  return out;
}
