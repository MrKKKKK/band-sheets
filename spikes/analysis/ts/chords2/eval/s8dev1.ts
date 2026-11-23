/**
 * Spike 8 T7: E1 (the 7th family through D2) tuned on the TUNING split, then dev look 's8-dev-1'
 * (docs/audio-spike8-plan.md §2.2, §3, §5, §7 T7; record docs/audio-spike8-t7.md). From spikes/analysis, in the devcontainer
 * (in this worktree git needs -e GIT_DIR=... -e GIT_WORK_TREE=... on docker exec):
 *
 *   npx tsx ts/chords2/eval/s8dev1.ts tune run [--round 1|2] [--around θ,θ_low,penalty] [--jobs N]   TUNING only
 *   npx tsx ts/chords2/eval/s8dev1.ts tune report [--round 1|2] [--around ...]   the grid against the selection rule
 *   npx tsx ts/chords2/eval/s8dev1.ts selftest --commit SHA [--jobs N]   the exact look path over ALL tuning files (not a look)
 *   npx tsx ts/chords2/eval/s8dev1.ts check-inputs        the dev material exists (names / files only, nothing opened)
 *   npx tsx ts/chords2/eval/s8dev1.ts look --commit SHA [--jobs N]       look 's8-dev-1' (once)
 *   npx tsx ts/chords2/eval/s8dev1.ts report --dir look|selftest          the tables again from the saved per-file results
 *   npx tsx ts/chords2/eval/s8dev1.ts timing              5 minutes of tuning audio (Node)
 *
 * Rows on one prepared signal (prepareInput, RMS -22 dBFS): `base` = chords2 V0 (= v1a) + appBassConfig() marks (decision 7,
 * the line every config is compared with, in the same run); reference rows `v1a` and `bassG2` (spike 6 G2 default, the
 * "G2 既定" of plan §5); a D2 config = chords2 V0 + D2 (range E1) -> the same appBassConfig() marks (pipeline.ts
 * marksOnV2); `E1|D1` = the same with D1 (octaveChroma, decision 4). F1's CQT is computed once per file for the configs
 * (pipeline.ts chords2Inputs: the bass stage gets its lower 5 octaves, identical output, decision 10); the base row
 * computes its own bass CQT (the all-off path, unchanged).
 * Per file the worker saves the rows AND the truth-aligned scores (score.ts scoreChords / editCounts per row and
 * vocabulary, segmentUnits per measure with the truth segment index), so the tables are recomputed from out/ with this
 * file alone. Held-out is never listed: every synthetic name's split comes from its recipe (guard.ts synthSplit) and
 * every truth's own flags are checked (t8.ts loadTruth) before the file is opened. stdout: aggregates only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bassChords } from '../../bass/analyze';
import { bassConfigHash } from '../../bass/config';
import { argOf, json } from '../../bass/evalCommon';
import { decodeWav } from '../../browser/wav';
import { MemTracker } from '../../dsp/core/mem';
import { toMono } from '../../dsp/core/resample';
import { analyze as analyze2, type Chords2Input } from '../analyze';
import { appBassConfig, chords2ConfigHash, resolveChords2Config, T7_E1_D2_VALUES, type Chords2Config, type D2Values } from '../config';
import { f1ConfigHash } from '../front/config';
import { chords2Inputs, marksOnV2 } from '../pipeline';
import { addedQualities, triadOf } from '../vocab';
import { addFile, newAgg, summarize, type Agg } from './baselineAgg';
import { bassG2, f1, f3, items as tuningItemsAll, slim, table } from './baseline';
import { pairUnits, rateDiff, rateOfA, segmentBootstrap, sumRatio, type PairedUnit } from './bootstrap';
import { frontEnd, toEvalChords } from './frontEnd';
import { handEditsPer100 } from './gate';
import { beginLook, commitArg, readRegistry, requireCommittedDryRun, ROOT, synthSplit } from './guard';
import { prepareInput } from './input';
import { devTakes } from './r2';
import { editCounts, scoreChords, segmentUnits, truthQuality, type ChordScores, type EditCounts, type EvalChord, type Interval, type Measure, type SegmentUnit, type Vocab } from './score';
import { loadTruth, recItems, runJobs, type Item } from './t8';

const OUT = join(ROOT, 'out', 'chords2-s8dev1');
const SELF = fileURLToPath(import.meta.url);
export const LOOK = 's8-dev-1' as const;
export const TASK = 'T7';
const ALL_OFF = resolveChords2Config();

/* ------------------------------------------------------------ configs */

export interface Cfg {
  key: string;
  cfg: Chords2Config;
}
export const e1Config = (v: Omit<D2Values, 'range'>, d1 = false): Chords2Config => resolveChords2Config({ d2: { range: 'E1', ...v }, ...(d1 ? { octaveChroma: true } : {}) });
const keyOf = (v: Omit<D2Values, 'range'>) => `th${v.theta} tl${v.thetaLow} sp${v.switchPenalty}`;

/**
 * The tuning grid (docs/audio-spike8-t7.md §1, fixed and committed before any tuning number was read).
 * Round 1: θ .25 / .35 / .5 / .65 / .8 x θ_low .2 / .3 x switch penalty 0 / .1 / .3 (θ < θ_low left out): 27 values.
 * Round 2 (only under the rule of the record): around round 1's top (θ* ± .05 with θ >= θ_low*, the penalty x .5 / 1 / 2,
 * or 0 / .05 / .1 when it is 0), θ_low = θ_low*: up to 9 values.
 */
