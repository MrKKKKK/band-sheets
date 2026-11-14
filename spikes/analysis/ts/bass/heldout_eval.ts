/**
 * Spike 6 T13: the ONE held-out look (look point 3), step 2 = scoring (docs/audio-spike6-plan.md section 7 row T13,
 * docs/audio-spike6-r2.md "T13 への申し送り"). Run from spikes/analysis (devcontainer) AFTER
 * py/tools/bass_heldout_fit.py --final-heldout logged the look-3 line and wrote the fitted held-out truths:
 *
 *   BAND_SHEETS_COMMIT=SHA npx tsx ts/bass/heldout_eval.ts --final-heldout
 *       (in a worktree also GIT_DIR / GIT_WORK_TREE, so git can check HEAD and a clean tree)
 *   npx tsx ts/bass/heldout_eval.ts --selftest
 *       pipeline check before the real run: the DEV recordings (fitted truth from out/bass-rec/selftest-fit, written by
 *       bass_heldout_fit.py --selftest; must reproduce R2 raw / R3 normalized) and the synthetic TUNING split (must
 *       reproduce T10's tuning rows). Held-out files are never opened; nothing is logged here.
 *
 * Final: refused unless the log has exactly one bass look-3 line (task T13, held-out), its commit equals the given
 * commit and git's clean HEAD, its config hashes and input gains are the frozen ones below, and the run has not been
 * scored already (out/bass-heldout/final/done.json). Then: recordings e/f (the line's takes; each must be held out in
 * both registries and in its truth) raw and loudness-normalized (whole-file RMS to the synthetic TUNING median, the
 * same rule as R3; never from e/f), scored against the fitted and the nominal truth; then the synthetic held-out split
 * (timbre C; count must equal the line's). Both configs (T8-equivalent, G2 default) on the truth segments (ceiling) and
 * on the frozen v1a segments, the same metrics as R2 / R3 (t9_sweep.ts run) and T8 / T10, plus v1a's no-chord points.
 *   ... --log-harness-fix "<reason>"   (once, after the look line and before it is scored; HEAD = BAND_SHEETS_COMMIT =
 *       a clean later commit that touches HARNESS_FILES only) appends a 'harness-fix' line linked to the look; the final
 *       run then accepts that commit as HEAD. Used once in T13 (see HARNESS_FILES).
 * Output: aggregates only (no chord or bass names). No tuning: config values are not changed here.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeWithBass } from './analyze';
import { bassConfigHash, enabledBassConfig, resolveBassConfig } from './config';
import { json, parseJsonl } from './evalCommon';
import { heldOutRefusal, isHeld, selectVariants, type GuardSources, type GuardVariant } from './heldout_guard';
import { lowCqt } from './lowCqt';
import { diagnose, INPUT_GAIN, loadMono, pipelineCheck, printRecordings, readRecTruth, recordingItems, tuningMedianRmsDb, type ConfigSet } from './rec_eval';
import type { ScoreBeat, ScoreChord } from './score';
import { run, strip, type Item } from './t9_sweep';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = join(ROOT, 'out', 'results', 'heldout-log.jsonl');
const SYN = join(ROOT, 'out', 'bass');
const DONE = join(ROOT, 'out', 'bass-heldout', 'final', 'done.json');

/** The pair R2 / R3 scored: T8-equivalent (bass on, weakMinConfidence 0, B-3 / re-decision off) and the G2 default. */
export const FROZEN_SETS: Record<string, unknown> = { T8eq: { slash: { weakMinConfidence: 0 }, cliche: { split: false, redecideRoot: false } }, G2: {} };
export const FROZEN_HASHES = ['3f11c4c58c5a', 'e5b432a11e3c'];
export const INPUT_GAINS = ['raw', INPUT_GAIN];

interface Look3 {
  kind?: string;
  fixes?: string;
  input?: string;
  lookPoint?: number;
  task?: string;
  heldOut?: boolean;
  takes?: string[];
  synthetic?: { split?: string; timbre?: string; files?: number };
  configHashes?: string[];
  commit?: string;
  inputGain?: string[];
}

export interface FinalGuardInput {
  logText: string | null;
  /** BAND_SHEETS_COMMIT / --commit */
  commit: string | undefined;
  /** `git rev-parse --short HEAD` / `git status --porcelain`; null when git failed */
  head: string | null;
  porcelain: string | null;
  /** hashes of FROZEN_SETS as computed now */
  hashes: string[];
  /** the final run was already scored */
  done: boolean;
  /** `git diff --name-only <logged commit> HEAD` (repo-relative); null when git failed or HEAD is the logged commit */
  changed: string[] | null;
}

