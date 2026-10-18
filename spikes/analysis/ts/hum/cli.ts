/**
 * Spike 4 T7: Node CLI of the humming analyzer.
 *
 *   npx tsx ts/hum/cli.ts <wav> --bpm N [--ts 4/4] (--first-note S [--first-note-tick T] | --bar-start S) [-o out.json] [--commit SHA] [--config x.json] [--f0-track]
 *        --first-note S       approximate second of the first sung note (the .txt `開始:`); without --first-note-tick the
 *                             first note is assumed on a beat (tick 0) and the grid phase is searched
 *        --first-note-tick T  its bar position in ticks from bar 1 (whole = 64), when known
 *        --bar-start S        bar-1 head (old meaning of --start / `小節頭:`), may be negative; --start is an alias
 *        --truth-info T.json  recordings only: take --first-note-tick from the intake truth's `info` (startSec and
 *                             firstNoteSec; nothing else of the truth is read)
 *   npx tsx ts/hum/cli.ts <wav> --info <intake.txt> [...]      (bpm / 拍子 / 開始 / 小節頭 read from the intake .txt header)
 *   npx tsx ts/hum/cli.ts --all [--split tuning,dev] [--only NAME] [--commit SHA] [--config x.json] [--results DIR]
 *        [--start-mode bar|first-note|first-note-only] [--start-error-beats X]
 *        runs every manifest variant of out/hum (tuning + dev only; heldOut variants are skipped, asking for one is refused)
 *        and writes out/hum/results/<name>.json (or DIR). --start-mode bar (default) gives the exact bar-1 head; first-note
 *        gives the first truth note's SUNG onset + X beats as firstNoteSec with its tick (an approximate start like the
 *        user's 開始, for the phase-search evaluation); first-note-only leaves the tick out.
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
import { heldOutRefusal } from './heldout_guard';
import type { HumInput } from './types';

const OUT = join(import.meta.dirname, '..', '..', 'out', 'hum');

export interface CliArgs {
  input?: string;
  bpm?: number;
  ts?: [number, number];
  barStart?: number;
  firstNote?: number;
  firstNoteTick?: number;
  truthInfo?: string;
  info?: string;
  results?: string;
  startMode: 'bar' | 'first-note' | 'first-note-only';
  startErrorBeats: number;
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
  const a: CliArgs = { f0Track: false, all: false, splits: ['tuning', 'dev'], only: [], startMode: 'bar', startErrorBeats: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      return v;
    };
    if (k === '--bpm') a.bpm = Number(val());
    else if (k === '--ts') a.ts = parseTs(val());
    else if (k === '--start' || k === '--bar-start') a.barStart = Number(val());
    else if (k === '--first-note') a.firstNote = Number(val());
    else if (k === '--first-note-tick') a.firstNoteTick = Number(val());
    else if (k === '--truth-info') a.truthInfo = val();
    else if (k === '--results') a.results = val();
    else if (k === '--start-mode') {
      const m = val();
      if (m !== 'bar' && m !== 'first-note' && m !== 'first-note-only') throw new UsageError('--start-mode must be bar, first-note or first-note-only');
      a.startMode = m;
    } else if (k === '--start-error-beats') a.startErrorBeats = Number(val());
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

/**
 * Header keys of the intake .txt (py/hum_intake.py): bpm|テンポ, 拍子|time, 開始|start (approximate second of the first
 * sung note -> firstNoteSec), 小節頭|barStart (bar-1 head -> startSec, may be negative). Nothing after `メロディ:` is read.
 */
export function parseInfoTxt(text: string): Partial<Pick<HumInput, 'bpm' | 'ts' | 'startSec' | 'firstNoteSec'>> {
  const out: Partial<Pick<HumInput, 'bpm' | 'ts' | 'startSec' | 'firstNoteSec'>> = {};
  const lines = text.normalize('NFKC').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
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
    else if (key === '開始' || key === 'start') out.firstNoteSec = Number(v);
    else if (key === '小節頭' || key === 'barstart') out.startSec = Number(v);
  }
  return out;
}

