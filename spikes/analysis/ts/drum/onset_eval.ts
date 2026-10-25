/**
 * Spike 5 T5: instrument-agnostic onset evaluation on the synthetic tuning + dev splits (docs/audio-spike5-plan.md T5).
 *
 * Run from spikes/analysis (devcontainer):
 *   npx tsx ts/drum/onset_eval.ts [--split tuning,dev] [--only GLOB] [--config '<json overrides>']
 *                                 [--dump out/drum-results/onset/ts.json] [--json out/drum-results/onset/summary-ts.json]
 *   npx tsx ts/drum/onset_eval.ts --est-json out/drum-results/onset/librosa.json --est-key default|backtrack
 *     scores onsets computed elsewhere (py/tools/drum_librosa_onsets.py) with the same scorer instead of detecting.
 *
 * Reference = all truth hits of the variant (every instrument, incl. the S-拡張 names), merged into one onset when
 * within TRUTH_MERGE_SEC of the first hit of a group (simultaneous hits = one onset; the group's time = its first hit).
 * Scores: ts/drum/score.ts onsetScores (mir_eval.onset.f_measure) at 50 and 25 ms, micro-summed per group; timing
 * error = est - ref of the 50 ms matching pairs (median of |err|, 95th percentile of |err|, median signed).
 * HELD-OUT: only tuning / dev variants are ever read; a selected held-out variant (heldOut or split 'heldOut') throws
 * before any file is opened (T8 builds the real guard). Output: aggregates only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudioFile, toMono } from '../../render/drum/audioFile';
import { drumConfigHash, resolveDrumConfig, type DrumConfig } from './config';
import { detectOnsets } from './onset';
import { matchOnsets, onsetScores } from './score';

export const TRUTH_MERGE_SEC = 0.03;
const TOLS = [0.05, 0.025] as const;

export interface EvalVariant {
  name: string;
  level: string;
  kit: string;
  split: string;
  heldOut: boolean;
  ext: boolean;
  wav: string;
  truth: string;
  audioSec: number;
}

/** Throws when any variant is held-out; also refuses a held-out split request. */
export function assertNoHeldOut(vs: readonly Pick<EvalVariant, 'name' | 'heldOut' | 'split'>[], splits: readonly string[] = []): void {
  if (splits.some((s) => s.toLowerCase().startsWith('held'))) throw new Error('held-out split is never evaluated here');
  const bad = vs.filter((v) => v.heldOut === true || v.split === 'heldOut');
  if (bad.length) throw new Error(`refusing ${bad.length} held-out variant(s)`);
}

