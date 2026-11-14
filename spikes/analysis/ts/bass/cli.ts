/**
 * Spike 6 T7: Node CLI of the bass analyzer (docs/audio-spike6-plan.md T7, docs/audio-spike6-t7.md). Run from
 * spikes/analysis in the devcontainer.
 *
 *   npx tsx ts/bass/cli.ts --all [--split tuning|dev|tuning,dev] [--only GLOB] [--results DIR] [--config x.json]
 *        [--commit SHA] [--dev-look "<reason>" [--task T9]]
 *        every out/bass manifest variant of the splits (default tuning) through ts/dsp analyze + the bass stage
 *        (analyze.ts, bass ON); writes <name>.json (result) and run.json (config, commit, counts, timings) into
 *        out/bass-results/analyze (or DIR). No scoring here (T8). Exit 1 when a file fails.
 *   npx tsx ts/bass/cli.ts <wav> [-o out.json] [--config x.json] [--commit SHA] [--dev-look "<reason>"]
 *        one file (a listed synthetic variant or a registered recording); without -o only counts and timings are printed.
 *
 * Config: DEFAULT_BASS_CONFIG with `enabled: true`, then the --config overrides (config.ts enabledBassConfig).
 * HELD-OUT: refused before any wav is opened — `--split heldOut`, an --only glob that matches a held-out variant,
 * timbre C, and anything whose flag cannot be verified (heldout_guard.ts heldOutRefusal, checked per file again).
 * DEV LOOKS: the dev split (also a single dev variant) needs --dev-look and appends one line (task --task, T7) to
 * out/results/heldout-log.jsonl before the run. The commit comes from --commit, BAND_SHEETS_COMMIT or git (inside the
 * devcontainer git cannot resolve a worktree: pass BAND_SHEETS_COMMIT).
 * Privacy: stdout/stderr get counts and timings only (no chords, no bass names). Reads local files only; no network.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWav } from '../browser/wav';
import { AnalysisInputError } from '../dsp/analyze';
import { resampleSinc, toMono } from '../dsp/core/resample';
import { analyzeWithBass, BASS_STAGES, type BassAnalyzeOutput } from './analyze';
import { bassConfigHash, enabledBassConfig, type BassConfig } from './config';
import { devLookCount, devLookLine, globRegExp, heldOutRefusal, isHeld, selectVariants, type GuardSources, type GuardVariant } from './heldout_guard';
import { LOW_SR } from './lowCqt';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'out', 'bass');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');
const REC_MANIFEST = join(ROOT, 'out', 'rec', 'manifest.bass.json');
const IDS = join(ROOT, 'recordings', 'bas-ids.local.json');

export class UsageError extends Error {}

export interface CliArgs {
  input?: string;
  out?: string;
  config?: string;
  commit?: string;
  results?: string;
  devLook?: string;
  /** Task named in the dev-look log line (default T7). */
  task?: string;
  all: boolean;
  splits: string[];
  only?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { all: false, splits: ['tuning'] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      return v;
    };
    if (k === '-o' || k === '--out') a.out = val();
    else if (k === '--config') a.config = val();
    else if (k === '--commit') a.commit = val();
    else if (k === '--results') a.results = val();
    else if (k === '--dev-look') a.devLook = val();
    else if (k === '--task') a.task = val();
    else if (k === '--all') a.all = true;
    else if (k === '--split') a.splits = val().split(',');
    else if (k === '--only') a.only = val();
    else if (k.startsWith('-')) throw new UsageError(`unknown option ${k}`);
    else if (a.input === undefined) a.input = k;
    else throw new UsageError(`unexpected argument ${k}`);
  }
  return a;
}

export interface SynVariant extends GuardVariant {
  level: string;
  wav: string;
  audioSec: number;
}