export function grid(round: number, around?: Omit<D2Values, 'range'>): Cfg[] {
  const vals: Omit<D2Values, 'range'>[] = [];
  if (round === 1) {
    for (const theta of [0.25, 0.35, 0.5, 0.65, 0.8]) for (const thetaLow of [0.2, 0.3]) for (const switchPenalty of [0, 0.1, 0.3]) if (theta >= thetaLow) vals.push({ theta, thetaLow, switchPenalty });
  } else if (round === 2) {
    if (!around) throw new Error('round 2 needs --around θ,θ_low,penalty (round 1 top)');
    const r2 = (x: number) => Math.round(x * 1000) / 1000;
    const sps = around.switchPenalty === 0 ? [0, 0.05, 0.1] : [0.5, 1, 2].map((k) => r2(around.switchPenalty * k));
    for (const theta of [-0.05, 0, 0.05].map((d) => r2(around.theta + d))) for (const switchPenalty of sps) if (theta >= around.thetaLow) vals.push({ theta, thetaLow: around.thetaLow, switchPenalty });
  } else throw new Error(`no grid for round ${round}`);
  return vals.map((v) => ({ key: keyOf(v), cfg: e1Config(v) }));
}

/** The values the look runs (chosen on the tuning split: config.ts T7_E1_D2_VALUES) and the same with D1. */
export const LOOK_CFGS: Cfg[] = [
  { key: 'E1', cfg: e1Config(T7_E1_D2_VALUES) },
  { key: 'E1|D1', cfg: e1Config(T7_E1_D2_VALUES, true) },
];
const REF_ROWS = ['v1a', 'bassG2'];

/* ------------------------------------------------------------ one file */

export interface FileRows {
  rows: Record<string, EvalChord[]>;
  ms: Record<string, number>;
}

/** Every row on one prepared signal (not changed). `refs`: also the reference rows v1a and bassG2. */
export function runFile(y: Float32Array, cfgs: readonly Cfg[], refs: boolean): FileRows {
  const now = () => performance.now();
  const app = appBassConfig();
  let t = now();
  const fe = frontEnd(y.slice());
  const ms: Record<string, number> = { front: now() - t };
  const beats = Array.from(fe.times);
  const timed = (input: Chords2Input, c: Chords2Config) => toEvalChords(analyze2({ ...input, mem: new MemTracker() }, c).segments, fe.times, fe.duration).map((x) => ({ ...x, bass: x.bass ?? null }));
  t = now();
  const own = chords2Inputs(y, fe.times, fe.duration, fe.input, ALL_OFF, app.lowCqt); // the all-off path: own bass CQT
  ms.baseCqt = now() - t;
  t = now();
  const v0 = timed(fe.input, ALL_OFF);
  ms.v0 = now() - t;
  t = now();
  const rows: Record<string, EvalChord[]> = { base: slim(bassChords(own.low, v0, beats, app)) };
  ms.base = now() - t;
  if (refs) {
    const g2 = bassG2();
    if (JSON.stringify(g2.lowCqt) !== JSON.stringify(app.lowCqt)) throw new Error('bassG2 and appBassConfig differ in lowCqt');
    rows.v1a = slim(v0);
    rows.bassG2 = slim(bassChords(own.low, v0, beats, g2));
  }
  if (!cfgs.length) return { rows, ms };
  const f1s = new Set(cfgs.map((c) => (c.cfg.f1 ? f1ConfigHash(c.cfg.f1) : 'none')));
  if (f1s.size !== 1 || f1s.has('none')) throw new Error('every config must read the same F1 values');
  t = now();
  const shared = chords2Inputs(y, fe.times, fe.duration, fe.input, (cfgs.find((c) => c.cfg.octaveChroma) ?? cfgs[0]).cfg, app.lowCqt);
  ms.f1 = now() - t;
  for (const { key, cfg } of cfgs) {
    t = now();
    rows[key] = slim(marksOnV2(shared.low, timed(shared.input, cfg), beats, app));
    ms[key] = now() - t;
  }
  return { rows, ms };
}

/* ------------------------------------------------------------ material */

const L_POOL = new Set(['L0', 'L1', 'L2', 'L3', 'LV']);
const B6 = new Set(['B0', 'B1', 'B2', 'B3']);
/** Table groups of a file. Synthetic: its set, SYN (all but the L sets), Lpool (L0-L3, LV), LR, v7 (the 7th voicings, T3), ALL. */
export function groupsOf(it: Pick<Item, 'name' | 'level' | 'kind'>): string[] {
  if (it.kind === 'rec') {
    const g = it.level;
    return [g, ...(g === 'a-d' || g === 'e-f' ? ['a-f'] : []), 'REC'];
  }
  const L = L_POOL.has(it.level) || it.level === 'LR';
  return [it.level, ...(L ? [] : ['SYN']), ...(L_POOL.has(it.level) ? ['Lpool'] : []), ...(B6.has(it.level) ? ['B0-3'] : []), ...(/-v7/.test(it.name) ? ['v7'] : []), 'ALL'];
}

/** Tuning material: baseline.ts items() (c2-t-*, spike 6 B0-B3 tuning, spike 0/2 L sets), every name of a tuning recipe. */
export const tuneItems = (): Item[] => tuningItemsAll().map((i) => ({ name: i.name, level: i.level, kind: 'syn' as const, wav: i.wav, truth: i.truth }));

