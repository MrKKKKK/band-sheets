/**
 * Spike 5 T8: Node CLI of the drum analyzer (run from spikes/analysis, devcontainer).
 *
 *   npx tsx ts/drum/cli.ts --all [--split tuning,dev] [--only GLOB] [--results DIR] [--commit SHA] [--config x.json] [--level S-9]
 *        runs every manifest variant of out/drum in the splits (tuning + dev only), checks that each DrumEvent[] writes and
 *        reads back through the app's serializeDrums / parseDrums unchanged, scores it with score.ts (T3) and writes
 *        <name>.json (result), <name>.tex (alphaTex section), <name>.score.json, summary.md, run.json into
 *        out/drum-results/analyze (or DIR). Exit code 1 when a file fails to analyze or does not round-trip.
 *        Held-out variants are skipped; asking for one (--only, --split heldOut) is refused.
 *   npx tsx ts/drum/cli.ts <wav> --bpm N [--ts 4/4] --start S [-o out.json] [--commit SHA] [--config x.json]
 *        one file; --start is the second of bar 1 beat 1 (may be negative). Refuses held-out files (heldout_guard.ts).
 *   npx tsx ts/drum/cli.ts --take drm-NN-x [--take ...] [--look-point N] [--commit SHA] [--config x.json]
 *        recordings by take id (out/rec/manifest.drum.json, recordings/): result and score go to recordings/drum-results
 *        (git-ignored), stdout gets counts, timings and aggregate tables only. Held-out takes are refused unless
 *        --look-point 3 (clean tree, once); every look-point run is logged to out/results/heldout-log.jsonl BEFORE the analysis.
 *
 * --level S-3 (default) | S-9 (T11) picks the analysis level and the scored instruments, in every mode.
 *
 * Privacy: stdout/stderr never get hits or a score text of a recording. Reads local files only; no network.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAudioFile, toMono } from '../../render/drum/audioFile';
import { DrumInputError, analyzeDrums, drumScore, type DrumScoreText } from './analyze';
import { drumConfigHash, resolveDrumConfig, type DrumConfig } from './config';
import { heldOutRefusal, lookLogLine, lookPointBlock, type GuardVariant } from './heldout_guard';
import { assertNoHeldOut, selectVariants, type EvalVariant } from './onset_eval';
import { renderDrumReport, type DrumReportRow } from './report';
import { scoreTake, type DrumTruth, type TakeScore } from './score';
import type { DrumAnalysisResult, DrumInfo, DrumLevel } from './types';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'out', 'drum');
const REC_MANIFEST = join(ROOT, 'out', 'rec', 'manifest.drum.json');
const IDS = join(ROOT, 'recordings', 'drm-ids.local.json');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');

export class UsageError extends Error {}

export interface CliArgs {
  input?: string;
  bpm?: number;
  ts?: [number, number];
  start?: number;
  out?: string;
  commit?: string;
  config?: string;
  results?: string;
  all: boolean;
  splits: string[];
  only?: string;
  takes: string[];
  lookPoint?: number;
  /** Analysis and scoring level (T11): S-3 (default) or S-9. */
  level: DrumLevel;
}

function parseTs(s: string): [number, number] {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (!m) throw new UsageError('--ts must look like 4/4');
  return [Number(m[1]), Number(m[2])];
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { all: false, splits: ['tuning', 'dev'], takes: [], level: 'S-3' };
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
    else if (k === '-o' || k === '--out') a.out = val();
    else if (k === '--commit') a.commit = val();
    else if (k === '--config') a.config = val();
    else if (k === '--results') a.results = val();
    else if (k === '--all') a.all = true;
    else if (k === '--split') a.splits = val().split(',');
    else if (k === '--only') a.only = val();
    else if (k === '--take') a.takes.push(val());
    else if (k === '--level') {
      const l = val();
      if (l !== 'S-3' && l !== 'S-9') throw new UsageError('--level must be S-3 or S-9');
      a.level = l;
    }
    else if (k === '--look-point') {
      a.lookPoint = Number(val());
      if (![1, 2, 3].includes(a.lookPoint)) throw new UsageError('--look-point must be 1, 2 or 3');
    } else if (k.startsWith('-')) throw new UsageError(`unknown option ${k}`);
    else if (a.input === undefined) a.input = k;
    else throw new UsageError(`unexpected argument ${k}`);
  }
  return a;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}