/** --truth-info: the first note's bar position from an intake truth's `info` (startSec = 開始 - tick * secPerTick). */
export function firstNoteTickFromTruthInfo(info: { bpm: number; ts: [number, number]; startSec: number; firstNoteSec: number }): number {
  const tickSec = 60 / (info.bpm * (64 / info.ts[1]));
  return Math.round((info.firstNoteSec - info.startSec) / tickSec);
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

function runOne(wavPath: string, info: HumInput, a: CliArgs, commit: string | undefined, sourceKind: 'recording' | 'synthetic') {
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
  truth: string;
}

/** The start input of a synthetic variant for --start-mode (first-note modes read the first truth note's sung onset). */
export function variantStart(v: ManifestVariant, mode: CliArgs['startMode'], errBeats: number, truth?: { melody: { notes: { start: number; startTick: number }[] } }): HumInput {
  if (mode === 'bar') return { bpm: v.bpm, ts: v.ts, startSec: v.startSec };
  const first = [...truth!.melody.notes].sort((x, y) => x.startTick - y.startTick)[0];
  const beatSec = 60 / v.bpm;
  const firstNoteSec = Math.max(0, first.start + errBeats * beatSec);
  return mode === 'first-note' ? { bpm: v.bpm, ts: v.ts, firstNoteSec, firstNoteTick: first.startTick } : { bpm: v.bpm, ts: v.ts, firstNoteSec };
}

function runAll(a: CliArgs, commit: string | undefined): void {
  if (a.splits.includes('heldOut')) throw new UsageError('held-out variants are never analyzed here');
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: ManifestVariant[] };
  const outDir = a.results ? resolve(a.results) : join(OUT, 'results');
  mkdirSync(outDir, { recursive: true });
  const names = new Set(a.only);
  const asked = manifest.variants.filter((v) => names.has(v.name));
  if (asked.some((v) => v.heldOut || v.split === 'heldOut')) throw new UsageError('held-out variants are never analyzed here');
  let n = 0;
  let hash = '';
  for (const v of manifest.variants) {
    if (v.heldOut || v.split === 'heldOut' || !a.splits.includes(v.split)) continue;
    if (names.size && !names.has(v.name)) continue;
    const truth = a.startMode === 'bar' ? undefined : JSON.parse(readFileSync(join(OUT, v.truth), 'utf8'));
    const info = variantStart(v, a.startMode, a.startErrorBeats, truth);
    const r = runOne(join(OUT, v.wav), info, a, commit, 'synthetic');
    writeFileSync(join(outDir, `${v.name}.json`), JSON.stringify(r) + '\n', 'utf8');
    hash = r.hum.meta.configHash;
    n++;
    process.stderr.write(`${v.name}: ${r.melody.notes.length} notes, phase ${r.hum.meta.grid.phaseSteps} steps, ${(r.hum.meta.timings.totalMs / 1000).toFixed(2)} s\n`);
  }
  process.stderr.write(`done: ${n} variants (${a.splits.join(',')}, start ${a.startMode}${a.startMode === 'bar' ? '' : ` ${a.startErrorBeats} beats`}), config ${hash}, commit ${commit ?? '-'}, out ${outDir}\n`);
}

/** Refuses held-out synthetic variants and held-out recordings (single-file mode; same policy as --all). See heldout_guard.ts. */
function refuseHeldOut(input: string): void {
  const readJson = <T>(path: string, pick: (j: any) => T): T | null => {
    try {
      return pick(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  };
  const reason = heldOutRefusal(input, {
    syn: readJson(join(OUT, 'manifest.json'), (j) => j.variants),
    rec: readJson(join(OUT, '..', 'rec', 'manifest.hum.json'), (j) => j.variants),
    ids: readJson(join(OUT, '..', '..', 'recordings', 'hum-ids.local.json'), (j) => j.recordings),
  });
  if (reason) throw new UsageError(reason);
}

/** The HumInput of a single-file run: command line first, then the .txt; exactly one of the start forms. */
export function cliInfo(a: CliArgs, fromTxt: ReturnType<typeof parseInfoTxt>, firstNoteTick?: number): HumInput {
  const bpm = a.bpm ?? fromTxt.bpm ?? NaN;
  const ts = a.ts ?? fromTxt.ts ?? [4, 4];
  if (!Number.isFinite(bpm)) throw new UsageError('--bpm (or --info with bpm:) is needed');
  if (a.barStart !== undefined && a.firstNote !== undefined) throw new UsageError('give --first-note or --bar-start, not both');
  const cmdline = a.barStart !== undefined || a.firstNote !== undefined;
  const barStart = cmdline ? a.barStart : fromTxt.startSec;
  const firstNote = cmdline ? a.firstNote : fromTxt.firstNoteSec;
  if (barStart !== undefined && firstNote !== undefined) throw new UsageError('the .txt has both 開始: and 小節頭:');
  if (barStart !== undefined) {
    if (!Number.isFinite(barStart)) throw new UsageError('--bar-start must be a number');
    return { bpm, ts, startSec: barStart };
  }
  if (firstNote === undefined || !Number.isFinite(firstNote)) throw new UsageError('--first-note / --bar-start (or --info with 開始: / 小節頭:) is needed');
  return firstNoteTick !== undefined ? { bpm, ts, firstNoteSec: firstNote, firstNoteTick } : { bpm, ts, firstNoteSec: firstNote };
}

function main(argv: string[]): void {
  const a = parseArgs(argv);
  const commit = a.commit ?? gitCommit();
  if (a.all) return runAll(a, commit);
  if (!a.input) throw new UsageError('no input wav (or --all)');
  refuseHeldOut(a.input);
  if (a.truthInfo) refuseHeldOut(a.truthInfo);
  const fromTxt = a.info ? parseInfoTxt(readFileSync(a.info, 'utf8')) : {};
  let firstNoteTick = a.firstNoteTick;
  if (a.truthInfo) firstNoteTick ??= firstNoteTickFromTruthInfo((JSON.parse(readFileSync(a.truthInfo, 'utf8')) as { info: Parameters<typeof firstNoteTickFromTruthInfo>[0] }).info);
  const info = cliInfo(a, fromTxt, firstNoteTick);
  const r = runOne(a.input, info, a, commit, 'recording');
  const m = r.hum.meta;
  const st = Object.entries(m.timings.stagesMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ');
  process.stderr.write(`grid: ${m.grid.startMode}, phase ${m.grid.phaseSteps} steps (${m.grid.phaseOffsetSec.toFixed(3)} s), bias ${m.grid.onsetBiasSec.toFixed(3)} s\n`);
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
      process.stderr.write(`error: ${e.message}\nusage: npx tsx ts/hum/cli.ts <wav> --bpm N --ts 4/4 (--first-note S [--first-note-tick T] | --bar-start S) [-o out.json] [--commit SHA] [--info intake.txt] | --all\n`);
      process.exit(2);
    }
    if (e instanceof Error && /^(bpm|拍子|開始|小節頭)/.test(e.message)) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2));