/** Dev synthetic (names and paths from the manifests; nothing opened): c2-d-* (incl. T3's 7th voicings), spike 6 B0-B3 dev (timbres A / B), T3's dev L / LR. */
export function devSynItems(): Item[] {
  const out: Item[] = [];
  const c2 = join(ROOT, 'out', 'chords2');
  for (const v of json<{ variants: { name: string; set: string; split: string; heldOut: boolean; wav: string; truth: string }[] }>(join(c2, 'manifest.json')).variants)
    if (v.split === 'dev' && !v.heldOut && v.name.startsWith('c2-d-')) out.push({ name: v.name, level: v.set, kind: 'syn', wav: join(c2, v.wav), truth: join(c2, v.truth) });
  const b6 = join(ROOT, 'out', 'bass');
  for (const v of json<{ variants: { name: string; level: number | string; split: string; heldOut: boolean; timbre: string; wav: string; truth: string }[] }>(join(b6, 'manifest.json')).variants)
    if (v.split === 'dev' && !v.heldOut && v.timbre !== 'C') out.push({ name: v.name, level: String(v.level).startsWith('B') ? String(v.level) : `B${v.level}`, kind: 'syn', wav: join(b6, v.wav), truth: join(b6, v.truth) });
  const ld = join(ROOT, 'out', 'levels-dev');
  for (const v of json<{ variants: { name: string; level: number | string; heldOut?: boolean; wav: string; truth: string }[] }>(join(ld, 'manifest.json')).variants)
    if (v.heldOut === false) out.push({ name: v.name, level: String(v.level) === 'LR' ? 'LR' : `L${String(v.level)}`, kind: 'syn', wav: join(ld, v.wav), truth: join(ld, v.truth) });
  return out;
}

/* ------------------------------------------------------------ saved per file (truth-aligned) */

/** The measures saved per segment: `${vocab}:${measure}` (plan §5 lines). */
export const UNIT_MEASURES: readonly (readonly [Vocab, Measure])[] = [
  ['down', 'name'],
  ['down', 'root'],
  ['down', 'triadName'],
  ['down', 'slashRoot'],
  ['full', 'overAdd'],
  ['full', 'asTriadE1'],
  ['full', 'addedRecallE1'],
  ['full', 'addedPrecisionE1'],
];
const mk = (v: Vocab, m: Measure) => `${v}:${m}`;

export interface RowScores {
  full: ChordScores;
  down: ChordScores;
  eFull: EditCounts;
  eDown: EditCounts;
  units: Record<string, SegmentUnit[]>;
}
export interface FileRec extends FileRows {
  name: string;
  level: string;
  kind: 'syn' | 'rec';
  groups: string[];
  /** the truth track as scored (start, end, root, quality, bass, originalQuality) */
  truth: EvalChord[];
  scores: Record<string, RowScores>;
}

export function scoreFile(it: Item, t: { chords: EvalChord[]; beats: Parameters<typeof scoreChords>[2] }, r: FileRows): FileRec {
  const scores: Record<string, RowScores> = {};
  for (const [row, res] of Object.entries(r.rows)) {
    const units: Record<string, SegmentUnit[]> = {};
    for (const [v, m] of UNIT_MEASURES) units[mk(v, m)] = segmentUnits(t.chords, res, t.beats, v, m);
    scores[row] = { full: scoreChords(t.chords, res, t.beats, 'full'), down: scoreChords(t.chords, res, t.beats, 'down'), eFull: editCounts(t.chords, res, t.beats, 'full'), eDown: editCounts(t.chords, res, t.beats, 'down'), units };
  }
  const truth = t.chords.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: c.bass ?? null, ...(c.originalQuality ? { originalQuality: c.originalQuality } : {}) }));
  return { name: it.name, level: it.level, kind: it.kind, groups: groupsOf(it), ...r, truth, scores };
}

/** The split a dev look's / dry run's file must have; a synthetic name's split comes from its recipe only. */
function checkedSplit(it: Item, want: 'tuning' | 'dev'): 'tuning' | 'dev' {
  if (it.kind === 'rec') {
    if (want !== 'dev') throw new Error(`${it.name}: a recording in a tuning run`);
    return 'dev';
  }
  const s = synthSplit(it.name);
  if (s !== want) throw new Error(`${it.name}: recipe split ${s}, this run is ${want}`);
  return want;
}

interface Job {
  mode: 'tune' | 'look' | 'selftest';
  round?: number;
  around?: Omit<D2Values, 'range'>;
}
const jobCfgs = (j: Job): Cfg[] => (j.mode === 'tune' ? grid(j.round ?? 1, j.around) : LOOK_CFGS);
const filesDir = (dir: string) => join(dir, 'files');

/** One worker (runJobs spawns `<this file> look-worker --list <dir>/look-list-k.json`; the job is <dir>/job.json). */
function worker(argv: string[]): void {
  const list = argOf(argv, '--list')!;
  const dir = dirname(list);
  const job = json<Job>(join(dir, 'job.json'));
  const out = filesDir(dir);
  mkdirSync(out, { recursive: true });
  const want = job.mode === 'look' ? 'dev' : 'tuning';
  for (const it of json<Item[]>(list)) {
    const p = join(out, `${it.name}.json`);
    if (existsSync(p)) continue;
    const t = loadTruth(it, checkedSplit(it, want));
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    const r = runFile(prepareInput(toMono(w.channels), w.sampleRate, true).y, jobCfgs(job), job.mode !== 'tune');
    writeFileSync(p, JSON.stringify(scoreFile(it, t, r)));
  }
}