function gitPorcelain(): string | null {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function loadConfig(path?: string): DrumConfig {
  return resolveDrumConfig(path ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : {});
}

const readJson = <T>(path: string, pick: (j: any) => T): T | null => {
  try {
    return pick(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
};

interface RecVariant extends GuardVariant {
  bpm: number;
  ts: [number, number];
  startSec: number;
  truth: string;
  excludedBars?: number[];
}

export function guardSources() {
  return {
    syn: readJson(join(OUT, 'manifest.json'), (j) => j.variants as GuardVariant[]),
    rec: readJson(REC_MANIFEST, (j) => j.variants as GuardVariant[]),
    ids: readJson(IDS, (j) => j.recordings as Record<string, { heldOut?: boolean }>),
  };
}

/** Throws UsageError when `input` (path or take id) may not be analyzed; returns true when it is held-out and the look point lifted that. */
export function gate(input: string, a: Pick<CliArgs, 'lookPoint'>, cfgHash: string, commit: string | undefined): boolean {
  const refusal = heldOutRefusal(input, guardSources());
  if (!refusal) return false;
  if (!refusal.heldOut) throw new UsageError(refusal.reason);
  const block = lookPointBlock({ lookPoint: a.lookPoint, logText: existsSync(LOG) ? readFileSync(LOG, 'utf8') : null, porcelain: gitPorcelain() });
  if (block) throw new UsageError(`${refusal.reason}: ${block}`);
  logLook(a.lookPoint!, basename(input).replace(/\.(wav|json)$/i, ''), true, cfgHash, commit);
  return true;
}

function logLook(lookPoint: number, take: string, heldOut: boolean, configHash: string, commit?: string): void {
  mkdirSync(join(ROOT, 'out', 'results'), { recursive: true });
  appendFileSync(LOG, lookLogLine({ time: new Date().toISOString(), lookPoint, take, heldOut, configHash, commit }) + '\n', 'utf8');
}

export interface FileRun {
  result: DrumAnalysisResult;
  text: DrumScoreText | { error: string };
  readMs: number;
}

/** Analyze one decoded file and convert it; a conversion failure is reported, not thrown. */
export function runFile(wavPath: string, info: DrumInfo, cfg: DrumConfig, commit: string | undefined, sourceKind: 'recording' | 'synthetic', level: DrumLevel = 'S-3'): FileRun {
  const t0 = performance.now();
  const audio = readAudioFile(wavPath);
  const y = toMono(audio);
  const readMs = performance.now() - t0;
  const result = analyzeDrums({ ...info, samples: y, sampleRate: audio.sampleRate, level }, cfg, { commit, sourceKind });
  try {
    return { result, text: drumScore(result), readMs };
  } catch (e) {
    return { result, text: { error: e instanceof Error ? e.message : String(e) }, readMs };
  }
}

export const roundTripOk = (t: FileRun['text']): boolean => !('error' in t) && t.roundTrip.parsed && t.roundTrip.identical;
const roundTripNote = (t: FileRun['text']): string => ('error' in t ? `convert: ${t.error}` : t.roundTrip.problem ?? (t.roundTrip.parsed ? '' : 'not parsed'));

export interface RunSummary {
  configHash: string;
  configName: string;
  commit?: string;
  splits: string[];
  files: number;
  failures: { name: string; reason: string }[];
  roundTrip: { ok: number; failed: number };
  droppedExtHits: number;
  audioSec: number;
  analysisMs: number;
  msPerAudioMinute: number;
  outDir: string;
}

interface SynVariant extends EvalVariant {
  bpm: number;
  ts: [number, number];
  startSec: number;
}

export function runAll(a: Pick<CliArgs, 'splits' | 'only' | 'results' | 'config'> & { level?: DrumLevel }, commit: string | undefined, log: (s: string) => void = (s) => process.stderr.write(s + '\n')): RunSummary {
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { variants: SynVariant[] };
  const vs = selectVariants(manifest.variants, a.splits, a.only) as SynVariant[];
  if (a.only && manifest.variants.some((v) => v.heldOut && (a.only === v.name))) throw new UsageError('held-out variants are never analyzed by --all');
  assertNoHeldOut(vs);
  const cfg = loadConfig(a.config);
  const level = a.level ?? 'S-3';
  const outDir = a.results ? resolve(a.results) : join(ROOT, 'out', 'drum-results', 'analyze');
  mkdirSync(outDir, { recursive: true });
  const rows: DrumReportRow[] = [];
  const kitRows: DrumReportRow[] = [];
  const failures: RunSummary['failures'] = [];
  let rtOk = 0;
  let rtFailed = 0;
  let droppedExt = 0;
  let audioSec = 0;
  let analysisMs = 0;
  const perFile: Record<string, unknown>[] = [];
  for (const v of vs) {
    try {
      const run = runFile(join(OUT, v.wav), { bpm: v.bpm, ts: v.ts, startSec: v.startSec }, cfg, commit, 'synthetic', level);
      const r = run.result;
      // the truth is read only now, after the analysis
      const truth = JSON.parse(readFileSync(join(OUT, v.truth), 'utf8')) as { drum: { truth: DrumTruth; variant: { heldOut: boolean; split: string } } };
      assertNoHeldOut([{ name: v.name, ...truth.drum.variant }]);
      const take: TakeScore = scoreTake({ truth: truth.drum.truth, result: r, level, cfg });
      writeFileSync(join(outDir, `${v.name}.json`), JSON.stringify(r) + '\n', 'utf8');
      writeFileSync(join(outDir, `${v.name}.score.json`), JSON.stringify(take.scores) + '\n', 'utf8');
      if (!('error' in run.text)) {
        writeFileSync(join(outDir, `${v.name}.tex`), run.text.tex + '\n', 'utf8');
        droppedExt += run.text.droppedExt;
      }
      if (roundTripOk(run.text)) rtOk++;
      else {
        rtFailed++;
        failures.push({ name: v.name, reason: `round trip: ${roundTripNote(run.text)}` });
      }
      rows.push({ id: v.name, kind: 'synthetic', level: `${v.split} ${v.level}`, drumLevel: level, take });
      kitRows.push({ id: v.name, kind: 'synthetic', level: `${v.split} ${v.level} k${v.kit}`, drumLevel: level, take });
      const m = r.drum.meta.timings;
      audioSec += m.audioSec;
      analysisMs += m.totalMs;
      perFile.push({ name: v.name, hits: r.drums.length, audioSec: m.audioSec, ms: m.totalMs, roundTrip: roundTripOk(run.text) });
      log(`${v.name}: ${r.drums.length} hits, ${(m.totalMs / 1000).toFixed(2)} s for ${m.audioSec.toFixed(1)} s audio, onset F ${take.scores['onset.f.all']?.toFixed(3)}, round trip ${roundTripOk(run.text) ? 'ok' : 'FAILED'}`);
    } catch (e) {
      failures.push({ name: v.name, reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      log(`${v.name}: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }
  const configHash = drumConfigHash(cfg);
  const summary: RunSummary = {
    configHash,
    configName: cfg.name,
    ...(commit ? { commit } : {}),
    splits: a.splits,
    files: vs.length,
    failures,
    roundTrip: { ok: rtOk, failed: rtFailed },
    droppedExtHits: droppedExt,
    audioSec,
    analysisMs,
    msPerAudioMinute: audioSec ? (analysisMs / audioSec) * 60 : 0,
    outDir,
  };
  const md = [`# Drum analysis run (config ${cfg.name} ${configHash}, commit ${commit ?? '-'}, level ${level})`, '', `Splits ${a.splits.join(',')}; ${vs.length} files; ${failures.length} failures; round trip ${rtOk} ok / ${rtFailed} failed.`, '', '## By split x level', '', renderDrumReport(rows), '## By split x level x kit', '', renderDrumReport(kitRows)].join('\n');
  writeFileSync(join(outDir, 'summary.md'), md + '\n', 'utf8');
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ ...summary, perFile }, null, 1) + '\n', 'utf8');
  log(`done: ${vs.length} files (${a.splits.join(',')}), ${failures.length} failures, round trip ${rtOk}/${vs.length}, config ${configHash}, commit ${commit ?? '-'}, ${summary.msPerAudioMinute.toFixed(0)} ms per audio minute (Node), out ${outDir}`);
  return summary;
}

function runTakes(a: CliArgs, commit: string | undefined): void {
  const cfg = loadConfig(a.config);
  const cfgHash = drumConfigHash(cfg);
  const man = readJson(REC_MANIFEST, (j) => j.variants as RecVariant[]);
  if (!man) throw new UsageError('out/rec/manifest.drum.json is unreadable (run py/drum_intake.py first)');
  const outDir = a.results ? resolve(a.results) : join(ROOT, 'recordings', 'drum-results');
  mkdirSync(outDir, { recursive: true });
  const rows: DrumReportRow[] = [];
  for (const id of a.takes) {
    const v = man.find((x) => x.name === id);
    if (!v) throw new UsageError(`unknown take ${id}`);
    const held = gate(id, a, cfgHash, commit);
    if (!held && a.lookPoint !== undefined) logLook(a.lookPoint, id, false, cfgHash, commit);
    const run = runFile(join(ROOT, v.wav as string), { bpm: v.bpm, ts: v.ts, startSec: v.startSec }, cfg, commit, 'recording', a.level);
    const truth = JSON.parse(readFileSync(join(ROOT, v.truth), 'utf8')) as DrumTruth & { excludedBars?: number[] };
    const take = scoreTake({ truth, result: run.result, level: a.level, cfg, excludedBars: truth.excludedBars ?? v.excludedBars ?? [], align: true });
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify(run.result) + '\n', 'utf8');
    writeFileSync(join(outDir, `${id}.score.json`), JSON.stringify(take.scores) + '\n', 'utf8');
    if (!('error' in run.text)) writeFileSync(join(outDir, `${id}.tex`), run.text.tex + '\n', 'utf8');
    rows.push({ id: '', kind: 'recording', level: held ? 'held-out' : 'dev', drumLevel: a.level, heldOut: held, take });
    const m = run.result.drum.meta.timings;
    process.stderr.write(`${id}: ${run.result.drums.length} hits, ${(m.totalMs / 1000).toFixed(2)} s, round trip ${roundTripOk(run.text) ? 'ok' : 'FAILED'}, config ${cfgHash}\n`);
  }
  process.stdout.write(renderDrumReport(rows) + '\n');
}

function runSingle(a: CliArgs, commit: string | undefined): void {
  const cfg = loadConfig(a.config);
  gate(a.input!, a, drumConfigHash(cfg), commit);
  if (a.bpm === undefined || !Number.isFinite(a.bpm)) throw new UsageError('--bpm is needed');
  if (a.start === undefined || !Number.isFinite(a.start)) throw new UsageError('--start (second of bar 1 beat 1) is needed');
  const run = runFile(a.input!, { bpm: a.bpm, ts: a.ts ?? [4, 4], startSec: a.start }, cfg, commit, 'recording', a.level);
  const m = run.result.drum.meta;
  const st = Object.entries(m.timings.stagesMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ');
  process.stderr.write(`${basename(a.input!)}: ${run.result.drums.length} hits, config ${m.configHash}, ${m.timings.audioSec.toFixed(1)} s audio, total ${(m.timings.totalMs / 1000).toFixed(2)} s (${st}), round trip ${roundTripOk(run.text) ? 'ok' : 'FAILED'}\n`);
  if (m.warnings.length) process.stderr.write(`warnings: ${m.warnings.length}\n`);
  if (a.out) writeFileSync(a.out, JSON.stringify(run.result, null, 1) + '\n', 'utf8');
  else process.stderr.write('no -o: result not written (the JSON holds the hits; stdout never gets them)\n');
}

function main(argv: string[]): number {
  const a = parseArgs(argv);
  const commit = a.commit ?? gitCommit();
  if (a.all) {
    const s = runAll(a, commit);
    return s.failures.length ? 1 : 0;
  }
  if (a.takes.length) {
    runTakes(a, commit);
    return 0;
  }
  if (!a.input) throw new UsageError('no input wav (or --all / --take)');
  runSingle(a, commit);
  return 0;
}

export function run(argv: string[]): void {
  try {
    const code = main(argv);
    if (code) process.exit(code);
  } catch (e) {
    if (e instanceof DrumInputError) {
      process.stderr.write(`error [${e.code}]: ${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\nusage: npx tsx ts/drum/cli.ts <wav> --bpm N [--ts 4/4] --start S [-o out.json] | --all [--split tuning,dev] [--only GLOB] | --take drm-NN-x [--look-point 3]\n`);
      process.exit(2);
    }
    if (e instanceof Error && /^(bpm|拍子|小節頭)/.test(e.message)) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2));
