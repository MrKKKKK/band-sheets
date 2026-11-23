/**
 * The ONE evaluation guard of chords2 (spike 7 T1, docs/audio-spike7-plan.md section 4; spike 8 T2,
 * docs/audio-spike8-plan.md section 4). Every chords2 tool that opens DEV or HELD-OUT material (synthetic dev / held-out
 * split, registered recordings) calls beginLook() before opening any of it and finish() after its aggregates are
 * printed. Tuning-split work is not a look and needs no call. The hold-out count (plan decision 5) calls beginCount().
 *
 * Looks (lines in out/results/heldout-log.jsonl, input 'chords2'):
 *  - Spike 8: 's8-dev-1' ... 's8-dev-3' (dev look points, numbered in the order they run) and 's8-heldout' (once), in
 *    that order: a dev look needs the previous one done, no look may start once a later one has, and 's8-heldout'
 *    needs every started dev look done and the hold-out 'count' line. Spike 7's names ('dev-1' ... 'dev-5',
 *    'heldout') are closed: their lines stay in the log, they are not counted and cannot start again.
 *  - Each look at most once. A 'look-start' line is appended BEFORE any file of the look is opened, a 'look-done' line
 *    at the end. A second start of the same look is refused, finished or not: a run that crashed midway leaves a
 *    start without a done and still counts as the look. The only way to run it again is ONE 'harness-fix' line,
 *    written BEFORE the fix and listing the files the fix may change (scoring harness under HARNESS_DIR only); the
 *    re-run must then be at a clean later commit whose diff from the start's commit touches only those files, with
 *    the same config hashes, takes and synthetic files. At most one re-run per look.
 *  - Every start needs the commit (--commit or BAND_SHEETS_COMMIT) equal to HEAD, a clean working tree, a task, a
 *    reason and the config hash(es); every take registered with the look's split in recordings/chd-ids.local.json;
 *    every synthetic file of a known recipe (synthSplit) and of an allowed split (dev look: dev, or tuning as a
 *    watch; hold-out look: heldOut only). The line records the synthetic count per split and a hash of the names.
 *  - Dry runs (selftests) belong to committed code too: requireCommittedDryRun(argv) (the commit from argv / env only,
 *    never HEAD as a stand-in, or the check would be empty).
 *  - 'count' (once, before 's8-heldout'): the task, commit and the folders the count tool reads, logged BEFORE it
 *    reads them.
 * In a worktree git needs GIT_DIR / GIT_WORK_TREE (docker exec -e ...). Spike 6's ts/bass guards are not used or changed.
 * CLI (from spikes/analysis):
 *   npx tsx ts/chords2/eval/guard.ts --status
 *   npx tsx ts/chords2/eval/guard.ts --log-harness-fix <look> --files <repo path,...> --reason "..."
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allBassVariants } from '../../../render/bass/variants';
import { splitOfName } from '../../../render/chords2/variants';
import { allDevVariants, allVariants } from '../../../render/variants';
import { argOf, parseJsonl, readJson } from '../../bass/evalCommon';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');
export const IDS = join(ROOT, 'recordings', 'chd-ids.local.json');
export const INPUT = 'chords2';
/** Spike 7's look names: closed (their lines stay in the log; they are not counted and cannot start). */
export const S7_LOOKS = ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5', 'heldout'] as const;
/** Spike 8's look names, in the order they must run. */
export const S8_LOOKS = ['s8-dev-1', 's8-dev-2', 's8-dev-3', 's8-heldout'] as const;
export const LOOKS = [...S8_LOOKS, ...S7_LOOKS] as const;
export type Look = (typeof LOOKS)[number];
export type S8Look = (typeof S8_LOOKS)[number];
export type Split = 'dev' | 'heldOut';
/** Repo-relative directory of the scoring harness: the only files a harness fix may list. */
export const HARNESS_DIR = 'spikes/analysis/ts/chords2/eval/';

export const splitOf = (look: Look): Split => (look.endsWith('heldout') ? 'heldOut' : 'dev');
const isS8 = (look: string): look is S8Look => (S8_LOOKS as readonly string[]).includes(look);

export interface RegistryEntry {
  letter?: string;
  heldOut?: boolean;
  split?: string;
  registeredAt?: string;
  from?: { spike: number; heldOut: boolean };
}
/** recordings/chd-ids.local.json `recordings` (null = missing or unreadable). */
export type Registry = Record<string, RegistryEntry>;

/** The synthetic part of a look line: files per split and a hash of the sorted names (spike 7 lines: { split, files }). */
export interface SyntheticLine {
  files: number;
  splits: Record<string, number>;
  namesSha: string;
}

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
  synthetic?: SyntheticLine | { split: string; files: number };
  reason?: string;
  fixes?: string;
  files?: string[];
  rerunOf?: string;
  folders?: string[];
}