async function runAll(items: Item[], dir: string, job: Job, jobs: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  await runJobs(items, jobs, SELF, dir);
}

const readRecs = (dir: string): FileRec[] => {
  const d = filesDir(dir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => json<FileRec>(join(d, f))) : [];
};

/* ------------------------------------------------------------ aggregation (from the saved files only) */

const inGroup = (fs: readonly FileRec[], g: string) => fs.filter((f) => f.groups.includes(g));
export function aggOf(fs: readonly FileRec[], row: string, v: Vocab, g: string): Agg {
  const a = newAgg();
  for (const f of inGroup(fs, g)) {
    const s = f.scores[row];
    if (!s) throw new Error(`${f.name}: no row ${row}`);
    addFile(a, v === 'full' ? s.full : s.down, v === 'full' ? s.eFull : s.eDown);
  }
  return a;
}
const S = (fs: readonly FileRec[], row: string, v: Vocab, g: string) => summarize(aggOf(fs, row, v, g));
/** The row's and the base row's segment units of one measure, paired per file and segment. */
export const paired = (fs: readonly FileRec[], row: string, base: string, key: string, g: string): PairedUnit[] =>
  pairUnits(inGroup(fs, g).map((f) => ({ a: f.scores[row].units[key], b: f.scores[base].units[key] })));
const hand = (fs: readonly FileRec[], row: string, g: string) => handEditsPer100(S(fs, row, 'full', g));
const has = (fs: readonly FileRec[], g: string) => inGroup(fs, g).length > 0;

/* ------------------------------------------------------------ lines */

export interface GateLine {
  kind: '決め手' | '守り' | '見張り';
  line: string;
  value: number | null;
  /** extra text after the value (the two rates of a difference, counts) */
  note?: string;
  op: '>=' | '<=';
  target: number;
  /** a regression line's stop: between target and stop the user decides (△) */
  stop?: number;
  ci?: Interval | null;
  pass: boolean | null;
  user?: boolean;
  /** the 95 % interval contains the line */
  crosses?: boolean;
}

function mkLine(kind: GateLine['kind'], line: string, units: PairedUnit[] | null, stat: (us: readonly PairedUnit[]) => number | null, op: '>=' | '<=', target: number, o: { stop?: number; boot: boolean; note?: string }): GateLine {
  const value = units ? stat(units) : null;
  const ok = (x: number, t: number) => (op === '>=' ? x >= t - 1e-9 : x <= t + 1e-9);
  const ci = units && o.boot ? segmentBootstrap(units, stat) : null;
  const pass = value === null ? null : ok(value, target);
  const user = value !== null && !pass && o.stop !== undefined && ok(value, o.stop);
  return { kind, line, value, ...(o.note ? { note: o.note } : {}), op, target, ...(o.stop !== undefined ? { stop: o.stop } : {}), ci, pass, user, crosses: !!ci && ci.lo <= target + 1e-9 && ci.hi >= target - 1e-9 };
}

/**
 * The §5 lines of `row` against `base` (same run). `syn` / `L` / `rec`: the groups the lines read (dev look: SYN, Lpool +
 * LR, REC + a-f; tuning: SYN, Lpool + LR, none). `boot`: with 95 % segment-bootstrap intervals (bootstrap.ts).
 */
