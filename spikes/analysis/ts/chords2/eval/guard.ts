/**
 * Spike 7 T1: the ONE evaluation guard of chords2 (docs/audio-spike7-plan.md section 4). Every chords2 tool that opens
 * DEV or HELD-OUT material (synthetic dev / held-out split, registered recordings) calls beginLook() before opening any
 * of it and finish() after its aggregates are printed. Tuning-split work is not a look and needs no call.
 *
 * Looks (lines in out/results/heldout-log.jsonl, input 'chords2'):
 *  - 'dev-1' ... 'dev-5' = look points 1-5 (G1, G2, G3-G5), each at most once (so at most 5 dev looks), and 'heldout'
 *    exactly once. A 'look-start' line is appended BEFORE any file of the look is opened, a 'look-done' line at the end.
 *  - A second start of the same look is refused, finished or not: a run that crashed midway leaves a start without a
 *    done and still counts as the look. The only way to run it again is ONE 'harness-fix' line, written BEFORE the fix
 *    and listing the files the fix may change (scoring harness under HARNESS_DIR only); the re-run must then be at a
 *    clean later commit whose diff from the start's commit touches only those files, with the same config hashes,
 *    takes and synthetic count. At most one re-run per look.
 *  - Every start needs the commit (--commit or BAND_SHEETS_COMMIT) equal to HEAD, a clean working tree, a task, a
 *    reason and the config hash(es), and every take registered with the look's split in recordings/chd-ids.local.json.
 *    Dry runs (selftests) belong to committed code too: use committedBlock().
 * In a worktree git needs GIT_DIR / GIT_WORK_TREE (docker exec -e ...). Spike 6's ts/bass guards are not used or changed.
 * CLI (from spikes/analysis):
 *   npx tsx ts/chords2/eval/guard.ts --status
 *   npx tsx ts/chords2/eval/guard.ts --log-harness-fix <look> --files <repo path,...> --reason "..."
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argOf, parseJsonl, readJson } from '../../bass/evalCommon';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');
export const IDS = join(ROOT, 'recordings', 'chd-ids.local.json');
export const INPUT = 'chords2';
export const LOOKS = ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5', 'heldout'] as const;
export type Look = (typeof LOOKS)[number];
export type Split = 'dev' | 'heldOut';
/** Repo-relative directory of the scoring harness: the only files a harness fix may list. */
export const HARNESS_DIR = 'spikes/analysis/ts/chords2/eval/';

export const splitOf = (look: Look): Split => (look === 'heldout' ? 'heldOut' : 'dev');

export interface RegistryEntry {
  letter?: string;
  heldOut?: boolean;
  split?: string;
  registeredAt?: string;
  from?: { spike: number; heldOut: boolean };
}
/** recordings/chd-ids.local.json `recordings` (null = missing or unreadable). */
export type Registry = Record<string, RegistryEntry>;

export interface LogLine {
  time?: string;
  kind?: string;
  input?: string;
  look?: string;
  split?: string;
  heldOut?: boolean;
  task?: string;
  commit?: string;
  configHashes?: string[];
  takes?: string[];
  synthetic?: { split: string; files: number };
  reason?: string;
  fixes?: string;
  files?: string[];
  rerunOf?: string;
}

export interface LookRequest {
  look: Look;
  task: string;
  reason: string;
  configHashes: string[];
  /** registered recording ids scored in this look (may be empty for a synthetic-only look) */
  takes: string[];
  synthetic?: { split: string; files: number };
}

export interface GitState {
  /** --commit / BAND_SHEETS_COMMIT */
  commit: string | undefined;
  /** full `git rev-parse HEAD`; null when git failed */
  head: string | null;
  /** `git status --porcelain`; null when git failed */
  porcelain: string | null;
  /** `git diff --name-only <commit of the look's start> HEAD` (repo-relative); null when failed or not computed */
  changed: string[] | null;
}

