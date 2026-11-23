/**
 * Spike 8 T7b / T7c: the candidates-only E1 (`d2.output: 'candidate'`, docs/audio-spike8-g1.md §1-§3), tuned on the TUNING
 * split (one round, five θ_c) and then dev look 's8-dev-2'. The names, segments and `/X` are the baseline's by construction;
 * only `chordCandidates` of maj / min / dim segments grows (d2.ts addedCandidates). From spikes/analysis, in the devcontainer
 * (in this worktree git needs -e GIT_DIR=... -e GIT_WORK_TREE=... on docker exec):
 *
 *   npx tsx ts/chords2/eval/s8dev2.ts tune run [--only SUBSTR,..] [--limit N] [--jobs N]   TUNING only (433 files; --only / --limit = smoke)
 *   npx tsx ts/chords2/eval/s8dev2.ts tune report [--dir tune|tune-smoke]               the grid against the selection rule (§3)
 *   npx tsx ts/chords2/eval/s8dev2.ts selftest --commit SHA [--jobs N]   the exact look path over ALL tuning files (not a look)
 *   npx tsx ts/chords2/eval/s8dev2.ts check-inputs                       the dev material exists (names / files only)
 *   npx tsx ts/chords2/eval/s8dev2.ts look --commit SHA [--jobs N]       look 's8-dev-2' (once)
 *   npx tsx ts/chords2/eval/s8dev2.ts report --dir look|selftest         the tables again from the saved per-file results
 *   npx tsx ts/chords2/eval/s8dev2.ts timing                             5 minutes of tuning audio (Node)
 *
 * Rows on one prepared signal (prepareInput): `base` = chords2 V0 + appBassConfig() marks (decision 7, the line, same run) and
 * `E1c` = the candidates-only config (config.ts T7C_E1_CANDIDATE_THETA; the look refuses while it is null) through the same
 * marks. Rows, saving and the per-file scores are s8dev1's (runFile, scoreFile); this file adds per truth run (editCounts'
 * unit, `onRun`) the candidate-fixes-it bit, the name check, and the candidate record columns. Held-out is never listed
 * (s8dev1 / guard.ts: recipe split and the truth's own flags are checked before a file is opened). stdout: aggregates only.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTruthSlash, noteToPc, type ScoreBeat } from '../../bass/score';
import { bassConfigHash } from '../../bass/config';
import { argOf, at, json } from '../../bass/evalCommon';
import { decodeWav } from '../../browser/wav';
import { toMono } from '../../dsp/core/resample';
import { appBassConfig, chords2ConfigHash, resolveChords2Config, T7C_E1_CANDIDATE_THETA, type Chords2Config } from '../config';
import { f1ConfigHash } from '../front/config';
import { f1, f3, table } from './baseline';
import { segmentBootstrap, sumRatio, type PairedUnit } from './bootstrap';
import { beginLook, commitArg, readRegistry, requireCommittedDryRun, ROOT } from './guard';
import { prepareInput } from './input';
import { devTakes } from './r2';
import { checkedSplit, checkInputs, devSynItems, filesDir, fmtLines, hand, has, inGroup, LINE_HEAD, paired, readRecs, runFile, S, scoreFile, timing, tuneItems, type Cfg, type FileRec, type FileRows, type GateLine } from './s8dev1';
import { editCounts, shownAddedCandidates, truthQuality, type EvalChord, type Interval } from './score';
import { loadTruth, recItems, runJobs, type Item } from './t8';

const OUT = join(ROOT, 'out', 'chords2-s8dev2');
const SELF = fileURLToPath(import.meta.url);
export const LOOK = 's8-dev-2' as const;
export const TASK = 'T7c';
export const ROW = 'E1c';

/** G1 §3: the single tuning round's θ_c (thetaLow stays T5's .3, F1's values stay). */
export const THETA_GRID = [0.25, 0.35, 0.5, 0.65, 0.8] as const;
export const candConfig = (theta: number, thetaLow = 0.3): Chords2Config => resolveChords2Config({ d2: { range: 'E1', theta, thetaLow, output: 'candidate' } });
const thetaKey = (theta: number) => `th${theta}`;
export const tuneGrid = (): Cfg[] => THETA_GRID.map((t) => ({ key: thetaKey(t), cfg: candConfig(t) }));
/** The look's row: the θ_c the tuning round chose (config.ts); refuses while none was chosen. */
export function lookCfgs(theta: number | null = T7C_E1_CANDIDATE_THETA): Cfg[] {
  if (theta === null) throw new Error('config.ts T7C_E1_CANDIDATE_THETA is null: run the tuning round (tune run / tune report), set the value and commit it first');
  if (!(THETA_GRID as readonly number[]).includes(theta)) throw new Error(`T7C_E1_CANDIDATE_THETA ${theta} is not a value of the tuning grid ${THETA_GRID.join(' / ')}`);
  return [{ key: ROW, cfg: candConfig(theta) }];
}