/** Select tuning/dev variants by split and name glob; held-out entries are dropped BEFORE matching, then re-checked. */
export function selectVariants(all: EvalVariant[], splits: string[], only?: string): EvalVariant[] {
  assertNoHeldOut([], splits);
  const re = only ? new RegExp(`^${only.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) : null;
  const sel = all.filter((v) => !v.heldOut && v.split !== 'heldOut' && splits.includes(v.split) && (!re || re.test(v.name)));
  assertNoHeldOut(sel);
  return sel;
}

/** Sorted times merged into groups (a time joins when within gap of the group's FIRST time); returns the first times. */
export function mergeTimes(times: readonly number[], gap: number): number[] {
  const s = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of s) if (!out.length || t - out[out.length - 1] > gap) out.push(t);
  return out;
}

export interface FileResult {
  name: string;
  level: string;
  kit: string;
  split: string;
  audioSec: number;
  ms: number;
  nRef: number;
  nEst: number;
  matched50: number;
  matched25: number;
  errs: number[];
}

export function scoreFile(v: EvalVariant, ref: number[], est: number[], ms: number): FileResult {
  const s50 = onsetScores(ref, est, TOLS[0]);
  const s25 = onsetScores(ref, est, TOLS[1]);
  const errs = matchOnsets(ref, est, TOLS[0]).map(([i, j]) => est[j] - ref[i]);
  return { name: v.name, level: v.level, kit: v.kit, split: v.split, audioSec: v.audioSec, ms, nRef: ref.length, nEst: est.length, matched50: s50.matched, matched25: s25.matched, errs };
}

const quant = (a: number[], q: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const p = q * (s.length - 1);
  const lo = Math.floor(p);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
};
const f1 = (m: number, r: number, e: number) => (r && e ? (2 * m) / (r + e) : 0);

export interface GroupRow {
  group: string;
  files: number;
  nRef: number;
  P50: number;
  R50: number;
  F50: number;
  F25: number;
  minF50: number;
  medAbsMs: number;
  p95AbsMs: number;
  medSignedMs: number;
}

export function aggregate(group: string, rs: FileResult[]): GroupRow {
  const nRef = rs.reduce((a, r) => a + r.nRef, 0);
  const nEst = rs.reduce((a, r) => a + r.nEst, 0);
  const m50 = rs.reduce((a, r) => a + r.matched50, 0);
  const m25 = rs.reduce((a, r) => a + r.matched25, 0);
  const errs = rs.flatMap((r) => r.errs);
  const abs = errs.map(Math.abs);
  return {
    group,
    files: rs.length,
    nRef,
    P50: nEst ? m50 / nEst : 0,
    R50: nRef ? m50 / nRef : 0,
    F50: f1(m50, nRef, nEst),
    F25: f1(m25, nRef, nEst),
    minF50: Math.min(...rs.map((r) => f1(r.matched50, r.nRef, r.nEst))),
    medAbsMs: quant(abs, 0.5) * 1000,
    p95AbsMs: quant(abs, 0.95) * 1000,
    medSignedMs: quant(errs, 0.5) * 1000,
  };
}

export function groupRows(rs: FileResult[]): GroupRow[] {
  const keys = new Map<string, FileResult[]>();
  const add = (k: string, r: FileResult) => keys.set(k, [...(keys.get(k) ?? []), r]);
  for (const r of rs) {
    add(`${r.level} k${r.kit}`, r);
    add(`${r.level} all`, r);
    add(`split ${r.split}`, r);
    add('ALL', r);
  }
  const order = (k: string) => (k === 'ALL' ? 'z' : k.startsWith('split') ? 'y' + k : k);
  return [...keys.keys()].sort((a, b) => order(a).localeCompare(order(b))).map((k) => aggregate(k, keys.get(k)!));
}

export function renderTable(rows: GroupRow[]): string {
  const f = (x: number) => x.toFixed(3);
  const m = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
  const lines = ['| group | files | ref onsets | P50 | R50 | F50 | F25 | min file F50 | med abs err ms | p95 abs err ms | med signed ms |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.group} | ${r.files} | ${r.nRef} | ${f(r.P50)} | ${f(r.R50)} | ${f(r.F50)} | ${f(r.F25)} | ${f(r.minF50)} | ${m(r.medAbsMs)} | ${m(r.p95AbsMs)} | ${m(r.medSignedMs)} |`);
  return lines.join('\n');
}

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function run(argv: string[]): void {
  const root = resolve(fileURLToPath(new URL('../../out/drum/', import.meta.url)));
  const splits = (argOf(argv, '--split') ?? 'tuning,dev').split(',');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { variants: EvalVariant[] };
  const vs = selectVariants(manifest.variants, splits, argOf(argv, '--only'));
  const estJson = argOf(argv, '--est-json');
  const estKey = argOf(argv, '--est-key') ?? 'default';
  const ext = estJson ? (JSON.parse(readFileSync(estJson, 'utf8')) as Record<string, Record<string, number[]>>)[estKey] : undefined;
  if (estJson && !ext) throw new Error(`--est-key ${estKey} not in ${estJson}`);
  const cfg: DrumConfig = resolveDrumConfig(JSON.parse(argOf(argv, '--config') ?? '{}'));
  const dump: Record<string, number[]> = {};
  const results: FileResult[] = [];
  for (const v of vs) {
    const truth = JSON.parse(readFileSync(join(root, v.truth), 'utf8')) as { drums: { t: number }[]; drum: { variant: { heldOut: boolean; split: string } } };
    assertNoHeldOut([{ name: v.name, ...truth.drum.variant }]);
    const ref = mergeTimes(
      truth.drums.map((h) => h.t),
      TRUTH_MERGE_SEC,
    );
    let est: number[];
    let ms = 0;
    if (ext) {
      if (!ext[v.name]) throw new Error(`no estimate for ${v.name}`);
      est = ext[v.name];
    } else {
      const a = readAudioFile(join(root, v.wav));
      const y = toMono(a);
      const t = performance.now();
      const d = detectOnsets(y, a.sampleRate, cfg);
      ms = performance.now() - t;
      est = d.onsets.map((o) => o.t);
      dump[v.name] = est.map((x) => Math.round(x * 1e6) / 1e6);
    }
    results.push(scoreFile(v, ref, est, ms));
  }
  const rows = groupRows(results);
  const audioMin = results.reduce((a, r) => a + r.audioSec, 0) / 60;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log(`${estJson ? `external ${estKey}` : `ts config ${drumConfigHash(cfg)} sr ${cfg.audio.sr}`}; ${results.length} files, ${audioMin.toFixed(1)} audio min`);
  if (!estJson) console.log(`speed: ${(totalMs / audioMin).toFixed(0)} ms per audio minute (Node, single thread, incl. resample)`);
  console.log(renderTable(rows));
  const write = (p: string | undefined, data: unknown) => {
    if (!p) return;
    mkdirSync(dirname(resolve(p)), { recursive: true });
    writeFileSync(p, JSON.stringify(data));
  };
  if (!estJson) write(argOf(argv, '--dump'), dump);
  write(argOf(argv, '--json'), { config: estJson ? null : drumConfigHash(cfg), est: estJson ? estKey : 'ts', msPerAudioMin: estJson ? null : totalMs / audioMin, rows });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && existsSync(resolve(fileURLToPath(new URL('../../out/drum/', import.meta.url))))) {
  run(process.argv.slice(2));
}
