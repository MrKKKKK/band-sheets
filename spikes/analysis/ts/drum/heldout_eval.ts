/**
 * Spike 5 T14: the ONE entry for look point 3 (held-out recordings, once), like spike 4's ts/hum/heldout_eval.ts.
 *
 *   npx tsx ts/drum/heldout_eval.ts --final-heldout [--commit SHA] [--config x.json]
 *       Checked ONCE at the start (clean working tree, no drum look-3 held-out line in out/results/heldout-log.jsonl,
 *       otherwise refuses before any audio is read). Then writes ONE look-3 line (before the analysis: recording ids,
 *       levels S-3 / S-9 / S-ext, config hash, commit) and analyzes every held-out recording x all three levels.
 *       Main level of the summary = S-9, S-3 and S-ext alongside.
 *   npx tsx ts/drum/heldout_eval.ts --selftest [--commit SHA] [--config x.json]
 *       The same pipeline on the DEV recordings; never writes a look-3 line, refuses held-out ids.
 *
 * Output: aggregates only (pooled and per-take F50, grid, edits vs keyboard, confusion counts) to stdout and to
 * out/heldout-eval/<final|selftest>/summary.md (gitignored). No hits and no per-take result JSON are written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drumConfigHash, type DrumConfig } from './config';
import { UsageError, guardSources, gitCommit, gitPorcelain, loadConfig, runFile } from './cli';
import { hasDrumLook3, heldOutRefusal, lookPointBlock, parseLog, type GuardSources } from './heldout_guard';
import { poolTakes, type PoolItem } from './pool';
import type { DrumTruth } from './score';
import type { DrumLevel } from './types';

export const EVAL_LEVELS: DrumLevel[] = ['S-9', 'S-3', 'S-ext'];
const ROOT = join(import.meta.dirname, '..', '..');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');

export interface RecEntry {
  name: string;
  heldOut?: boolean;
}

/** The ONE log line of the final run (written before the analysis). */
export function finalLogLine(o: { time: string; takes: string[]; levels: DrumLevel[]; configHash: string; commit?: string }): string {
  return JSON.stringify({ time: o.time, kind: 'look', input: 'drum', lookPoint: 3, take: 'heldout', heldOut: true, variants: o.takes, levels: o.levels, configHash: o.configHash, ...(o.commit ? { commit: o.commit } : {}), task: 'T14' });
}

export interface EvalDeps {
  mode: 'final' | 'selftest';
  /** Recordings of out/rec/manifest.drum.json. */
  recordings: RecEntry[];
  sources: GuardSources;
  readLog(): string | null;
  appendLog(line: string): void;
  porcelain(): string | null;
  now(): string;
  configHash: string;
  commit?: string;
  /** Analyzes + loads the truth of ONE take at one level; called only after the guard has passed. */
  analyze(id: string, level: DrumLevel): PoolItem;
}

export interface EvalOutcome {
  takes: string[];
  logged: boolean;
  report: string;
}

/** The whole guard + run. final: guard once, one log line, then everything. selftest: dev takes only, never logs. */
export function runEval(d: EvalDeps): EvalOutcome {
  if (d.recordings.length === 0) throw new UsageError('no recordings in the manifest');
  const wantHeld = d.mode === 'final';
  const takes = d.recordings.filter((r) => (r.heldOut === true) === wantHeld).map((r) => r.name);
  if (takes.length === 0) throw new UsageError(wantHeld ? 'no held-out recordings in the manifest' : 'no dev recordings in the manifest');
  if (d.mode === 'selftest') {
    for (const id of takes) if (heldOutRefusal(id, d.sources)) throw new UsageError(`selftest refuses ${id}: held-out or unverifiable`);
  } else {
    const logText = d.readLog();
    if (hasDrumLook3(parseLog(logText))) throw new UsageError('a drum look-3 line already exists in the heldout log: refusing to run again');
    const block = lookPointBlock({ lookPoint: 3, logText, porcelain: d.porcelain() });
    if (block) throw new UsageError(block);
    d.appendLog(finalLogLine({ time: d.now(), takes, levels: EVAL_LEVELS, configHash: d.configHash, commit: d.commit }));
  }
  const parts = EVAL_LEVELS.map((level) => poolTakes(takes.map((id) => d.analyze(id, level)), level));
  const report = [`# Drum ${d.mode === 'final' ? 'held-out (look point 3)' : 'selftest on dev takes'} (config ${d.configHash}, commit ${d.commit ?? '-'}; main level S-9)`, '', `takes: ${takes.length}`, '', ...parts].join('\n');
  return { takes, logged: d.mode === 'final', report };
}

function realDeps(mode: 'final' | 'selftest', cfg: DrumConfig, commit: string | undefined): EvalDeps {
  const recPath = join(ROOT, 'out', 'rec', 'manifest.drum.json');
  const man = JSON.parse(readFileSync(recPath, 'utf8')).variants as (RecEntry & { wav: string; truth: string; bpm: number; ts: [number, number]; startSec: number })[];
  return {
    mode,
    recordings: man,
    sources: guardSources(),
    readLog: () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : null),
    appendLog: (line) => {
      mkdirSync(join(ROOT, 'out', 'results'), { recursive: true });
      appendFileSync(LOG, line + '\n', 'utf8');
    },
    porcelain: gitPorcelain,
    now: () => new Date().toISOString(),
    configHash: drumConfigHash(cfg),
    commit,
    analyze: (id, level) => {
      const v = man.find((x) => x.name === id)!;
      const run = runFile(join(ROOT, v.wav), { bpm: v.bpm, ts: v.ts, startSec: v.startSec }, cfg, commit, 'recording', level);
      const truth = JSON.parse(readFileSync(join(ROOT, v.truth), 'utf8')) as PoolItem['truth'];
      return { id, truth: truth as DrumTruth & { excludedBars?: number[] }, result: run.result };
    },
  };
}

function main(argv: string[]): number {
  let mode: 'final' | 'selftest' | undefined;
  let commit: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--final-heldout') mode = 'final';
    else if (k === '--selftest') mode = mode ?? 'selftest';
    else if (k === '--commit') commit = argv[++i];
    else if (k === '--config') config = argv[++i];
    else throw new UsageError(`unknown option ${k}`);
  }
  if (!mode) throw new UsageError('give --final-heldout (look point 3, once) or --selftest (dev takes)');
  const cfg = loadConfig(config);
  const out = runEval(realDeps(mode, cfg, commit ?? gitCommit()));
  const dir = join(ROOT, 'out', 'heldout-eval', mode === 'final' ? 'final' : 'selftest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.md'), out.report, 'utf8');
  process.stdout.write(out.report);
  process.stderr.write(`done: ${out.takes.length} takes x ${EVAL_LEVELS.length} levels, look-3 line ${out.logged ? 'written' : 'not written'}, ${resolve(dir, 'summary.md')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}