/**
 * The only files a harness fix after the look may touch (scoring harness and its tests; no analyzer, config or truth
 * code). T13: the first run crashed in the truth-segment (ceiling) path on a flat-spelled truth root before any score
 * was printed; the fix respells truth roots (t9_sweep.ts truthSegments) and adds this path.
 */
export const HARNESS_FILES = ['spikes/analysis/ts/bass/t9_sweep.ts', 'spikes/analysis/ts/bass/t9_sweep.test.ts', 'spikes/analysis/ts/bass/heldout_eval.ts', 'spikes/analysis/ts/bass/heldout_eval.test.ts'];
const parseLog = (text: string | null): Look3[] => parseJsonl<Look3>(text);
const fixLines = (lines: Look3[]) => lines.filter((d) => d.kind === 'harness-fix' && d.input === 'bass' && d.task === 'T13');

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The guard of the final run (pure): the look-3 line, or the reason to refuse. */
export function finalGuard(g: FinalGuardInput): { line: Look3 } | { refuse: string } {
  const all = parseLog(g.logText);
  const lines = all.filter((d) => d.kind === 'look' && d.input === 'bass' && (d.lookPoint === 3 || d.task === 'T13' || d.heldOut === true));
  if (lines.length !== 1) return { refuse: `expected exactly one bass look-3 line, found ${lines.length} (run py/tools/bass_heldout_fit.py --final-heldout first)` };
  const l = lines[0];
  if (l.lookPoint !== 3 || l.task !== 'T13' || l.heldOut !== true || !l.takes?.length || !l.synthetic?.files) return { refuse: 'the look-3 line is not the T13 held-out look: refusing' };
  if (g.done) return { refuse: 'the held-out look was already scored (out/bass-heldout/final/done.json): refusing to run again' };
  if (!g.commit) return { refuse: 'the commit is required: pass --commit or BAND_SHEETS_COMMIT' };
  if (g.head === null || g.porcelain === null) return { refuse: 'git failed (in a worktree pass GIT_DIR / GIT_WORK_TREE): refusing' };
  const fixes = fixLines(all);
  if (g.head === l.commit) {
    if (fixes.length) return { refuse: 'a harness-fix line exists: HEAD must be its commit: refusing' };
  } else {
    if (fixes.length !== 1 || fixes[0].fixes !== l.commit || fixes[0].commit !== g.head) return { refuse: `HEAD ${g.head} is not the logged commit ${l.commit} (nor of one linked harness-fix line): refusing` };
    const bad = harnessOnlyBlock(g.changed);
    if (bad) return { refuse: bad };
  }
  if (g.commit !== g.head) return { refuse: `commit ${g.commit} is not HEAD ${g.head}: refusing` };
  if (g.porcelain !== '') return { refuse: 'working tree must be clean for the held-out run' };
  if (!same(g.hashes, FROZEN_HASHES)) return { refuse: `config hashes ${g.hashes.join(',')} are not the frozen ${FROZEN_HASHES.join(',')}: refusing` };
  if (!same(l.configHashes, FROZEN_HASHES)) return { refuse: 'the logged config hashes are not the frozen pair: refusing' };
  if (!same(l.inputGain, INPUT_GAINS)) return { refuse: `the logged input gains are not ${INPUT_GAINS.join(',')}: refusing` };
  return { line: l };
}

/** Reason the change since the logged commit is more than the harness, or null (pure). */
export function harnessOnlyBlock(changed: string[] | null): string | null {
  if (changed === null) return 'git diff failed: refusing';
  const other = changed.filter((p) => !HARNESS_FILES.includes(p));
  return other.length ? `changes since the logged commit outside the scoring harness (${other.join(', ')}): refusing` : null;
}

/**
 * The one-time harness-fix line (pure): allowed only after the T13 look line, before it was scored, once, with HEAD a
 * clean later commit that changes harness files only. Returns the line to append, or the reason to refuse.
 */