/* ------------------------------------------------------------ pure: name check, truth runs, candidate record */

/** Chords of `b` whose time, root, quality or /X differ from `a`'s (a length difference counts its extra chords). 0 = the names are the baseline's. */
export function nameDiff(a: readonly EvalChord[], b: readonly EvalChord[]): number {
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x.start !== y.start || x.end !== y.end || x.root !== y.root || x.quality !== y.quality || (x.bass ?? null) !== (y.bass ?? null)) d++;
  }
  return d;
}

/** editCounts' truth runs (vocabulary 全) in order: beats, the candidate-fixes-it bit, the name-edit bit. */
export interface RunBits {
  beats: number[];
  fix: number[];
  nameEdit: number[];
}
export function runBits(truth: readonly EvalChord[], result: readonly EvalChord[], beats: readonly ScoreBeat[]): RunBits {
  const r: RunBits = { beats: [], fix: [], nameEdit: [] };
  editCounts(truth, result, beats, 'full', { onRun: (x) => { r.beats.push(x.beats); r.fix.push(x.fixable ? 1 : 0); r.nameEdit.push(x.nameEdit ? 1 : 0); } });
  return r;
}

/** One paired truth run: the row's candidate-fixes-it bit minus the base's (names are the same, so this is the whole difference), and its beats. */
export interface RunUnit {
  d: number;
  beats: number;
}
/** Hand edits / 100 beats, row minus base (ratio of sums): −100 x sum(d) / sum(beats). */
export const handDiffStat = (us: readonly RunUnit[]): number | null => {
  const b = us.reduce((a, u) => a + u.beats, 0);
  return b ? (-100 * us.reduce((a, u) => a + u.d, 0)) / b : null;
};

export type State = 'PASS' | 'FAIL' | 'USER';
/** G1 §2 decisive line: the interval's top <= line = PASS, its bottom > line = FAIL, else the user decides. */
export const stateOf = (ci: Interval | null, line = -1.5): State | null => (!ci ? null : ci.hi <= line + 1e-9 ? 'PASS' : ci.lo > line ? 'FAIL' : 'USER');
/** Both groups must pass; either one FAIL fails; a missing group is not decided (null). */
export function combineStates(xs: readonly (State | null)[]): State | null {
  if (!xs.length || xs.some((x) => x === null)) return null;
  return xs.includes('FAIL') ? 'FAIL' : xs.every((x) => x === 'PASS') ? 'PASS' : 'USER';
}

export interface CandStat {
  /** result segments that show an added-tone candidate */
  segs: number;
  /** ...whose truth at the segment's middle has the same root and one of those qualities */
  hit: number;
  /** ...whose truth root at the middle differs */
  wrongRoot: number;
  /** ...with no (scorable) truth chord at the middle */
  unscored: number;
  /** per candidate quality: segments showing it / of those, the truth at the middle is that quality on the same root */
  byQ: Record<string, { n: number; hit: number }>;
}
export function candStat(truth: readonly EvalChord[], result: readonly EvalChord[]): CandStat {
  const tt = (normalizeTruthSlash(truth) as EvalChord[]).filter((c) => c.root !== null && c.root !== undefined && !['', 'N'].includes(String(c.root).trim()));
  const s: CandStat = { segs: 0, hit: 0, wrongRoot: 0, unscored: 0, byQ: {} };
  for (const rc of result) {
    const cands = shownAddedCandidates(rc);
    if (!cands.length) continue;
    s.segs++;
    const tc = at(tt, (rc.start + rc.end) / 2);
    const tq = tc ? truthQuality(tc, 'full') : null;
    if (!tc) {
      s.unscored++;
      continue;
    }
    const sameRoot = noteToPc(tc.root) === noteToPc(rc.root);
    if (!sameRoot) s.wrongRoot++;
    else if (cands.some((c) => c.quality === tq)) s.hit++;
    for (const c of cands) {
      const b = (s.byQ[c.quality] ??= { n: 0, hit: 0 });
      b.n++;
      if (sameRoot && c.quality === tq) b.hit++;
    }
  }
  return s;
}