/** Variants for --all; refuses held-out requests and an unlogged dev split (pure, tested). */
export function planAll(all: readonly SynVariant[], a: Pick<CliArgs, 'splits' | 'only' | 'devLook'>): SynVariant[] {
  if (a.only && all.some((v) => isHeld(v) && globRegExp(a.only!).test(v.name))) throw new UsageError(`--only ${a.only} matches a held-out variant: refused`);
  let vs: SynVariant[];
  try {
    vs = selectVariants(all, a.splits, a.only);
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : e}: refused`);
  }
  if (a.splits.includes('dev') && !a.devLook) throw new UsageError('the dev split is a logged look: pass --dev-look "<reason>"');
  if (vs.length === 0) throw new UsageError('no variant selected');
  return vs;
}

/** Single file: refusal reason as UsageError; returns whether it is a dev synthetic variant (a logged look). */
export function gateSingle(input: string, src: GuardSources, devLook?: string): { dev: boolean } {
  const refusal = heldOutRefusal(input, src);
  if (refusal) throw new UsageError(refusal);
  const stem = basename(input).replace(/\.wav$/i, '');
  const dev = src.syn?.some((v) => (v.name === stem || (v.wav !== undefined && basename(v.wav) === basename(input))) && v.split === 'dev') ?? false;
  if (dev && !devLook) throw new UsageError('a dev synthetic variant is a logged look: pass --dev-look "<reason>"');
  return { dev };
}

const readJson = <T>(path: string, pick: (j: any) => T): T | null => {
  try {
    return pick(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
};

export function guardSources(): GuardSources {
  return {
    syn: readJson(join(OUT, 'manifest.json'), (j) => j.variants as GuardVariant[]),
    rec: readJson(REC_MANIFEST, (j) => j.variants as GuardVariant[]),
    ids: readJson(IDS, (j) => j.recordings as Record<string, { heldOut?: boolean }>),
  };
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function logDevLook(reason: string, cfg: BassConfig, commit: string | undefined, files: number, task = 'T7'): void {
  if (!commit) throw new UsageError('a dev look needs the commit: pass --commit or BAND_SHEETS_COMMIT');
  const before = existsSync(LOG) ? readFileSync(LOG, 'utf8') : null;
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, devLookLine({ task, reason, configHash: bassConfigHash(cfg), commit, files, at: new Date().toISOString() }) + '\n');
  process.stderr.write(`dev look #${devLookCount(before) + 1} logged\n`);
}

interface FileStats {
  audioSec: number;
  v1aMs: number;
  bassMs: number;
  chords: number;
  marked: number;
}

function runFile(path: string, cfg: BassConfig, commit: string | undefined): { out: BassAnalyzeOutput; stats: FileStats } {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  const y = resampleSinc(toMono(wav.channels), wav.sampleRate, LOW_SR);
  const audioSec = y.length / LOW_SR;
  const out = analyzeWithBass({ y }, { bass: cfg, commit });
  const isBass = (n: string) => (BASS_STAGES as readonly string[]).includes(n);
  const ms = (pick: (n: string) => boolean) => out.stats.filter((s) => pick(s.name)).reduce((a, s) => a + s.ms, 0);
  const chords = out.result.chords;
  return { out, stats: { audioSec, v1aMs: ms((n) => !isBass(n)), bassMs: ms(isBass), chords: chords.length, marked: chords.filter((c) => c.bass !== null).length } };
}

const perMin = (ms: number, sec: number) => (sec ? (ms / sec) * 60 : 0);