export function gateLines(fs: readonly FileRec[], row: string, base: string, o: { boot: boolean; overAddGroups: string[]; regGroups: string[]; slashGroups: string[] }): GateLine[] {
  const out: GateLine[] = [];
  const P = (key: string, g: string) => (has(fs, g) ? paired(fs, row, base, key, g) : null);
  const boot = o.boot;
  const rates = (us: PairedUnit[] | null) => (us ? `${f3(rateOfA(us))} − 基準 ${f3(rateOfA(us.map((u) => ({ a: u.b, b: u.a }))))}` : '');
  if (has(fs, 'SYN')) {
    out.push(mkLine('決め手', 'E1 適合率（7・m7・maj7・m7b5 まとめて、合成 SYN）', P(mk('full', 'addedPrecisionE1'), 'SYN'), rateOfA, '>=', 0.8, { boot }));
    const r = P(mk('full', 'addedRecallE1'), 'SYN');
    out.push(mkLine('決め手', 'E1 再現率 − 基準（合成 SYN）', r, rateDiff, '>=', 0.3, { boot, note: rates(r) }));
  }
  for (const g of o.overAddGroups) if (has(fs, g)) out.push(mkLine('守り', `足しすぎ（正解が 3 和音で /X 無しの点、${g}）`, P(mk('full', 'overAdd'), g), rateOfA, '<=', 0.03, { boot }));
  for (const [m, label] of [['name', '名前'], ['triadName', '3 和音の点の名前'], ['root', 'ルートだけ']] as const)
    for (const g of o.regGroups)
      if (has(fs, g)) {
        const us = P(mk('down', m), g);
        const rec = g === 'REC';
        out.push(mkLine('守り', `後戻り ${label} 落 − 基準（${g}）`, us, rateDiff, '>=', rec ? -0.02 : -0.01, { boot, ...(rec ? {} : { stop: -0.02 }), note: rates(us) }));
      }
  for (const g of o.slashGroups) if (has(fs, g)) out.push(mkLine('守り', `/X の点のルート 落 − 基準（${g}）`, P(mk('down', 'slashRoot'), g), rateDiff, '>=', -0.02, { boot }));
  for (const g of ['REC', 'SYN'])
    if (has(fs, g)) {
      const us = P(mk('full', 'asTriadE1'), g);
      const a = us ? us.reduce((x, u) => x + u.a.hit, 0) : 0;
      const b = us ? us.reduce((x, u) => x + u.b.hit, 0) : 0;
      out.push(mkLine('見張り', `7th を 3 和音に読む点の数 ÷ 基準（7→maj・m7→m、${g}${g === 'REC' ? '、決定 9' : ''}）`, us, sumRatio, '<=', 0.5, { boot, note: `${a} / ${b} 点` }));
    }
  for (const g of ['REC', 'SYN'])
    if (has(fs, g)) {
      const x = hand(fs, row, g);
      const b = hand(fs, base, g);
      out.push({ kind: '見張り', line: `手で直す数 / 100 拍 全 − 基準（${g}、候補で直せる分を除く。区間なし）`, value: x === null || b === null ? null : x - b, note: `${f1(x)} − 基準 ${f1(b)}`, op: '<=', target: -1.5, ci: null, pass: x === null || b === null ? null : x - b <= -1.5 + 1e-9 });
    }
  return out;
}
const mark = (l: GateLine) => (l.pass === null ? '–' : l.pass ? 'PASS' : l.user ? 'ユーザーが決める' : 'FAIL');
const fmt = (x: number | null) => (x === null ? '-' : Math.abs(x) >= 2 ? x.toFixed(2) : f3(x));
export const fmtLines = (ls: readonly GateLine[]) =>
  ls.map((l) => `| ${l.kind} | ${l.line} | ${fmt(l.value)}${l.note ? `（${l.note}）` : ''} | ${l.ci ? `[${fmt(l.ci.lo)}, ${fmt(l.ci.hi)}]` : '-'} | ${l.op === '>=' ? '≥' : '≤'} ${fmt(l.target)}${l.stop !== undefined ? `（止める ${fmt(l.stop)}）` : ''} | ${mark(l)}${l.crosses ? '・区間が線をまたぐ' : ''} |`).join('\n');
const LINE_HEAD = '| 区分 | 線 | 値 | 95 % 区間（区間単位） | 線 | 判定 |\n| --- | --- | --- | --- | --- | --- |';

/* ------------------------------------------------------------ tuning: the selection rule */

const TUNE_OPTS = { boot: false, overAddGroups: ['ALL'], regGroups: ['Lpool', 'LR', 'ALL'], slashGroups: ['SYN'] };

/**
 * The selection rule (docs/audio-spike8-t7.md §1, fixed before any tuning number was read), on the tuning split, every
 * line against `base` in the same run: 1. fewest failed 守り lines (足しすぎ ALL <= .03; 後戻り name / triad-point name /
 * root 落 on Lpool, LR, ALL >= base - .01; /X root SYN >= base - .02); 2. most 決め手 lines passed (E1 precision >= .80,
 * recall >= base + .30, SYN); 3. fewer hand edits (全, SYN); 4. higher E1 recall (SYN). The 見張り lines are not used.
 */
export function rank(fs: readonly FileRec[], keys: readonly string[]) {
  const hb = hand(fs, 'base', 'SYN') ?? Infinity;
  return keys
    .map((key) => {
      const ls = gateLines(fs, key, 'base', TUNE_OPTS);
      const guards = ls.filter((l) => l.kind === '守り');
      const dec = ls.filter((l) => l.kind === '決め手');
      return {
        key,
        guardFails: guards.filter((l) => l.pass === false).length,
        decisive: dec.filter((l) => l.pass).length,
        hand: hand(fs, key, 'SYN') ?? Infinity,
        recall: rateOfA(paired(fs, key, 'base', mk('full', 'addedRecallE1'), 'SYN')) ?? -1,
        precision: rateOfA(paired(fs, key, 'base', mk('full', 'addedPrecisionE1'), 'SYN')) ?? -1,
        handBase: hb,
        lines: ls,
      };
    })
    .sort((a, b) => a.guardFails - b.guardFails || b.decisive - a.decisive || a.hand - b.hand || b.recall - a.recall);
}

const tuneDir = (round: number) => join(OUT, `tune${round}`);
const aroundOf = (argv: string[]): Omit<D2Values, 'range'> | undefined => {
  const a = argOf(argv, '--around');
  if (!a) return undefined;
  const [theta, thetaLow, switchPenalty] = a.split(',').map(Number);
  return { theta, thetaLow, switchPenalty };
};

async function tuneRun(argv: string[]): Promise<void> {
  const round = Number(argOf(argv, '--round') ?? '1');
  const job: Job = { mode: 'tune', round, around: aroundOf(argv) };
  grid(round, job.around); // refuse a bad round before any file
  await runAll(tuneItems(), tuneDir(round), job, Number(argOf(argv, '--jobs') ?? '6'));
  console.log(`round ${round}: ${readRecs(tuneDir(round)).length} files`);
}