/* ------------------------------------------------------------ one file, saved */

export interface FileRec2 extends FileRec {
  /** the truth runs' beats (row-independent) and, per row, the candidate-fixes-it / name-edit bits */
  runBeats: number[];
  runs: Record<string, { fix: number[]; nameEdit: number[] }>;
  /** per row: chords whose names differ from the base row's (must be 0) */
  nameDiffs: Record<string, number>;
  cand: Record<string, CandStat>;
}

export function scoreFile2(it: Item, t: { chords: EvalChord[]; beats: ScoreBeat[] }, r: FileRows): FileRec2 {
  const rec = scoreFile(it, t, r);
  const base = runBits(t.chords, r.rows.base, t.beats);
  const runs: FileRec2['runs'] = {};
  const nameDiffs: Record<string, number> = {};
  const cand: Record<string, CandStat> = {};
  for (const [row, res] of Object.entries(r.rows)) {
    const b = runBits(t.chords, res, t.beats);
    if (b.beats.join() !== base.beats.join()) throw new Error(`${it.name}: row ${row} has other truth runs than the base (the runs depend on the truth only)`);
    runs[row] = { fix: b.fix, nameEdit: b.nameEdit };
    nameDiffs[row] = nameDiff(r.rows.base, res);
    cand[row] = candStat(t.chords, res);
  }
  return { ...rec, runBeats: base.beats, runs, nameDiffs, cand };
}

interface Job {
  mode: 'tune' | 'look' | 'selftest';
}
const jobCfgs = (j: Job): Cfg[] => (j.mode === 'tune' ? tuneGrid() : lookCfgs());

/** One worker (runJobs spawns `<this file> look-worker --list <dir>/look-list-k.json`; the job is <dir>/job.json). */
function worker(argv: string[]): void {
  const list = argOf(argv, '--list')!;
  const dir = resolve(list, '..');
  const job = json<Job>(join(dir, 'job.json'));
  const out = filesDir(dir);
  mkdirSync(out, { recursive: true });
  const want = job.mode === 'look' ? 'dev' : 'tuning';
  for (const it of json<Item[]>(list)) {
    const p = join(out, `${it.name}.json`);
    if (existsSync(p)) continue;
    const t = loadTruth(it, checkedSplit(it, want));
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    const r = runFile(prepareInput(toMono(w.channels), w.sampleRate, true).y, jobCfgs(job), false);
    writeFileSync(p, JSON.stringify(scoreFile2(it, t, r)));
  }
}

/**
 * An empty results folder for a look / selftest: `worker` skips a file whose result exists, so a re-run (after a harness
 * fix, or a crash) would otherwise read the first run's stale files. beginLook has logged the start before this is called.
 */
export function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runAll(items: Item[], dir: string, job: Job, jobs: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  await runJobs(items, jobs, SELF, dir);
}
const readRecs2 = (dir: string): FileRec2[] => readRecs(dir) as FileRec2[];

/* ------------------------------------------------------------ aggregation (from the saved files only) */

/** The row's and the base's truth runs of a group, paired by (file, run index). */
export const runPairs = (fs: readonly FileRec2[], row: string, g: string): RunUnit[] =>
  inGroup(fs, g).flatMap((f) => f.runBeats.map((beats, i) => ({ d: f.runs[row].fix[i] - f.runs.base.fix[i], beats })));