export interface LookRequest {
  look: Look;
  task: string;
  reason: string;
  configHashes: string[];
  /** registered recording ids scored in this look (may be empty for a synthetic-only look) */
  takes: string[];
  /** synthetic file names (variant names) scored in this look; their split is derived here, never taken from the caller */
  synthetic?: readonly string[];
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
/** The hold-out count lines (pure). */
export const countLines = (logText: string | null): LogLine[] => parseLog(logText).filter((d) => d.kind === 'count' && d.input === INPUT);

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

/* ------------------------------------------------------------ synthetic files */

let recipeSplits: Map<string, string> | null = null;
/**
 * The split of a synthetic file from its recipe (pure; null = unknown recipe): chords2 `c2-t/d/h-*` by name, spike 6
 * bass `syn-b*` and spike 0 (heldOut, else tuning) by their variant lists. New synthetic material (spike 8 T3) must be
 * added here before a look can score it.
 */
export function synthSplit(name: string): string | null {
  const c2 = splitOfName(name);
  if (c2) return c2;
  recipeSplits ??= new Map<string, string>([
    ...allBassVariants().map((v) => [v.name, v.split] as [string, string]),
    ...allVariants().map((v) => [v.name, v.heldOut ? 'heldOut' : 'tuning'] as [string, string]),
    ...allDevVariants().map((v) => [v.name, 'dev'] as [string, string]), // spike 8 T3: the dev L / LR set
  ]);
  return recipeSplits.get(name) ?? null;
}

/** The splits a look may score synthetic files of: a dev look also scores tuning files as a watch. */
const allowedSynth = (split: Split): readonly string[] => (split === 'dev' ? ['dev', 'tuning'] : ['heldOut']);

/** The synthetic part of the look line, or the reason to refuse (pure). */
export function syntheticCheck(names: readonly string[] | undefined, split: Split, splitOfFile: (name: string) => string | null = synthSplit): { line?: SyntheticLine } | { refuse: string } {
  if (names === undefined || !names.length) return {};
  if (new Set(names).size !== names.length) return { refuse: 'the synthetic file list has duplicates: refusing' };
  const splits: Record<string, number> = {};
  for (const n of names) {
    const s = splitOfFile(n);
    if (s === null) return { refuse: `${n}: not a known synthetic recipe, split unverifiable: refusing` };
    if (!allowedSynth(split).includes(s)) return { refuse: `${n}: ${s} file in a ${split} look: refusing` };
    splits[s] = (splits[s] ?? 0) + 1;
  }
  const namesSha = createHash('sha256').update([...names].sort().join('\n')).digest('hex').slice(0, 12);
  return { line: { files: names.length, splits: Object.fromEntries(Object.entries(splits).sort()), namesSha } };
}

/* ------------------------------------------------------------ order (spike 8) */

/** Reason the look cannot start now because of the order of the spike 8 looks, or null (pure). */
export function orderBlock(logText: string | null, look: Look): string | null {
  if (!isS8(look)) return `${look} is a spike 7 look name, closed in spike 8 (plan section 4-2): use ${S8_LOOKS.join(' / ')}`;
  const i = S8_LOOKS.indexOf(look);
  const later = S8_LOOKS.slice(i + 1).find((l) => lookLines(logText, l).starts.length);
  if (later) return `${later} has already started: the looks run in the order ${S8_LOOKS.join(' -> ')}, refusing`;
  const done = (l: string) => lookLines(logText, l).dones.length > 0;
  if (look === 's8-heldout') {
    const open = S8_LOOKS.slice(0, i).filter((l) => lookLines(logText, l).starts.length && !done(l));
    if (open.length) return `${open.join(', ')} started and never finished: finish (or re-run) it before the hold-out`;
    if (!countLines(logText).length) return 'the hold-out was not counted (count tool, plan decision 5): count it before opening';
  } else if (i > 0 && !done(S8_LOOKS[i - 1])) return `${S8_LOOKS[i - 1]} is not done: the dev looks run in order`;
  return null;
}

/** The look-start line to append BEFORE any file of the look is opened, or the reason to refuse (pure). */
export function startGuard(logText: string | null, registry: Registry | null, req: LookRequest, git: GitState, time: string, splitOfFile: (name: string) => string | null = synthSplit): Result {
  if (!(LOOKS as readonly string[]).includes(req.look)) return { refuse: `unknown look ${req.look} (one of ${S8_LOOKS.join(', ')})` };
  const ob = orderBlock(logText, req.look);
  if (ob) return { refuse: ob };
  if (!nonEmpty(req.task) || !nonEmpty(req.reason)) return { refuse: 'a task and a reason are required' };
  if (!req.configHashes.length || !req.configHashes.every(nonEmpty)) return { refuse: 'the config hash(es) are required' };
  const split = splitOf(req.look);
  const tb = takesBlock(registry, req.takes, split);
  if (tb) return { refuse: tb };
  const sc = syntheticCheck(req.synthetic, split, splitOfFile);
  if ('refuse' in sc) return { refuse: sc.refuse };
  if (!req.takes.length && !sc.line?.splits[split]) return { refuse: `the look has neither takes nor synthetic files of its split (${split})` };
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
    if (!same(req.configHashes, s.configHashes) || !same(req.takes, s.takes) || !same(sc.line ?? null, s.synthetic ?? null)) return { refuse: 'the re-run must use the config hashes, takes and synthetic files of the first start: refusing' };
    rerunOf = s.time;
  }
  const line: LogLine = { time, kind: 'look-start', input: INPUT, look: req.look, split, heldOut: split === 'heldOut', task: req.task, commit: git.head!, configHashes: req.configHashes, takes: req.takes, reason: req.reason };
  if (sc.line) line.synthetic = sc.line;
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
  if (!isS8(look)) return { refuse: `unknown look ${look} (one of ${S8_LOOKS.join(', ')})` };
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

export interface CountRequest {
  task: string;
  reason: string;
  /** what the count tool reads (repo-relative folders, or the recipe it lists) */
  folders: string[];
}

/** The one hold-out 'count' line, appended BEFORE the count tool reads anything, or the reason to refuse (pure). */
export function countGuard(logText: string | null, req: CountRequest, git: Pick<GitState, 'commit' | 'head' | 'porcelain'>, time: string): Result {
  if (!nonEmpty(req.task) || !nonEmpty(req.reason)) return { refuse: 'a task and a reason are required' };
  if (!req.folders.length || !req.folders.every(nonEmpty)) return { refuse: 'list the folders the count reads' };
  const cb = committedBlock(git);
  if (cb) return { refuse: cb };
  if (lookLines(logText, 's8-heldout').starts.length) return { refuse: 'the hold-out look has started: the count belongs before it' };
  const prev = countLines(logText);
  if (prev.length) return { refuse: `the hold-out was already counted (${prev[0].time ?? '?'}, task ${prev[0].task ?? '?'}): refusing a second count` };
  return { line: { time, kind: 'count', input: INPUT, task: req.task, commit: git.head!, folders: [...req.folders], reason: req.reason } };
}

/** One status word per look (pure); spike 7's names are marked closed. */
export function lookStatus(logText: string | null): Record<Look, string> {
  const out = {} as Record<Look, string>;
  for (const look of LOOKS) {
    const { starts, dones, fixes } = lookLines(logText, look);
    const s = dones.length ? `done${starts.length > 1 ? ' (re-run once)' : ''}` : starts.length ? `started, not finished${fixes.length ? ' (harness-fix logged)' : ''}` : 'unused';
    out[look] = isS8(look) ? s : `${s} (spike 7, closed)`;
  }
  return out;
}

// ---------------------------------------------------------------- impure side (files, git)

export const readText = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
export const readRegistry = (): Registry | null => readJson(IDS, (j) => (j && typeof j.recordings === 'object' ? (j.recordings as Registry) : null));

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

/** Where the impure side reads and writes (tests pass a temporary log and a fixed git state). */
export interface GuardIo {
  log: string;
  registry: () => Registry | null;
  gitState: (commit: string | undefined, since: string | undefined) => GitState;
  now: () => string;
}
export const DEFAULT_IO: GuardIo = { log: LOG, registry: readRegistry, gitState, now: () => new Date().toISOString() };

export function appendLog(line: LogLine, log = LOG): void {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify(line) + '\n', 'utf8');
}