type Result = { line: LogLine } | { refuse: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const mine = (lines: LogLine[], kind: string, look: string) => lines.filter((d) => d.kind === kind && d.input === INPUT && d.look === look);
export const parseLog = (logText: string | null): LogLine[] => parseJsonl<LogLine>(logText);

/** The look's lines: starts, dones, harness fixes (pure). */
export function lookLines(logText: string | null, look: string) {
  const lines = parseLog(logText);
  return { starts: mine(lines, 'look-start', look), dones: mine(lines, 'look-done', look), fixes: mine(lines, 'harness-fix', look) };
}

/** Reason the run is not on committed, clean code, or null (pure). Commit = HEAD by prefix (>= 7 hex). */
export function committedBlock(g: Pick<GitState, 'commit' | 'head' | 'porcelain'>): string | null {
  if (!g.commit) return 'the commit is required: pass --commit or BAND_SHEETS_COMMIT';
  if (!/^[0-9a-f]{7,40}$/i.test(g.commit)) return `commit ${g.commit} is not a hex sha of 7-40 characters: refusing`;
  if (g.head === null || g.porcelain === null) return 'git failed (in a worktree pass GIT_DIR / GIT_WORK_TREE): refusing';
  if (!g.head.startsWith(g.commit.toLowerCase())) return `commit ${g.commit} is not HEAD ${g.head.slice(0, 12)}: refusing`;
  if (g.porcelain !== '') return 'the working tree is not clean: commit first';
  return null;
}

/** Reason a take is not registered with this split in the spike 7 registry, or null (pure). */
export function takesBlock(registry: Registry | null, takes: readonly string[], split: Split): string | null {
  if (!takes.length) return null;
  if (registry === null) return 'recordings/chd-ids.local.json is missing or unreadable, splits unverifiable: refusing';
  for (const id of takes) {
    if (!Object.prototype.hasOwnProperty.call(registry, id)) return `${id}: not registered for spike 7, split unverifiable: refusing`;
    const e = registry[id];
    if (typeof e.heldOut !== 'boolean' || (e.split !== 'dev' && e.split !== 'heldOut') || e.heldOut !== (e.split === 'heldOut')) return `${id}: split flags disagree: refusing`;
    if (e.split !== split) return `${id}: registered as ${e.split}, this look is ${split}: refusing`;
  }
  return null;
}

/** The look-start line to append BEFORE any file of the look is opened, or the reason to refuse (pure). */
export function startGuard(logText: string | null, registry: Registry | null, req: LookRequest, git: GitState, time: string): Result {
  if (!(LOOKS as readonly string[]).includes(req.look)) return { refuse: `unknown look ${req.look} (one of ${LOOKS.join(', ')})` };
  if (!nonEmpty(req.task) || !nonEmpty(req.reason)) return { refuse: 'a task and a reason are required' };
  if (!req.configHashes.length || !req.configHashes.every(nonEmpty)) return { refuse: 'the config hash(es) are required' };
  const split = splitOf(req.look);
  const tb = takesBlock(registry, req.takes, split);
  if (tb) return { refuse: tb };
  if (!req.takes.length && !req.synthetic?.files) return { refuse: 'the look has neither takes nor synthetic files' };
  const cb = committedBlock(git);
  if (cb) return { refuse: cb };
  const { starts, dones, fixes } = lookLines(logText, req.look);
  let rerunOf: string | undefined;
  if (starts.length) {
    if (dones.length) return { refuse: `look ${req.look} was already run to the end: refusing to run it again` };
    if (starts.length > 1) return { refuse: `look ${req.look} was already re-run once: refusing` };
    const s = starts[0];
    if (fixes.length !== 1) return { refuse: `look ${req.look} was started (${s.time ?? '?'}) and never finished: it counts as looked; a re-run needs one harness-fix line first (--log-harness-fix)` };
    if (git.head!.startsWith(s.commit ?? '\0')) return { refuse: 'HEAD is still the commit of the first start: commit the harness fix first' };
    if (git.changed === null) return { refuse: 'git diff against the first start failed: refusing' };
    const other = git.changed.filter((p) => !fixes[0].files!.includes(p));
    if (other.length) return { refuse: `changes since the first start outside the harness-fix list (${other.join(', ')}): refusing` };
    if (!same(req.configHashes, s.configHashes) || !same(req.takes, s.takes) || !same(req.synthetic ?? null, s.synthetic ?? null)) return { refuse: 'the re-run must use the config hashes, takes and synthetic count of the first start: refusing' };
    rerunOf = s.time;
  }
  const line: LogLine = { time, kind: 'look-start', input: INPUT, look: req.look, split, heldOut: split === 'heldOut', task: req.task, commit: git.head!, configHashes: req.configHashes, takes: req.takes, reason: req.reason };
  if (req.synthetic) line.synthetic = req.synthetic;
  if (rerunOf) line.rerunOf = rerunOf;
  return { line };
}

/** The look-done line (pure): only after a start of the look and before any done. */
export function doneGuard(logText: string | null, look: Look, time: string): Result {
  const { starts, dones } = lookLines(logText, look);
  if (!starts.length) return { refuse: `look ${look} was never started` };
  if (dones.length) return { refuse: `look ${look} is already done` };
  const s = starts[starts.length - 1];
  return { line: { time, kind: 'look-done', input: INPUT, look, task: s.task, commit: s.commit } };
}

/**
 * The one harness-fix line of a look that started and did not finish (pure). Written BEFORE the fix is made: `files`
 * are the repo-relative files the fix may change, all under HARNESS_DIR (no analyzer, config or truth code).
 */
export function harnessFixGuard(logText: string | null, look: Look, files: readonly string[], reason: string, time: string): Result {
  if (!(LOOKS as readonly string[]).includes(look)) return { refuse: `unknown look ${look}` };
  const { starts, dones, fixes } = lookLines(logText, look);
  if (starts.length !== 1) return { refuse: `look ${look} has ${starts.length} starts; a harness fix needs exactly one (a started, unfinished look)` };
  if (dones.length) return { refuse: `look ${look} is done: a harness fix is no longer allowed` };
  if (fixes.length) return { refuse: `look ${look} already has a harness-fix line: refusing a second one` };
  if (!nonEmpty(reason)) return { refuse: 'a reason is required' };
  if (!files.length) return { refuse: 'list the files the fix may change' };
  const bad = files.filter((f) => !f.startsWith(HARNESS_DIR) || f.split('/').includes('..'));
  if (bad.length) return { refuse: `only scoring-harness files under ${HARNESS_DIR} may be listed (${bad.join(', ')}): refusing` };
  return { line: { time, kind: 'harness-fix', input: INPUT, look, fixes: starts[0].commit, files: [...files], reason } };
}

/** One status word per look (pure). */
export function lookStatus(logText: string | null): Record<Look, string> {
  const out = {} as Record<Look, string>;
  for (const look of LOOKS) {
    const { starts, dones, fixes } = lookLines(logText, look);
    out[look] = dones.length ? `done${starts.length > 1 ? ' (re-run once)' : ''}` : starts.length ? `started, not finished${fixes.length ? ' (harness-fix logged)' : ''}` : 'unused';
  }
  return out;
}

// ---------------------------------------------------------------- impure side (files, git)

export const readText = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
export const readRegistry = (): Registry | null => readJson(IDS, (j) => (j && typeof j.recordings === 'object' ? (j.recordings as Registry) : null));

export function appendLog(line: LogLine): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(line) + '\n', 'utf8');
}