const rowsOf = (fs: readonly FileRec2[]): string[] => Object.keys(fs[0]?.scores ?? {}).filter((r) => r !== 'base');
const candPer100 = (fs: readonly FileRec[], row: string, g: string): number | null => S(fs, row, 'full', g).added.addedCandidatePer100;
const diff = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : x - y);

/** Total of the per-file name differences of a row (the build check). */
export const nameDiffTotal = (fs: readonly FileRec2[], row: string): number => fs.reduce((a, f) => a + (f.nameDiffs[row] ?? 0), 0);

/** The 守り line "names identical to the baseline" (a build check: nonzero = harness-fix, the result is unusable). */
const nameLine = (fs: readonly FileRec2[], row: string): GateLine => {
  const v = nameDiffTotal(fs, row);
  return { kind: '守り', line: '名前・区間・/X が基準と同じ（作りの確かめ。違う和音の数）', value: v, op: '<=', target: 0, ci: null, pass: v === 0 };
};

export interface RowLines {
  decisive: GateLine[];
  state: State | null;
  guards: GateLine[];
}

/**
 * G1 §2 for `row` against `base` (same run): the decisive line on REC and SYN (hand edits / 100 beats, 全, shown-candidate
 * fixes excluded; per-truth-run bootstrap, ratio of sums) with the three states, and the guards. `rec` / `syn` / `push` /
 * `noise`: the groups the lines read (look: REC, SYN, Lpool + LR, REC + SYN; tuning: none, SYN, Lpool + LR, ALL).
 */
export function rowLines(fs: readonly FileRec2[], row: string, o: { boot: boolean; decisive: string[]; push: string[]; noise: string[]; dec9: string[] }): RowLines {
  const decisive: GateLine[] = [];
  const states: (State | null)[] = [];
  for (const g of o.decisive) {
    if (!has(fs, g)) continue;
    const us = runPairs(fs, row, g);
    const value = handDiffStat(us);
    const exact = diff(hand(fs, row, g), hand(fs, 'base', g));
    // with identical names the per-run difference IS the editCounts difference; otherwise the name check reports the harness-fix
    if (nameDiffTotal(fs, row) === 0 && value !== null && exact !== null && Math.abs(value - exact) > 1e-9) throw new Error(`${g}: the per-run difference ${value} is not the editCounts difference ${exact}`);
    const ci = o.boot ? segmentBootstrap(us, handDiffStat) : null;
    const state = ci ? stateOf(ci) : null;
    states.push(state);
    decisive.push({ kind: '決め手', line: `手で直す数 / 100 拍 全 − 基準（${g}、候補で直せる分を除く。区間 = 続きごと）`, value, note: `${f1(hand(fs, row, g))} − 基準 ${f1(hand(fs, 'base', g))}`, op: '<=', target: -1.5, ci, pass: ci ? state === 'PASS' : null, user: state === 'USER', crosses: state === 'USER' });
  }
  const guards: GateLine[] = [nameLine(fs, row)];
  for (const g of o.dec9) {
    if (!has(fs, g)) continue;
    const us: PairedUnit[] = paired(fs, row, 'base', 'full:asTriadHidden', g);
    const value = sumRatio(us);
    const ci = o.boot ? segmentBootstrap(us, sumRatio) : null;
    const a = us.reduce((x, u) => x + u.a.hit, 0);
    const b = us.reduce((x, u) => x + u.b.hit, 0);
    guards.push({ kind: '守り', line: `決定 9 の読み直し: 7th を 3 和音に読み、正しい 7th が見せる候補に無い点 ÷ 基準（${g}、区間の上 < 1.0。比 ≤ .5 は記録）`, value, note: `${a} / ${b} 点`, op: '<=', target: 1, ci, pass: ci ? ci.hi < 1 : value !== null && value < 1 });
  }
  for (const g of o.push) {
    if (!has(fs, g)) continue;
    const us = runPairs(fs, row, g);
    guards.push({ kind: '守り', line: `候補の押し出し: 手で直す数 / 100 拍 − 基準（${g}）`, value: handDiffStat(us), ci: o.boot ? segmentBootstrap(us, handDiffStat) : null, op: '<=', target: 0.5, pass: (handDiffStat(us) ?? Infinity) <= 0.5 + 1e-9 });
  }
  for (const g of o.noise) {
    if (!has(fs, g)) continue;
    const v = diff(candPer100(fs, row, g), candPer100(fs, 'base', g));
    guards.push({ kind: '守り', line: `候補のうるささ: 候補を出した拍 / 100 拍 − 基準（${g}）`, value: v, note: `${f1(candPer100(fs, row, g))} − 基準 ${f1(candPer100(fs, 'base', g))}`, op: '<=', target: 10, ci: null, pass: v === null ? null : v <= 10 + 1e-9 });
  }
  return { decisive, state: combineStates(states), guards };
}

