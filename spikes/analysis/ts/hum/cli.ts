/**
 * Spike 4 T7: Node CLI of the humming analyzer.
 *
 *   npx tsx ts/hum/cli.ts <wav> --bpm N [--ts 4/4] --start S [-o out.json] [--commit SHA] [--config x.json] [--f0-track]
 *   npx tsx ts/hum/cli.ts <wav> --info <intake.txt> [...]      (bpm / 拍子 / 開始 read from the intake .txt header)
 *   npx tsx ts/hum/cli.ts --all [--split tuning,dev] [--commit SHA] [--config x.json]
 *        runs every manifest variant of out/hum (tuning + dev only; heldOut variants are skipped, asking for one is refused)
 *        and writes out/hum/results/<name>.json.
 *
 * Privacy: stdout/stderr only get counts, timings and the config hash, never notes or melody text. The result JSON
 * (it holds the notes) is only written to -o; without -o nothing but the summary is printed.
 * Reads local files only; no network. `--commit` defaults to `git rev-parse HEAD` of the repo when it works.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { AnalysisInputError, analyzeHum } from './analyze';
import type { HumInfo } from './types';

const OUT = join(import.meta.dirname, '..', '..', 'out', 'hum');

export interface CliArgs {
  input?: string;
  bpm?: number;
  ts?: [number, number];
  start?: number;
  info?: string;
  out?: string;
  commit?: string;
  config?: string;
  f0Track: boolean;
  all: boolean;
  splits: string[];
  only: string[];
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { f0Track: false, all: false, splits: ['tuning', 'dev'], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      return v;
    };
    if (k === '--bpm') a.bpm = Number(val());
    else if (k === '--ts') a.ts = parseTs(val());
    else if (k === '--start') a.start = Number(val());
    else if (k === '--info') a.info = val();
    else if (k === '-o' || k === '--out') a.out = val();
    else if (k === '--commit') a.commit = val();
    else if (k === '--config') a.config = val();
    else if (k === '--f0-track') a.f0Track = true;
    else if (k === '--all') a.all = true;
    else if (k === '--split') a.splits = val().split(',');
    else if (k === '--only') a.only.push(val());
    else if (k.startsWith('-')) throw new UsageError(`unknown option ${k}`);
    else if (a.input === undefined) a.input = k;
    else throw new UsageError(`unexpected argument ${k}`);
  }
  return a;
}

function parseTs(s: string): [number, number] {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (!m) throw new UsageError('--ts must look like 4/4');
  return [Number(m[1]), Number(m[2])];
}

/** Header keys of the intake .txt (py/hum_intake.py): bpm|テンポ, 拍子|time, 開始|start. Nothing after `メロディ:` is read. */
export function parseInfoTxt(text: string): Partial<Pick<HumInfo, 'bpm' | 'ts' | 'startSec'>> {
  const out: Partial<Pick<HumInfo, 'bpm' | 'ts' | 'startSec'>> = {};
  const lines = text.normalize('NFKC').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([^:：\s]+)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'メロディ' || key === 'melody') break; // the melody text is private and not needed
    const v = m[2].trim();
    if (key === 'bpm' || key === 'テンポ') out.bpm = Number(v);
    else if (key === '拍子' || key === 'time') out.ts = parseTs(v);
    else if (key === '開始' || key === 'start') out.startSec = Number(v);
  }
  return out;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function loadConfig(path?: string): unknown {
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : {};
}

function runOne(wavPath: string, info: HumInfo, a: CliArgs, commit: string | undefined, sourceKind: 'recording' | 'synthetic') {
  const wav = decodeWav(new Uint8Array(readFileSync(wavPath)));
  const y = toMono(wav.channels);
  return analyzeHum(y, wav.sampleRate, info, { config: loadConfig(a.config), commit, f0Track: a.f0Track, sourceKind });
}

interface ManifestVariant {
  name: string;
  split: string;
  heldOut: boolean;
  wav: string;
  bpm: number;
  ts: [number, number];
  startSec: number;
}

