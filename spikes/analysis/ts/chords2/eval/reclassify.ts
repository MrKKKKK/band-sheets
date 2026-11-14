/**
 * Spike 7 T1: re-registers spike 6's six piano recordings a-f as spike 7 DEV (docs/audio-spike7-plan.md section 4 item 3,
 * user decision 6, 2026-11-14: all of a-f are dev only, never hold-out; their looks are counted by the guard). One shot:
 *
 *   BAND_SHEETS_COMMIT=SHA npx tsx ts/chords2/eval/reclassify.ts --from <spike 6 spikes/analysis/recordings>
 *       (from spikes/analysis; in a worktree also GIT_DIR / GIT_WORK_TREE)
 *
 * Reads spike 6's registry (bas-ids.local.json; never written), refuses unless it lists exactly bas-01-a ... bas-06-f
 * with e/f held out, and refuses when spike 7's registry already has any of them or the log has a reclassify line. Each
 * destination must be gitignored (`git check-ignore`) and absent. Then COPIES (never opens or analyses) <id>.wav,
 * <id>.truth.json and bas-originals/<id>.txt into this worktree's recordings/, adds the six ids as dev to
 * recordings/chd-ids.local.json and appends ONE 'reclassify' line to out/results/heldout-log.jsonl.
 * Prints counts only.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argOf, readJson } from '../../bass/evalCommon';
import { appendLog, commitArg, git, IDS, INPUT, LOG, parseLog, readRegistry, readText, ROOT, type LogLine, type Registry } from './guard';

export const SPIKE6_IDS = ['bas-01-a', 'bas-02-b', 'bas-03-c', 'bas-04-d', 'bas-05-e', 'bas-06-f'];
export const SPIKE6_HELD_OUT = ['bas-05-e', 'bas-06-f'];
export const DECISION = 'user decision 6 (2026-11-14): spike 6 recordings a-f are spike 7 dev only, never hold-out; looks counted';
/** Files of one take, relative to a recordings folder. */
export const takeFiles = (id: string): string[] => [`${id}.wav`, `${id}.truth.json`, `bas-originals/${id}.txt`];

/** The spike 7 registry with a-f added as dev and the one reclassify line, or the reason to refuse (pure). */
export function reclassifyPlan(spike6: Registry | null, registry: Registry | null, logText: string | null, commit: string, time: string): { registry: Registry; line: LogLine } | { refuse: string } {
  if (spike6 === null) return { refuse: "spike 6's bas-ids.local.json is missing or unreadable" };
  const ids = Object.keys(spike6).sort();
  if (JSON.stringify(ids) !== JSON.stringify(SPIKE6_IDS)) return { refuse: `spike 6's registry lists ${ids.length} ids, expected ${SPIKE6_IDS.join(', ')}` };
  for (const id of SPIKE6_IDS) if (spike6[id].heldOut !== SPIKE6_HELD_OUT.includes(id)) return { refuse: `${id}: spike 6 held-out flag is not the expected one` };
  const taken = SPIKE6_IDS.filter((id) => registry !== null && Object.prototype.hasOwnProperty.call(registry, id));
  if (taken.length) return { refuse: `already registered for spike 7: ${taken.join(', ')}` };
  if (parseLog(logText).some((d) => d.kind === 'reclassify' && d.input === INPUT)) return { refuse: 'the log already has a chords2 reclassify line' };
  const out: Registry = { ...(registry ?? {}) };
  for (const id of SPIKE6_IDS) out[id] = { letter: spike6[id].letter, heldOut: false, split: 'dev', registeredAt: time, from: { spike: 6, heldOut: spike6[id].heldOut === true } };
  const line: LogLine & Record<string, unknown> = {
    time,
    kind: 'reclassify',
    input: INPUT,
    task: 'T1',
    split: 'dev',
    heldOut: false,
    takes: SPIKE6_IDS,
    spike6: { dev: SPIKE6_IDS.filter((id) => !SPIKE6_HELD_OUT.includes(id)), heldOut: SPIKE6_HELD_OUT, heldOutLooks: 1 },
    decision: DECISION,
    commit,
    reason: 'e/f were spike 6 hold-out and were looked at once (T13); a-d were spike 6 dev (looked at in R2/R3). All six are spike 7 dev from now on, per user decision 6',
  };
  return { registry: out, line };
}

function ignored(rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main(argv: string[]): void {
  const from = argOf(argv, '--from');
  if (!from) throw new Error('give --from <spike 6 spikes/analysis/recordings>');
  const commit = commitArg(argv);
  const head = git(['rev-parse', 'HEAD']);
  if (!commit || head === null || !head.startsWith(commit.toLowerCase())) throw new Error('the commit (--commit / BAND_SHEETS_COMMIT) must be HEAD (in a worktree pass GIT_DIR / GIT_WORK_TREE)');
  const spike6 = readJson(join(from, 'bas-ids.local.json'), (j) => j.recordings as Registry);
  const plan = reclassifyPlan(spike6, readRegistry(), readText(LOG), head, new Date().toISOString());
  if ('refuse' in plan) throw new Error(plan.refuse);
  const rec = join(ROOT, 'recordings');
  const pairs = SPIKE6_IDS.flatMap(takeFiles).map((f) => [join(from, f), join(rec, f), `recordings/${f}`] as const);
  for (const [src, dst, rel] of pairs) {
    if (!existsSync(src)) throw new Error(`missing in spike 6: ${rel}`);
    if (existsSync(dst)) throw new Error(`already exists, not overwritten: ${rel}`);
    if (!ignored(rel)) throw new Error(`not gitignored: ${rel}: refusing to copy`);
  }
  if (!ignored('recordings/chd-ids.local.json') || !ignored('out/results/heldout-log.jsonl')) throw new Error('registry or log path is not gitignored: refusing');
  for (const [src, dst] of pairs) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (statSync(src).size !== statSync(dst).size) throw new Error('copy size mismatch');
  }
  writeFileSync(IDS, JSON.stringify({ version: 1, recordings: plan.registry }, null, 1) + '\n', 'utf8');
  appendLog(plan.line);
  console.log(`copied ${pairs.length} files (${SPIKE6_IDS.length} takes), registered ${SPIKE6_IDS.length} dev ids (${SPIKE6_HELD_OUT.length} were spike 6 hold-out), 1 reclassify line logged`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