function tuneReport(argv: string[]): void {
  const round = Number(argOf(argv, '--round') ?? '1');
  const cfgs = grid(round, aroundOf(argv));
  const fs = readRecs(tuneDir(round));
  const L: string[] = [`# T7 tuning round ${round}: ${fs.length} files (SYN ${inGroup(fs, 'SYN').length}, Lpool ${inGroup(fs, 'Lpool').length}, LR ${inGroup(fs, 'LR').length})`];
  const rows = ['base', ...cfgs.map((c) => c.key)];
  const pr = (row: string, m: Measure, g = 'SYN') => rateOfA(paired(fs, row, 'base', mk('full', m), g));
  L.push(table('調整用（SYN = 合成の B・V1〜V3・pair・B0〜B3。R / P = E1 の再現率 / 適合率）', ['R', 'P', '足しすぎ ALL', '名前 落 Lpool / LR / ALL', '3 和音の名前 ALL', 'ルート ALL', '/X ルート SYN', '7→3 和音 点 SYN', '手数 全 SYN', '候補 / 100 拍 SYN'], rows.map((r) => {
    const d = (g: string) => S(fs, r, 'down', g);
    const sev = S(fs, r, 'full', 'SYN').added.asTriad;
    return [r, [f3(pr(r, 'addedRecallE1')), f3(pr(r, 'addedPrecisionE1')), f3(S(fs, r, 'full', 'ALL').added.overAdd), `${f3(d('Lpool').name.rate)} / ${f3(d('LR').name.rate)} / ${f3(d('ALL').name.rate)}`, f3(d('ALL').added.triadName), f3(rateOfA(paired(fs, r, 'base', mk('down', 'root'), 'ALL'))), f3(d('SYN').slashRoot.rate), `${(sev['7'] ?? 0) + (sev.min7 ?? 0)}`, f1(hand(fs, r, 'SYN')), f1(S(fs, r, 'full', 'SYN').added.addedCandidatePer100)]];
  })));
  L.push('\n## 選び方（表を読む前に決めた）の順');
  for (const r of rank(fs, cfgs.map((c) => c.key))) L.push(`- ${r.key}: 守りの FAIL ${r.guardFails}, 決め手 ${r.decisive}/2, 手数 ${f1(r.hand)} (基準 ${f1(r.handBase)}), R ${f3(r.recall)}, P ${f3(r.precision)}`);
  const top = rank(fs, cfgs.map((c) => c.key))[0];
  if (top) L.push(`\n## 1 位 ${top.key} の線\n${LINE_HEAD}\n${fmtLines(top.lines)}`);
  const text = L.join('\n');
  console.log(text);
  writeFileSync(join(OUT, `tune${round}-report.md`), text);
}

/* ------------------------------------------------------------ the look report */

const LOOK_OPTS = { boot: true, overAddGroups: ['a-f', 'SYN'], regGroups: ['Lpool', 'LR', 'REC'], slashGroups: ['REC', 'SYN'] };
const SYN_GROUPS = ['B', 'V1', 'V2', 'V3', 'pair', 'v7', 'B0-3', 'SYN', 'Lpool', 'LR'];
const REC_GROUPS = ['a-d', 'e-f', 'g-j', 'a-f', 'REC'];

/**
 * T5's question (counts only): within a run of added-tone chords on the same root and triad, how often the added tone
 * switches (7 <-> maj7 ...) at a boundary, and how many of those boundaries lie inside ONE truth segment (a split the
 * truth does not have).
 */
export function fragmentation(fs: readonly FileRec[], row: string, g: string): { boundaries: number; switches: number; insideTruth: number } {
  let boundaries = 0, switches = 0, insideTruth = 0;
  const added = (q: string) => triadOf(q) !== null && triadOf(q) !== q;
  for (const f of inGroup(fs, g)) {
    const cs = f.rows[row] ?? [];
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], b = cs[i];
      if (Math.abs(a.end - b.start) > 1e-6) continue;
      boundaries++;
      if (a.root !== b.root || !added(a.quality) || !added(b.quality) || triadOf(a.quality) !== triadOf(b.quality) || a.quality === b.quality) continue;
      switches++;
      if (f.truth.some((t) => t.start < b.start - 1e-6 && t.end > b.start + 1e-6)) insideTruth++;
    }
  }
  return { boundaries, switches, insideTruth };
}