function runAll(a: CliArgs, cfg: BassConfig, commit: string | undefined): number {
  const src = guardSources();
  if (!src.syn) throw new UsageError('out/bass/manifest.json unreadable: refusing (run render/bass/cli.ts first)');
  const vs = planAll(src.syn as SynVariant[], a);
  if (a.splits.includes('dev')) logDevLook(a.devLook!, cfg, commit, vs.length, a.task);
  const outDir = a.results ? resolve(a.results) : join(ROOT, 'out', 'bass-results', 'analyze');
  mkdirSync(outDir, { recursive: true });
  const failures: { name: string; reason: string }[] = [];
  const perFile: (FileStats & { name: string; split?: string; level: string })[] = [];
  for (const v of vs) {
    try {
      const refusal = heldOutRefusal(v.wav, src);
      if (refusal) throw new UsageError(`${v.name}: ${refusal}`);
      const { out, stats } = runFile(join(OUT, v.wav), cfg, commit);
      writeFileSync(join(outDir, `${v.name}.json`), JSON.stringify(out.result) + '\n', 'utf8');
      perFile.push({ name: v.name, split: v.split, level: v.level, ...stats });
    } catch (e) {
      if (e instanceof UsageError) throw e;
      failures.push({ name: v.name, reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      process.stderr.write(`${v.name}: FAILED ${e instanceof Error ? e.message : e}\n`);
    }
  }
  const sum = (k: keyof FileStats) => perFile.reduce((x, f) => x + f[k], 0);
  const audioSec = sum('audioSec');
  const summary = {
    config: cfg.name,
    configHash: bassConfigHash(cfg),
    ...(commit ? { commit } : {}),
    splits: a.splits,
    files: vs.length,
    failures,
    audioSec,
    msPerAudioMinute: { v1a: perMin(sum('v1aMs'), audioSec), bass: perMin(sum('bassMs'), audioSec) },
    chords: sum('chords'),
    marked: sum('marked'),
    outDir,
  };
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ ...summary, perFile }, null, 1) + '\n', 'utf8');
  process.stderr.write(
    `done: ${vs.length} files (${a.splits.join(',')}, ${(audioSec / 60).toFixed(1)} audio min), ${failures.length} failures, ` +
      `config ${summary.configHash}, commit ${commit ?? '-'}; ms per audio minute (Node, one thread): v1a ${summary.msPerAudioMinute.v1a.toFixed(0)}, ` +
      `bass stage ${summary.msPerAudioMinute.bass.toFixed(0)}; out ${outDir}\n`,
  );
  return failures.length ? 1 : 0;
}

function runSingle(a: CliArgs, cfg: BassConfig, commit: string | undefined): void {
  const { dev } = gateSingle(a.input!, guardSources(), a.devLook);
  if (dev) logDevLook(a.devLook!, cfg, commit, 1, a.task);
  const { out, stats } = runFile(a.input!, cfg, commit);
  process.stderr.write(
    `${basename(a.input!)}: ${stats.chords} chords, ${stats.marked} with /X, config ${bassConfigHash(cfg)}, ${stats.audioSec.toFixed(1)} s audio, ` +
      `v1a ${(stats.v1aMs / 1000).toFixed(2)} s, bass stage ${(stats.bassMs / 1000).toFixed(2)} s\n`,
  );
  if (a.out) writeFileSync(a.out, JSON.stringify(out.result, null, 1) + '\n', 'utf8');
  else process.stderr.write('no -o: result not written (stdout never gets chords)\n');
}

function main(argv: string[]): number {
  const a = parseArgs(argv);
  const cfg = enabledBassConfig(a.config ? (JSON.parse(readFileSync(a.config, 'utf8')) as unknown) : {});
  const commit = a.commit ?? process.env.BAND_SHEETS_COMMIT ?? gitCommit();
  if (a.all) return runAll(a, cfg, commit);
  if (!a.input) throw new UsageError('no input wav (or --all)');
  runSingle(a, cfg, commit);
  return 0;
}

export function run(argv: string[]): void {
  try {
    const code = main(argv);
    if (code) process.exit(code);
  } catch (e) {
    if (e instanceof AnalysisInputError) {
      process.stderr.write(`error [${e.code}]: ${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\nusage: npx tsx ts/bass/cli.ts --all [--split tuning|dev] [--only GLOB] [--dev-look "<reason>"] | <wav> [-o out.json]\n`);
      process.exit(2);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2));