export function harnessFixLine(g: FinalGuardInput, reason: string, time: string): { line: string } | { refuse: string } {
  const all = parseLog(g.logText);
  const looks = all.filter((d) => d.kind === 'look' && d.input === 'bass' && d.lookPoint === 3 && d.task === 'T13' && d.heldOut === true);
  if (looks.length !== 1) return { refuse: `expected exactly one T13 look-3 line, found ${looks.length}` };
  if (g.done) return { refuse: 'already scored: a harness fix is no longer allowed' };
  if (fixLines(all).length) return { refuse: 'a harness-fix line already exists: refusing a second one' };
  if (!reason.trim()) return { refuse: 'a reason is required' };
  if (g.head === null || g.porcelain === null) return { refuse: 'git failed (in a worktree pass GIT_DIR / GIT_WORK_TREE): refusing' };
  if (g.porcelain !== '') return { refuse: 'working tree must be clean' };
  if (g.head === looks[0].commit) return { refuse: 'HEAD is still the logged commit: commit the fix first' };
  if (g.commit !== g.head) return { refuse: `commit ${g.commit ?? '-'} is not HEAD ${g.head}: refusing` };
  const bad = harnessOnlyBlock(g.changed);
  if (bad) return { refuse: bad };
  return { line: JSON.stringify({ time, kind: 'harness-fix', input: 'bass', task: 'T13', lookPoint: 3, fixes: looks[0].commit, commit: g.head, files: g.changed, reason }) };
}

/** Recordings that must be held out (final) or dev (selftest) by every registry (pure; throws otherwise). */
export function checkTakes(takes: readonly string[], src: GuardSources, heldOut: boolean): void {
  for (const id of takes) {
    const r = heldOutRefusal(`${id}.wav`, src);
    const held = r === 'held-out recording: refused';
    if (r && !held) throw new Error(`${id}: ${r}`);
    const inIds = src.ids?.[id]?.heldOut === true;
    const inRec = src.rec?.some((v) => v.name === id && isHeld(v)) ?? false;
    if (held !== heldOut || inIds !== heldOut || inRec !== heldOut) throw new Error(`${id}: not ${heldOut ? 'held out' : 'dev'} in every registry: refusing`);
  }
}

type SynVariant = GuardVariant & { level: string; wav: string; truth: string };

/** Synthetic variants of the held-out split (flags must agree) or the tuning split (pure; throws otherwise). */
export function synthVariants(all: readonly SynVariant[], split: 'heldOut' | 'tuning'): SynVariant[] {
  if (split === 'tuning') {
    const vs = selectVariants(all, ['tuning']);
    for (const v of vs) {
      const r = heldOutRefusal(v.wav, { syn: [...all], rec: null, ids: null });
      if (r) throw new Error(`${v.name}: ${r}`);
    }
    return vs;
  }
  const held = all.filter(isHeld);
  for (const v of held) if (!(v.heldOut === true && v.split === 'heldOut' && v.timbre === 'C')) throw new Error(`${v.name}: held-out flags disagree: refusing`);
  return held;
}


/** Synthetic items (audio opened here, after the caller's guards) + the pipeline check of every set. */
function synthItems(vs: readonly SynVariant[], heldOut: boolean, sets: readonly ConfigSet[]): { items: Item[]; check: Map<string, { chords: number; same: number }> } {
  const v1aCfg = resolveBassConfig();
  const items: Item[] = [];
  const check = new Map<string, { chords: number; same: number }>(sets.map(([n]) => [n, { chords: 0, same: 0 }]));
  for (const v of vs) {
    const t = json<{ beats: ScoreBeat[]; chords: ScoreChord[]; bass: { variant: { heldOut: boolean; split: string; timbre: string } } }>(join(SYN, v.truth));
    const tv = t.bass.variant;
    if (tv.heldOut !== heldOut || (tv.split === 'heldOut') !== heldOut || (tv.timbre === 'C') !== heldOut) throw new Error(`${v.name}: truth flag mismatch: refusing`);
    const y = loadMono(join(SYN, v.wav));
    const v1a = analyzeWithBass({ y: y.slice() }, { bass: v1aCfg }).result;
    const low = lowCqt(y, sets[0][1].lowCqt);
    const v1aBeats = v1a.beats.map((b) => b.t);
    const chords = strip(v1a.chords);
    items.push({ level: v.level, timbre: tv.timbre, low, truth: t.chords, truthBeats: t.beats, v1a: chords, v1aBeats, ceiling: true });
    pipelineCheck(y, low, chords, v1aBeats, sets, check);
  }
  return { items, check };
}