/** git output (trimmed), or null when git failed. */
export const git = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

export const commitArg = (argv: string[]): string | undefined => argOf(argv, '--commit') ?? process.env.BAND_SHEETS_COMMIT;

function gitState(commit: string | undefined, since: string | undefined): GitState {
  const head = git(['rev-parse', 'HEAD']);
  const diff = since && head && head !== since ? git(['diff', '--name-only', since, 'HEAD']) : null;
  return { commit, head, porcelain: git(['status', '--porcelain']), changed: diff === null ? null : diff.split('\n').filter((x) => x) };
}

/**
 * Logs the look's start (refuses by throwing) BEFORE the caller opens any file of the look; returns finish(), which
 * logs the done line after the aggregates are printed.
 */
export function beginLook(req: LookRequest, commit: string | undefined): { line: LogLine; finish: () => void } {
  const logText = readText(LOG);
  const first = lookLines(logText, req.look).starts[0]?.commit;
  const r = startGuard(logText, readRegistry(), req, gitState(commit, first), new Date().toISOString());
  if ('refuse' in r) throw new Error(r.refuse);
  appendLog(r.line);
  return {
    line: r.line,
    finish: () => {
      const d = doneGuard(readText(LOG), req.look, new Date().toISOString());
      if ('refuse' in d) throw new Error(d.refuse);
      appendLog(d.line);
    },
  };
}

function main(argv: string[]): void {
  const look = argOf(argv, '--log-harness-fix');
  if (look !== undefined) {
    const files = (argOf(argv, '--files') ?? '').split(',').filter((f) => f);
    const r = harnessFixGuard(readText(LOG), look as Look, files, argOf(argv, '--reason') ?? '', new Date().toISOString());
    if ('refuse' in r) throw new Error(r.refuse);
    appendLog(r.line);
    console.log(`harness-fix line logged for look ${look} (${files.length} files)`);
    return;
  }
  if (!argv.includes('--status')) throw new Error('give --status or --log-harness-fix <look> --files ... --reason ...');
  for (const [l, s] of Object.entries(lookStatus(readText(LOG)))) console.log(`${l}: ${s}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