function runAll(a: CliArgs, commit: string | undefined): void {
  if (a.splits.includes('heldOut')) throw new UsageError('held-out variants are never analyzed here');
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
  const outDir = join(OUT, 'results');
  mkdirSync(outDir, { recursive: true });
  const names = new Set(a.only);
  const asked = manifest.variants.filter((v) => names.has(v.name));
  if (asked.some((v) => v.heldOut || v.split === 'heldOut')) throw new UsageError('held-out variants are never analyzed here');
  let n = 0;
  let hash = '';
  for (const v of manifest.variants) {
    if (v.heldOut || v.split === 'heldOut' || !a.splits.includes(v.split)) continue;
    if (names.size && !names.has(v.name)) continue;
    const info: HumInfo = { bpm: v.bpm, ts: v.ts, startSec: v.startSec };
    const r = runOne(join(OUT, v.wav), info, a, commit, 'synthetic');
    writeFileSync(join(outDir, `${v.name}.json`), JSON.stringify(r) + '\n', 'utf8');
    hash = r.hum.meta.configHash;
    n++;
    process.stderr.write(`${v.name}: ${r.melody.notes.length} notes, ${(r.hum.meta.timings.totalMs / 1000).toFixed(2)} s\n`);
  }
  process.stderr.write(`done: ${n} variants (${a.splits.join(',')}), config ${hash}, commit ${commit ?? '-'}, out ${outDir}\n`);
}

/** Refuses a manifest held-out wav (or its truth) and anything under a recordings/ directory without being asked for it by --all. */
function refuseHeldOut(input: string): void {
  try {
    const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
    const b = basename(input);
    if (manifest.variants.some((v) => (v.heldOut || v.split === 'heldOut') && v.wav === b)) throw new UsageError('held-out variants are never analyzed here');
  } catch (e) {
    if (e instanceof UsageError) throw e;
  }
}

function main(argv: string[]): void {
  const a = parseArgs(argv);
  const commit = a.commit ?? gitCommit();
  if (a.all) return runAll(a, commit);
  if (!a.input) throw new UsageError('no input wav (or --all)');
  refuseHeldOut(a.input);
  const fromTxt = a.info ? parseInfoTxt(readFileSync(a.info, 'utf8')) : {};
  const info: HumInfo = {
    bpm: a.bpm ?? fromTxt.bpm ?? NaN,
    ts: a.ts ?? fromTxt.ts ?? [4, 4],
    startSec: a.start ?? fromTxt.startSec ?? NaN,
  };
  if (!Number.isFinite(info.bpm)) throw new UsageError('--bpm (or --info with bpm:) is needed');
  if (!Number.isFinite(info.startSec)) throw new UsageError('--start (or --info with 開始:) is needed');
  const r = runOne(a.input, info, a, commit, 'recording');
  const m = r.hum.meta;
  const st = Object.entries(m.timings.stagesMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ');
  process.stderr.write(`${basename(a.input)}: ${r.melody.notes.length} notes, config ${m.configHash}, ${(m.timings.audioSec).toFixed(1)} s audio, total ${(m.timings.totalMs / 1000).toFixed(2)} s (${st})\n`);
  if (m.warnings.length) process.stderr.write(`warnings: ${m.warnings.length}\n`);
  if (a.out) writeFileSync(a.out, JSON.stringify(r, null, 1) + '\n', 'utf8');
  else process.stderr.write('no -o: result not written (the JSON holds the notes; stdout never gets them)\n');
}

export function run(argv: string[]): void {
  try {
    main(argv);
  } catch (e) {
    if (e instanceof AnalysisInputError) {
      process.stderr.write(`error [${e.code}]: ${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\nusage: npx tsx ts/hum/cli.ts <wav> --bpm N --ts 4/4 --start S [-o out.json] [--commit SHA] [--info intake.txt] | --all\n`);
      process.exit(2);
    }
    if (e instanceof Error && /^(bpm|拍子|開始)/.test(e.message)) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2));