/**
 * A selftest / dry run refuses (throws) unless the code is committed: the commit comes from --commit or
 * BAND_SHEETS_COMMIT only. Passing HEAD in its place would make "the commit is required" an empty check.
 */
export function requireCommittedDryRun(argv: string[], io: Pick<GuardIo, 'gitState'> = DEFAULT_IO): void {
  const cb = committedBlock(io.gitState(commitArg(argv), undefined));
  if (cb) throw new Error(`selftest: ${cb}`);
}

/**
 * Logs the look's start (refuses by throwing) BEFORE the caller opens any file of the look; returns finish(), which
 * logs the done line after the aggregates are printed.
 */
export function beginLook(req: LookRequest, commit: string | undefined, io: GuardIo = DEFAULT_IO): { line: LogLine; finish: () => void } {
  const logText = readText(io.log);
  const first = lookLines(logText, req.look).starts[0]?.commit;
  const r = startGuard(logText, io.registry(), req, io.gitState(commit, first), io.now());
  if ('refuse' in r) throw new Error(r.refuse);
  appendLog(r.line, io.log);
  return {
    line: r.line,
    finish: () => {
      const d = doneGuard(readText(io.log), req.look, io.now());
      if ('refuse' in d) throw new Error(d.refuse);
      appendLog(d.line, io.log);
    },
  };
}

/** Logs the hold-out 'count' line (refuses by throwing) BEFORE the count tool reads anything. */
export function beginCount(req: CountRequest, commit: string | undefined, io: GuardIo = DEFAULT_IO): LogLine {
  const r = countGuard(readText(io.log), req, io.gitState(commit, undefined), io.now());
  if ('refuse' in r) throw new Error(r.refuse);
  appendLog(r.line, io.log);
  return r.line;
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
  const text = readText(LOG);
  for (const [l, s] of Object.entries(lookStatus(text))) console.log(`${l}: ${s}`);
  const c = countLines(text);
  console.log(`count: ${c.length ? `done (${c[0].time ?? '?'})` : 'not yet'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