/** What the decisive line and the guards say together (G1 §2 / decision 17). */
export function verdict(l: RowLines, points: (number | null)[]): string {
  const guards = l.guards.every((g) => g.pass === true);
  if (l.guards.some((g) => g.line.startsWith('名前') && g.pass !== true)) return 'harness-fix（名前が基準と同じでない: 結果は使わない）';
  if (l.state === 'FAIL') return '止める（決め手 FAIL。ホールドアウトは開けずに次のスパイクへ）';
  if (l.state === 'PASS') return guards ? '決め手 PASS・守り全部 PASS（採る側。E2 は s8-dev-3 で）' : '止める（決め手 PASS だが守りに FAIL あり。決定 9・17）';
  if (l.state === 'USER') return guards && points.every((p) => p !== null && p <= -1.5 + 1e-9) ? '区間が −1.5 をまたぐ。点の値は両方 −1.5 以下・守り全部 PASS（採る側）' : '区間が −1.5 をまたぐ。点の値が −1.5 以下でない、または守りに FAIL あり（止める）';
  return '判定できない（グループが足りない）';
}
/** the budget (time +3 s, memory +50 MB) is not in the lines: `timing` checks it separately */
export const BUDGET_NOTE = '予算（時間 +3 秒・メモリ +50 MB）はこの表に入れていない: `timing` で別に確かめる。';

/* ------------------------------------------------------------ tuning: the selection rule (§3) */

const TUNE_OPTS = { boot: false, decisive: ['SYN'], push: ['Lpool', 'LR'], noise: ['ALL'], dec9: [] as string[] };

/** §3: 1. fewest failed guards (noise ALL <= +10, push-out Lpool / LR <= +0.5); 2. smaller hand edits − base on SYN (rounded to .1); 3. larger θ_c. */
export function rankTheta(fs: readonly FileRec2[], cfgs: readonly Cfg[]) {
  const hb = hand(fs, 'base', 'SYN');
  return cfgs
    .map((c) => {
      const l = rowLines(fs, c.key, TUNE_OPTS);
      const h = diff(hand(fs, c.key, 'SYN'), hb);
      return { key: c.key, theta: c.cfg.d2!.theta, guardFails: l.guards.filter((g) => g.line.startsWith('名前') ? false : g.pass === false).length, nameDiff: nameDiffTotal(fs, c.key), hand: h === null ? Infinity : Math.round(h * 10) / 10, handRaw: h ?? Infinity, lines: l };
    })
    .sort((a, b) => a.guardFails - b.guardFails || a.hand - b.hand || b.theta - a.theta);
}

const tuneDirOf = (argv: string[]) => join(OUT, argOf(argv, '--dir') ?? 'tune');

async function tuneRun(argv: string[]): Promise<void> {
  let items = tuneItems();
  const only = argOf(argv, '--only');
  const limit = argOf(argv, '--limit');
  if (only) items = items.filter((i) => only.split(',').some((s) => i.name.includes(s)));
  if (limit) items = items.slice(0, Number(limit));
  const dir = only || limit ? join(OUT, 'tune-smoke') : join(OUT, 'tune');
  await runAll(items, dir, { mode: 'tune' }, Number(argOf(argv, '--jobs') ?? '6'));
  console.log(`tune: ${readRecs2(dir).length} files in ${dir.replace(ROOT + '/', '')}`);
}