export function lookReport(title: string, fs: readonly FileRec[]): string {
  const rows = ['base', ...REF_ROWS, ...LOOK_CFGS.map((c) => c.key)].filter((r) => fs.every((f) => f.scores[r]));
  const out: string[] = [`# ${title}: ${fs.length} files`];
  const hashes = [`all-off ${chords2ConfigHash()}`, `base = appBassConfig ${bassConfigHash(appBassConfig())}`, `bassG2 ${bassConfigHash(bassG2())}`, ...LOOK_CFGS.map((c) => `${c.key} ${chords2ConfigHash(c.cfg)}`), `F1 ${f1ConfigHash(LOOK_CFGS[0].cfg.f1)}`];
  out.push(`hashes: ${hashes.join(', ')}`);
  for (const [kind, groups] of [['syn', SYN_GROUPS], ['rec', REC_GROUPS]] as const) {
    const sub = fs.filter((f) => f.kind === kind);
    if (!sub.length) continue;
    const gs = groups.filter((g) => has(sub, g));
    out.push(`\n## ${kind === 'syn' ? '合成' : '録音'}: files per group ${gs.map((g) => `${g} ${inGroup(sub, g).length}`).join(', ')}`);
    const per = (f: (r: string, g: string) => string): [string, string[]][] => rows.map((r) => [r, gs.map((g) => f(r, g))]);
    const pa = (r: string, key: string, g: string) => rateOfA(paired(sub, r, 'base', key, g));
    out.push(table('名前 落', gs, per((r, g) => f3(S(sub, r, 'down', g).name.rate))));
    out.push(table('ルートだけ 落', gs, per((r, g) => f3(pa(r, mk('down', 'root'), g)))));
    out.push(table('3 和音の点の名前 落', gs, per((r, g) => f3(S(sub, r, 'down', g).added.triadName))));
    out.push(table('E1 再現率 / 適合率（全、まとめて）', gs, per((r, g) => `${f3(pa(r, mk('full', 'addedRecallE1'), g))} / ${f3(pa(r, mk('full', 'addedPrecisionE1'), g))}`)));
    out.push(table('足しすぎ（全）', gs, per((r, g) => f3(S(sub, r, 'full', g).added.overAdd))));
    out.push(table('7th を 3 和音に読む点（7→maj / m7→m、全）', gs, per((r, g) => { const a = S(sub, r, 'full', g).added.asTriad; return `${a['7'] ?? 0} / ${a.min7 ?? 0}`; })));
    out.push(table('/X の点のルート 落', gs, per((r, g) => { const s = S(sub, r, 'down', g); return s.slashRoot.n ? f3(s.slashRoot.rate) : '-'; })));
    out.push(table('手で直す数 / 100 拍 全（候補で直せる分を除く）', gs, per((r, g) => f1(hand(sub, r, g)))));
    out.push(table('候補を出した拍 / 100 拍（全）', gs, per((r, g) => f1(S(sub, r, 'full', g).added.addedCandidatePer100))));
    // per E1 quality (record): truth segments of the quality in the group, recall / precision (root + quality, 全)
    const g0 = kind === 'syn' ? 'SYN' : 'REC';
    const segs = (q: string) => inGroup(sub, g0).reduce((n, f) => n + f.truth.filter((t) => truthQuality(t, 'full') === q).length, 0);
    out.push(table(`種類ごとの当たり ${g0}（区間の数・再現率 / 適合率。20 区間未満は記録だけ）`, addedQualities('E1'), rows.map((r) => [r, addedQualities('E1').map((q) => { const b = aggOf(sub, r, 'full', g0).byQuality[q]; return `${segs(q)}: ${f3(b && b.t.n ? b.t.hit / b.t.n : null)} / ${f3(b && b.r.n ? b.r.hit / b.r.n : null)}`; })])));
  }
  for (const c of LOOK_CFGS) {
    if (!rows.includes(c.key)) continue;
    out.push(`\n## §5 の線: ${c.key}（基準 = appBassConfig()、同じ実行。区間 = 区間単位のブートストラップ 2000 回）\n${LINE_HEAD}\n${fmtLines(gateLines(fs, c.key, 'base', LOOK_OPTS))}`);
  }
  out.push('\n## HMM の区切れ（T5 の問い、数だけ）: 隣り合う区間の境目 / 同じルート・3 和音で足す音が入れ替わる境目 / そのうち正解の 1 区間の中');
  for (const c of LOOK_CFGS) for (const g of ['SYN', 'REC']) if (has(fs, g) && rows.includes(c.key)) { const x = fragmentation(fs, c.key, g); out.push(`- ${c.key} ${g}: ${x.boundaries} / ${x.switches} / ${x.insideTruth}`); }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const msKeys = [...new Set(fs.flatMap((f) => Object.keys(f.ms)))];
  out.push(`\nstage time per file, median ms: ${msKeys.map((k) => `${k} ${med(fs.map((f) => f.ms[k] ?? 0)).toFixed(1)}`).join(', ')}`);
  return out.join('\n');
}

/**
 * The listening list for the user (plan §8): time-stamped segments of the recordings where the truth is an E1 quality
 * or a row disagrees with the base, written ONLY under gitignored out/ (chord names; never printed).
 */