const git = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function guardInput(argv: string[], sets: readonly ConfigSet[]): FinalGuardInput {
  const i = argv.indexOf('--commit');
  const logText = existsSync(LOG) ? readFileSync(LOG, 'utf8') : null;
  const head = git(['rev-parse', '--short', 'HEAD']);
  const logged = parseLog(logText).find((d) => d.kind === 'look' && d.input === 'bass' && d.lookPoint === 3)?.commit;
  const diff = logged && head && head !== logged ? git(['diff', '--name-only', logged, 'HEAD']) : null;
  return {
    logText,
    commit: i >= 0 ? argv[i + 1] : process.env.BAND_SHEETS_COMMIT,
    head,
    porcelain: git(['status', '--porcelain']),
    hashes: sets.map(([, c]) => bassConfigHash(c)),
    done: existsSync(DONE),
    changed: diff === null ? null : diff.split('\n').filter((x) => x),
  };
}

function main(argv: string[]): void {
  const fixAt = argv.indexOf('--log-harness-fix');
  if (fixAt >= 0) {
    const sets: ConfigSet[] = Object.entries(FROZEN_SETS).map(([n, o]) => [n, enabledBassConfig(o)] as const);
    const r = harnessFixLine(guardInput(argv, sets), argv[fixAt + 1] ?? '', new Date().toISOString());
    if ('refuse' in r) throw new Error(r.refuse);
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, r.line + '\n', 'utf8');
    console.log('harness-fix line logged');
    return;
  }
  const final = argv.includes('--final-heldout');
  if (final === argv.includes('--selftest')) throw new Error('give exactly one of --final-heldout / --selftest');
  const sets: ConfigSet[] = Object.entries(FROZEN_SETS).map(([n, o]) => [n, enabledBassConfig(o)] as const);
  const src: GuardSources = {
    syn: json<{ variants: SynVariant[] }>(join(SYN, 'manifest.json')).variants,
    rec: json<{ variants: GuardVariant[] }>(join(ROOT, 'out', 'rec', 'manifest.bass.json')).variants,
    ids: json<{ recordings: Record<string, { heldOut?: boolean }> }>(join(ROOT, 'recordings', 'bas-ids.local.json')).recordings,
  };
  let takes: string[];
  let synFiles: number | null = null;
  if (final) {
    const g = finalGuard(guardInput(argv, sets));
    if ('refuse' in g) throw new Error(g.refuse);
    takes = g.line.takes!;
    synFiles = g.line.synthetic!.files!;
  } else {
    takes = Object.keys(src.ids!)
      .filter((id) => src.ids![id].heldOut === false)
      .sort();
  }
  checkTakes(takes, src, final);
  const vs = synthVariants(src.syn as SynVariant[], final ? 'heldOut' : 'tuning');
  if (synFiles !== null && vs.length !== synFiles) throw new Error(`${vs.length} synthetic held-out variants, the line says ${synFiles}: refusing`);

  const mode = final ? 'final' : 'selftest';
  console.log(`# T13 ${final ? 'held-out look (look point 3)' : 'selftest (dev recordings + synthetic tuning)'}; configs ${sets.map(([n, c]) => `${n} ${bassConfigHash(c)}`).join(', ')}`);
  const fitDir = join(ROOT, 'out', 'bass-rec', final ? 'heldout-fit' : 'selftest-fit');
  const truthOf = (id: string) => ({ fitted: readRecTruth(fitDir, id, final), nominal: readRecTruth(join(ROOT, 'out', 'rec'), id, final) });
  const target = tuningMedianRmsDb();
  for (const gain of INPUT_GAINS) {
    console.log(`\n================ recordings, input ${gain} ================`);
    const r = recordingItems(takes, truthOf, sets, gain === INPUT_GAIN ? target : null);
    printRecordings(`${takes.length} ${final ? 'held-out' : 'dev'} recordings (T13 ${mode}, input ${gain})`, takes, sets, r);
    for (const [n, c] of sets) diagnose(n, c, r.fitted);
  }
  console.log(`\n================ synthetic ${final ? 'held-out (timbre C)' : 'tuning'} ================`);
  const s = synthItems(vs, final, sets);
  console.log(`${s.items.length} synthetic variants`);
  for (const [n, a] of s.check) console.log(`pipeline check ${n}: ${a.same} of ${a.chords} chords identical to the full analyzeWithBass run`);
  for (const [n, c] of sets) run(n, c, s.items, false, false);
  for (const [n, c] of sets.slice(-1)) diagnose(n, c, s.items);
  if (final) {
    mkdirSync(dirname(DONE), { recursive: true });
    writeFileSync(DONE, JSON.stringify({ at: new Date().toISOString(), takes: takes.length, synthetic: vs.length }) + '\n', 'utf8');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