function tuneReport(argv: string[]): void {
  const dir = tuneDirOf(argv);
  const fs = readRecs2(dir);
  const cfgs = tuneGrid();
  const rows = ['base', ...cfgs.map((c) => c.key)];
  const L = [`# T7c tuning (θ_c grid, one round): ${fs.length} files (SYN ${inGroup(fs, 'SYN').length}, Lpool ${inGroup(fs, 'Lpool').length}, LR ${inGroup(fs, 'LR').length})`, `hashes: base ${chords2ConfigHash()}, ${cfgs.map((c) => `${c.key} ${chords2ConfigHash(c.cfg)}`).join(', ')}`];
  L.push(table('調整用（手数 = 手で直す数 / 100 拍 全、候補 = 候補を出した拍 / 100 拍 全）', ['手数 SYN', '手数 Lpool', '手数 LR', '候補 SYN', '候補 ALL', 'E1 当たり（出した区間 SYN: 当たり / 区間）', '名前の違い'], rows.map((r) => {
    const n = fs.filter((f) => f.groups.includes('SYN')).reduce((a, f) => a + (f.cand[r]?.segs ?? 0), 0);
    const h = fs.filter((f) => f.groups.includes('SYN')).reduce((a, f) => a + (f.cand[r]?.hit ?? 0), 0);
    return [r, [f1(hand(fs, r, 'SYN')), f1(hand(fs, r, 'Lpool')), f1(hand(fs, r, 'LR')), f1(candPer100(fs, r, 'SYN')), f1(candPer100(fs, r, 'ALL')), `${h} / ${n}`, r === 'base' ? '-' : String(nameDiffTotal(fs, r))]];
  })));
  const ranked = rankTheta(fs, cfgs);
  L.push('\n## 選び方（§3）の順: 守りの FAIL の少ない順 → 手数 − 基準（SYN、0.1 丸め）の小さい順 → θ_c の大きい順');
  for (const r of ranked) L.push(`- ${r.key}: 守りの FAIL ${r.guardFails}, 手数 − 基準 ${r.hand}, 名前の違い ${r.nameDiff}`);
  const top = ranked[0];
  if (top) {
    L.push(`\n## 1 位 ${top.key} の線\n${LINE_HEAD}\n${fmtLines([...top.lines.decisive, ...top.lines.guards])}`);
    if (top.handRaw > -0.5) L.push('\n**1 位の手数の差が −0.5 より大きい（決め手から遠い）: 見る時点を使う前にメインに返す。天井 録音 2.50・SYN 3.34 / 100 拍（g1 §2）と並べて見せる。**');
    if (top.nameDiff) L.push('\n**名前が基準と同じでない: 作りの誤り（harness-fix）。**');
  }
  const text = L.join('\n');
  console.log(text);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${dir.split('/').pop()}-report.md`), text);
}

/* ------------------------------------------------------------ the look report */

const LOOK_OPTS = { boot: true, decisive: ['REC', 'SYN'], push: ['Lpool', 'LR'], noise: ['REC', 'SYN'], dec9: ['REC'] };
const SYN_GROUPS = ['SYN', 'Lpool', 'LR'];
const REC_GROUPS = ['a-f', 'g-j', 'REC'];

const sumStat = (fs: readonly FileRec2[], row: string, g: string): CandStat & { beats: number } => {
  const t: CandStat & { beats: number } = { segs: 0, hit: 0, wrongRoot: 0, unscored: 0, byQ: {}, beats: 0 };
  for (const f of inGroup(fs, g)) {
    const c = f.cand[row];
    t.segs += c.segs; t.hit += c.hit; t.wrongRoot += c.wrongRoot; t.unscored += c.unscored;
    t.beats += f.scores[row].eFull.nBeats;
    for (const [q, b] of Object.entries(c.byQ)) { const x = (t.byQ[q] ??= { n: 0, hit: 0 }); x.n += b.n; x.hit += b.hit; }
  }
  return t;
};

export function lookReport(title: string, fs: readonly FileRec2[]): string {
  const rows = rowsOf(fs);
  const out: string[] = [`# ${title}: ${fs.length} files`];
  const bad = rows.filter((r) => nameDiffTotal(fs, r) > 0);
  // the names are checked FIRST: a result with other names than the base is unusable, so nothing else is printed or saved
  if (bad.length) return `${out[0]}\n**名前・区間・/X が基準と同じでない行: ${bad.map((r) => `${r} ${nameDiffTotal(fs, r)} 和音`).join(', ')}。作りの誤り（harness-fix）: 表は出さない。**`;
  out.push(`hashes: all-off ${chords2ConfigHash()}, base = appBassConfig ${bassConfigHash(appBassConfig())}, ${rows.map((r) => `${r} ${chords2ConfigHash(candConfigOfRow(r))}`).join(', ')}, F1 ${f1ConfigHash(candConfig(0.5).f1)}`);
  const all = ['base', ...rows];
  for (const [kind, groups] of [['syn', SYN_GROUPS], ['rec', REC_GROUPS]] as const) {
    const sub = fs.filter((f) => f.kind === kind);
    if (!sub.length) continue;
    const gs = groups.filter((g) => has(sub, g));
    out.push(`\n## ${kind === 'syn' ? '合成' : '録音'}: files per group ${gs.map((g) => `${g} ${inGroup(sub, g).length}`).join(', ')}`);
    const per = (f: (r: string, g: string) => string): [string, string[]][] => all.map((r) => [r, gs.map((g) => f(r, g))]);
    out.push(table('手で直す数 / 100 拍 全（候補で直せる分を除く）', gs, per((r, g) => f1(hand(sub, r, g)))));
    out.push(table('候補を出した拍 / 100 拍（全）', gs, per((r, g) => f1(candPer100(sub, r, g)))));
    out.push(table('名前 落（基準と同じはず）', gs, per((r, g) => f3(S(sub, r, 'down', g).name.rate))));
    out.push(table('3 和音の点に候補を出した割合（全）', gs, per((r, g) => f3(rateTriadCand(sub, r, g)))));
    for (const r of rows) {
      const g0 = kind === 'syn' ? 'SYN' : 'REC';
      const t = sumStat(sub, r, g0);
      out.push(`- ${r} ${g0} の記録: 足す音の候補を出した区間 ${t.segs}、そのうち正解がその種類 ${t.hit}（${f3(t.segs ? t.hit / t.segs : null)}）、ルートが違う区間 ${t.wrongRoot}（${f1(t.beats ? (t.wrongRoot / t.beats) * 100 : null)} / 100 拍）、正解なし ${t.unscored}`);
      out.push(table(`種類ごと ${g0}（出した区間: 当たり。20 区間未満は記録だけ）`, Object.keys(t.byQ).sort(), [[r, Object.keys(t.byQ).sort().map((q) => `${t.byQ[q].n}: ${t.byQ[q].hit}`)]]));
    }
    if (kind === 'rec') out.push(`- a-f の 3 和音の点に出した割合: ${rows.map((r) => `${r} ${f3(rateTriadCand(fs, r, 'a-f'))}（基準 ${f3(rateTriadCand(fs, 'base', 'a-f'))}）`).join(', ')}`);
  }
  for (const r of rows) {
    const l = rowLines(fs, r, LOOK_OPTS);
    const pts = l.decisive.map((d) => d.value);
    out.push(`\n## G1 §2 の線: ${r}（基準 = appBassConfig()、同じ実行。区間 = 続きごとのブートストラップ 2000 回、和の比）\n${LINE_HEAD}\n${fmtLines([...l.decisive, ...l.guards])}`);
    out.push(`\n決め手: ${l.state ?? '-'} → ${verdict(l, pts)}（${BUDGET_NOTE}）`);
  }
  out.push('\n予算: 時間・メモリは `timing` の出力と T4 のメモリの数（G1 §2）。');
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const msKeys = [...new Set(fs.flatMap((f) => Object.keys(f.ms)))];
  out.push(`stage time per file, median ms: ${msKeys.map((k) => `${k} ${med(fs.map((f) => f.ms[k] ?? 0)).toFixed(1)}`).join(', ')}`);
  return out.join('\n');
}
/** the rate of 3 和音 points that carry an added-tone candidate (units' a side = the row) */
const rateTriadCand = (fs: readonly FileRec2[], row: string, g: string): number | null => {
  const us = paired(fs, row, 'base', 'full:triadCandidate', g);
  const n = us.reduce((a, u) => a + u.a.n, 0);
  return n ? us.reduce((a, u) => a + u.a.hit, 0) / n : null;
};
/** the config of a saved row: the look row's, or a tuning row `th<θ>` */
const candConfigOfRow = (row: string): Chords2Config => (row === ROW ? lookCfgs()[0].cfg : candConfig(Number(row.replace('th', ''))));