function listeningList(fs: readonly FileRec[], path: string): void {
  const name = (c: EvalChord | undefined) => (c ? `${c.root}${c.quality === 'maj' ? '' : c.quality === 'min' ? 'm' : c.quality}${c.bass ? `/${c.bass}` : ''}` : 'N');
  const at = (cs: readonly EvalChord[], t: number) => cs.find((c) => c.start <= t && t < c.end);
  const L = ['# s8-dev-1 聞く一覧（out/ だけ。共有しない）', '', '| 録音 | 秒 | 正解 | 基準 | E1 | E1+D1 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const f of fs.filter((x) => x.kind === 'rec'))
    for (const t of f.truth) {
      const mid = (t.start + t.end) / 2;
      const r = ['base', 'E1', 'E1|D1'].map((k) => name(at(f.rows[k] ?? [], mid)));
      const e1 = addedQualities('E1').includes(truthQuality(t, 'full') ?? '');
      if (!e1 && r[0] === r[1] && r[0] === r[2]) continue;
      L.push(`| ${f.name} | ${t.start.toFixed(1)}–${t.end.toFixed(1)} | ${name(t)} | ${r.join(' | ')} |`);
    }
  writeFileSync(path, L.join('\n') + '\n');
}

/* ------------------------------------------------------------ look, dry run, inputs */

const lookDir = (which: string) => join(OUT, which);

/** The dev material is complete (manifest / registry names and file existence only; no wav or truth is opened). */
function checkInputs(): void {
  const syn = devSynItems();
  const takes = devTakes(readRegistry());
  const recs = recItems(takes);
  const bad = syn.filter((s) => synthSplit(s.name) !== 'dev').map((s) => s.name);
  const missing = [...syn, ...recs].filter((i) => !existsSync(i.wav) || !existsSync(i.truth)).map((i) => i.name);
  const n = (p: (i: Item) => boolean) => syn.filter(p).length;
  console.log(`dev synthetic ${syn.length}: c2-d ${n((i) => i.name.startsWith('c2-d-'))} (7th voicings ${n((i) => /^c2-d-.*-v7/.test(i.name))}), spike 6 B0-B3 ${n((i) => i.name.startsWith('syn-b'))}, dev L/LR ${n((i) => /^etude/.test(i.name))}`);
  console.log(`dev recordings ${takes.length}: ${takes.map((t) => t.split('-')[2]).join(' ')}`);
  console.log(`names whose recipe is not dev: ${bad.length}; files missing (wav or truth): ${missing.length}`);
  if (bad.length || missing.length) throw new Error('dev material incomplete');
}

async function selftest(argv: string[]): Promise<void> {
  requireCommittedDryRun(argv);
  const dir = lookDir('selftest');
  await runAll(tuneItems(), dir, { mode: 'selftest' }, Number(argOf(argv, '--jobs') ?? '6'));
  const text = lookReport('selftest (tuning, the look path; not a look)', readRecs(dir));
  console.log(text);
  writeFileSync(join(OUT, 'selftest-report.md'), text);
}

async function look(argv: string[]): Promise<void> {
  const takes = devTakes(readRegistry());
  const syn = devSynItems();
  const configHashes = [chords2ConfigHash(), ...LOOK_CFGS.map((c) => chords2ConfigHash(c.cfg)), bassConfigHash(appBassConfig()), bassConfigHash(bassG2())];
  const { finish, line } = beginLook(
    {
      look: LOOK,
      task: TASK,
      reason: `T7: dev look 1 before G1 - E1 via D2 (chords2 ${chords2ConfigHash(LOOK_CFGS[0].cfg)}, tuning-split values) and the same with D1 (${chords2ConfigHash(LOOK_CFGS[1].cfg)}), appBassConfig() marks, against the base row appBassConfig() (+ references v1a, bassG2) on the dev synthetic (c2-d incl. 7th voicings, B0-B3 dev, dev L/LR) and the dev recordings a-j; no tuning after this`,
      configHashes,
      takes,
      synthetic: syn.map((s) => s.name),
    },
    commitArg(argv),
  );
  console.log(`look-start logged: ${line.look} ${line.task} commit ${line.commit?.slice(0, 7)} takes ${takes.length} synthetic ${syn.length}`);
  const dir = lookDir('look');
  await runAll([...syn, ...recItems(takes)], dir, { mode: 'look' }, Number(argOf(argv, '--jobs') ?? '6'));
  const fs = readRecs(dir);
  const text = lookReport(`T7 ${LOOK}`, fs);
  writeFileSync(join(OUT, 'look-report.md'), text);
  listeningList(fs, join(dir, 'listening-list.local.md'));
  console.log(text);
  finish();
  console.log('\nlook-done logged');
}

/** The tables again from the saved per-file results (after the look: git tools only). */
function reportAgain(argv: string[]): void {
  const which = argOf(argv, '--dir') ?? 'look';
  console.log(lookReport(`T7 ${which} (from out/)`, readRecs(lookDir(which))));
}

/** 5 minutes of tuning audio (B set), the look's rows; the difference to the base path (Node; the browser is T11). */
function timing(): void {
  const clips = tuneItems().filter((i) => i.level === 'B').slice(0, 3).map((it) => {
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    return prepareInput(toMono(w.channels), w.sampleRate, true).y;
  });
  const need = 5 * 60 * 22050;
  const y = new Float32Array(need);
  for (let o = 0, i = 0; o < need; i++) {
    const c = clips[i % clips.length].subarray(0, need - o);
    y.set(c, o);
    o += c.length;
  }
  const runs = [0, 1, 2].map(() => runFile(y, LOOK_CFGS.slice(0, 1), false).ms);
  const med = (k: string) => [...runs.map((r) => r[k] ?? 0)].sort((a, b) => a - b)[1];
  const keys = Object.keys(runs[0]);
  console.log(`5 分, 3 回の中央値 ms: ${keys.map((k) => `${k} ${med(k).toFixed(0)}`).join(', ')}`);
  // base path: own bass CQT + V0 + marks; E1 path: F1 (one 7-octave CQT, bass gets its lower 5) + V0 with D2 + marks
  console.log(`E1 − 基準 = ${(med('f1') + med('E1') - med('baseCqt') - med('v0') - med('base')).toFixed(0)} ms（予算 +3000 ms）`);
}

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
  else if (cmd === 'timing') timing();
  else {
    console.error('usage: s8dev1.ts tune run|report [--round r] [--around θ,θ_low,p] | selftest --commit SHA | check-inputs | look --commit SHA | report --dir look | timing');
    process.exit(2);
  }
}