/* ------------------------------------------------------------ look, dry run */

const lookDir = (which: string) => join(OUT, which);

async function selftest(argv: string[]): Promise<void> {
  requireCommittedDryRun(argv);
  const dir = freshDir(lookDir('selftest'));
  await runAll(tuneItems(), dir, { mode: 'selftest' }, Number(argOf(argv, '--jobs') ?? '6'));
  const fs = readRecs2(dir);
  const text = lookReport('selftest (tuning, the look path; not a look)', fs);
  console.log(text);
  writeFileSync(join(OUT, 'selftest-report.md'), text);
  if (nameDiffTotal(fs, ROW) > 0) process.exit(3);
}

async function look(argv: string[]): Promise<void> {
  const cfg = lookCfgs()[0].cfg;
  const takes = devTakes(readRegistry());
  const syn = devSynItems();
  const { finish, line } = beginLook(
    {
      look: LOOK,
      task: TASK,
      reason: `T7c: dev look 2 - the candidates-only E1 (chords2 ${chords2ConfigHash(cfg)}, theta_c from the tuning split) through the appBassConfig() marks, against the base row appBassConfig() in the same run, on the dev synthetic (c2-d incl. 7th voicings, B0-B3 dev, dev L/LR) and the dev recordings a-j; decisive line = hand edits / 100 beats on REC and SYN, three states (docs/audio-spike8-g1.md section 2); no tuning after this`,
      configHashes: [chords2ConfigHash(), chords2ConfigHash(cfg), bassConfigHash(appBassConfig())],
      takes,
      synthetic: syn.map((s) => s.name),
    },
    commitArg(argv),
  );
  console.log(`look-start logged: ${line.look} ${line.task} commit ${line.commit?.slice(0, 7)} takes ${takes.length} synthetic ${syn.length}`);
  const dir = freshDir(lookDir('look')); // after beginLook: the (one) harness-fix re-run recomputes every file
  await runAll([...syn, ...recItems(takes)], dir, { mode: 'look' }, Number(argOf(argv, '--jobs') ?? '6'));
  const fs = readRecs2(dir);
  for (const g of ['REC', 'SYN']) if (!has(fs, g)) throw new Error(`look ${LOOK}: no ${g} files in the results (the decisive line needs both groups)`);
  const text = lookReport(`T7c ${LOOK}`, fs); // names checked first: a name difference prints / saves only its count
  writeFileSync(join(OUT, 'look-report.md'), text);
  console.log(text);
  if (nameDiffTotal(fs, ROW) > 0) {
    console.error('\nnames differ from the base row: harness-fix (guard.ts --log-harness-fix); look-done NOT logged');
    process.exit(3);
  }
  finish();
  console.log('\nlook-done logged');
}

const reportAgain = (argv: string[]): void => console.log(lookReport(`T7c ${argOf(argv, '--dir') ?? 'look'} (from out/)`, readRecs2(lookDir(argOf(argv, '--dir') ?? 'look'))));

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const argv = [sub, ...rest].filter((x) => x !== undefined);
  const fail = (e: unknown) => {
    console.error(e);
    process.exit(1);
  };
  if (cmd === 'tune' && sub === 'run') tuneRun(rest).catch(fail);
  else if (cmd === 'tune' && sub === 'report') tuneReport(rest);
  else if (cmd === 'look-worker') worker(argv);
  else if (cmd === 'selftest') selftest(argv).catch(fail);
  else if (cmd === 'check-inputs') checkInputs();
  else if (cmd === 'look') look(argv).catch(fail);
  else if (cmd === 'report') reportAgain(argv);
  else if (cmd === 'timing') timing(lookCfgs(T7C_E1_CANDIDATE_THETA ?? 0.5));
  else {
    console.error('usage: s8dev2.ts tune run|report | selftest --commit SHA | check-inputs | look --commit SHA | report --dir look|selftest | timing');
    process.exit(2);
  }
}
