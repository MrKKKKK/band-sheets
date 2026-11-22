/**
 * Spike 7 T8: method B (bass as the root; docs/audio-spike7-plan.md §2.1, G1; docs/audio-spike7-t8.md). From
 * spikes/analysis, in the devcontainer:
 *
 *   npx tsx ts/chords2/eval/t8.ts tune run [--shard k/n]   TUNING material only -> out/chords2-t8/tune/<name>.json
 *   npx tsx ts/chords2/eval/t8.ts tune report               the M3 / M1 grids against the G1 lines (tuning numbers)
 *   npx tsx ts/chords2/eval/t8.ts selftest                  the look pipeline on 6 tuning files (not a look)
 *   BAND_SHEETS_COMMIT=SHA npx tsx ts/chords2/eval/t8.ts look [--jobs N]   look point 2 ('dev-2', once)
 *   npx tsx ts/chords2/eval/t8.ts timing                    1 / 3 / 5 minute inputs (Node)
 *
 * Rows: v1a (= chords2 V0, checked equal in T7), the spike 6 bass stage T8 form (基準) and G2 default (参考) on those
 * segments, and the T8 methods (bass.ts) with the chosen values (`T8_ROWS`). Every file goes through prepareInput
 * (RMS -22 dBFS). Tuning material = baseline.ts items() minus the pair / V2 / V3 sets (B stage only). The look opens,
 * after beginLook: chords2 dev synthetic (c2-d-*), spike 6 B0-B3 dev (seeds 4-5, timbres A / B), the non-held-out
 * spike 0/2 L sets (the regression watch; they have no dev split) and the spike 7 dev recordings. Held-out is never
 * listed: every manifest / truth / registry flag is checked before a file is opened. Output: aggregates only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bassChords } from '../../bass/analyze';
import { bassConfigHash, type BassConfig } from '../../bass/config';
import { argOf, json } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import type { ScoreBeat } from '../../bass/score';
import { decodeWav } from '../../browser/wav';
import { toMono } from '../../dsp/core/resample';
import { analyze as analyze2 } from '../analyze';
import { bassStage, marksConfig } from '../bass';
import { chords2ConfigHash, resolveChords2Config, type Chords2Config } from '../config';
import { addConfusion, addFile, newAgg, newConfusion, summarize, type Agg, type Confusion } from './baselineAgg';
import { bassG2, bassT8, ci, f1, f3, items as tuningItems, slim, table, v2Config } from './baseline';
import { frontEnd, toEvalChords } from './frontEnd';
import { fixedBroken, handEditsPer100 } from './gate';
import { beginLook, commitArg, committedBlock, git, readRegistry, ROOT } from './guard';
import { prepareInput } from './input';
import { devTakes, expectedTruthHeldOut, groupOf } from './r2';
import { editCounts, scoreChords, type EvalChord } from './score';

const OUT = join(ROOT, 'out', 'chords2-t8');
export const LOOK = 'dev-2' as const;
export const TASK = 'T8';

/* ------------------------------------------------------------ rows */

export interface RowSpec {
  id: string;
  /** spike 6 marks on the V0 (= v1a) segments, or a chords2 config with a B method */
  bass?: BassConfig;
  c2?: Chords2Config;
}
const BASE_ROWS: RowSpec[] = [{ id: 'v1a' }, { id: 'bassT8', bass: bassT8() }, { id: 'bassG2', bass: bassG2() }];
export const m3Config = (m3: { margin: number }) => resolveChords2Config({ bass: { method: 'M3', m3 } });
export const m1Config = (trebleWeight: number) => resolveChords2Config({ bass: { method: 'M1', m1: { trebleWeight } } });

/** The values chosen on the tuning split (config.ts DEFAULT_BASS_METHOD_VALUES); the look runs exactly these. */
export const T8_ROWS: RowSpec[] = [...BASE_ROWS, ...(['M3', 'M1', 'M2'] as const).map((method) => ({ id: method, c2: resolveChords2Config({ bass: { method } }) }))];

/** Tuning grids (values fixed before the tuning run). */
export function gridRows(): RowSpec[] {
  const out: RowSpec[] = [...BASE_ROWS];
  for (const margin of [0, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3]) out.push({ id: `M3 mg${margin}`, c2: m3Config({ margin }) });
  for (const w of [0.25, 0.5, 0.75, 1]) out.push({ id: `M1 w${w}`, c2: m1Config(w) });
  // M2 (G1 decision 8: built because M1 and M3 both missed G1 lines on the tuning split, rounds 1-3)
  for (const w of [0.5, 0.75, 1])
    for (const bassWeight of [0.1, 0.2, 0.4])
      for (const rootBonus of [0, 0.05]) out.push({ id: `M2 w${w} bw${bassWeight} rb${rootBonus}`, c2: resolveChords2Config({ bass: { method: 'M2', m2: { trebleWeight: w, bassWeight, rootBonus } } }) });
  return out;
}

export interface FileRows {
  rows: Record<string, EvalChord[]>;
  ms: Record<string, number>;
}

/** Every row on one prepared signal (not changed). */
export function runFile(y: Float32Array, specs: readonly RowSpec[]): FileRows {
  const t0 = performance.now();
  const fe = frontEnd(y.slice());
  const timed = (c: Chords2Config) => toEvalChords(analyze2(fe.input, c).segments, fe.times, fe.duration).map((x) => ({ ...x, bass: x.bass ?? null }));
  const v0 = timed(v2Config('V0'));
  const ms: Record<string, number> = { front: performance.now() - t0 };
  let t = performance.now();
  const marks = marksConfig();
  const low = lowCqt(y, marks.lowCqt);
  ms.lowCqt = performance.now() - t;
  const beats = Array.from(fe.times);
  const stage = new Map<string, typeof v0>(); // chord-stage output per M1 / M2 values
  const rows: Record<string, EvalChord[]> = {};
  for (const s of specs) {
    t = performance.now();
    if (!s.bass && !s.c2) rows[s.id] = v0;
    else if (s.bass) rows[s.id] = slim(bassChords(low, v0, beats, s.bass));
    else {
      const cfg = s.c2!;
      let segs = v0;
      if (cfg.bass.method !== 'M3') {
        const k = JSON.stringify(cfg.bass);
        if (!stage.has(k)) stage.set(k, timed(cfg));
        segs = stage.get(k)!;
      }
      rows[s.id] = slim(bassStage(low, segs, beats, cfg, marks));
    }
    ms[s.id] = performance.now() - t;
  }
  return { rows, ms };
}

/* ------------------------------------------------------------ material */

export interface Truth {
  beats: ScoreBeat[];
  chords: EvalChord[];
  chords2?: { variant?: { split?: string; heldOut?: boolean } };
  bass?: { variant?: { split?: string; heldOut?: boolean; timbre?: string } };
  name?: string;
  heldOut?: boolean;
  excludedBars?: number[];
}
export interface Item {
  name: string;
  /** group for the tables: B, V1..V3, pair, B0..B3, L0..L3, LR, LV, or a-d / e-f / g-j for recordings */
  level: string;
  kind: 'syn' | 'rec';
  wav: string;
  truth: string;
}

/** The tuning material of T8 (B stage): baseline.ts items() without the pair / V2 / V3 sets. */
const tuneItems = (): Item[] =>
  tuningItems()
    .filter((i) => !['pair', 'V2', 'V3'].includes(i.level))
    .map((i) => ({ name: i.name, level: i.level, kind: 'syn' as const, wav: i.wav, truth: i.truth }));

/** Dev synthetic + the L sets (manifest flags checked; nothing opened). */
export function devSynItems(): Item[] {
  const out: Item[] = [];
  const c2 = join(ROOT, 'out', 'chords2');
  for (const v of json<{ variants: { name: string; set: string; split: string; heldOut: boolean; wav: string; truth: string }[] }>(join(c2, 'manifest.json')).variants)
    if (v.split === 'dev' && !v.heldOut && v.name.startsWith('c2-d-')) out.push({ name: v.name, level: v.set, kind: 'syn', wav: join(c2, v.wav), truth: join(c2, v.truth) });
  const b6 = join(ROOT, 'out', 'bass');
  for (const v of json<{ variants: { name: string; level: number | string; split: string; heldOut: boolean; timbre: string; wav: string; truth: string }[] }>(join(b6, 'manifest.json')).variants)
    if (v.split === 'dev' && !v.heldOut && v.timbre !== 'C') out.push({ name: v.name, level: String(v.level).startsWith('B') ? String(v.level) : `B${v.level}`, kind: 'syn', wav: join(b6, v.wav), truth: join(b6, v.truth) });
  for (const i of tuningItems()) if (i.set === 'spike0') out.push({ name: i.name, level: i.level, kind: 'syn', wav: i.wav, truth: i.truth });
  return out;
}

export const recItems = (takes: string[]): Item[] => takes.map((id) => ({ name: id, level: groupOf(id), kind: 'rec', wav: join(ROOT, 'recordings', `${id}.wav`), truth: join(ROOT, 'recordings', `${id}.truth.json`) }));

/** Reads a truth after checking its own flags (dev / tuning only). */
export function loadTruth(it: Item, split: 'tuning' | 'dev'): Truth {
  const t = json<Truth>(it.truth);
  const c2v = t.chords2?.variant;
  const bv = t.bass?.variant;
  if (c2v && (c2v.split !== split || c2v.heldOut)) throw new Error(`${it.name}: truth split is not ${split}`);
  if (bv && (bv.split !== split || bv.heldOut || bv.timbre === 'C')) throw new Error(`${it.name}: truth split is not ${split}`);
  if (it.kind === 'rec') {
    const reg = readRegistry();
    if (!reg || t.name !== it.name || t.heldOut !== expectedTruthHeldOut(reg[it.name]) || (t.excludedBars ?? []).length) throw new Error(`${it.name}: truth flags / excluded bars not as expected`);
  }
  return t;
}

function processItem(it: Item, specs: readonly RowSpec[], dir: string): void {
  const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
  const r = runFile(prepareInput(toMono(w.channels), w.sampleRate, true).y, specs);
  writeFileSync(join(dir, `${it.name}.json`), JSON.stringify({ name: it.name, level: it.level, kind: it.kind, ...r }));
}

/* ------------------------------------------------------------ aggregation */

export interface Cached extends FileRows {
  name: string;
  level: string;
  kind: 'syn' | 'rec';
}
export const L_POOL = new Set(['L0', 'L1', 'L2', 'L3', 'LV']);
const B6 = new Set(['B0', 'B1', 'B2', 'B3']);
/** Table groups a file belongs to. */
export const groupsOf = (c: Pick<Cached, 'level' | 'kind'>): string[] =>
  c.kind === 'rec' ? [c.level, 'REC'] : [c.level, ...(L_POOL.has(c.level) ? ['Lpool'] : []), ...(B6.has(c.level) ? ['B0-3'] : []), ...(L_POOL.has(c.level) || c.level === 'LR' ? [] : ['SYN'])];

interface Tally {
  agg: Record<string, Agg>; // `${vocab}|${row}|${group}`
  conf: Record<string, Confusion>; // `${row}|${group}`
  fb: Record<string, { fixed: number; broken: number; units: number }>; // `${row}|${group}` vs bassT8 (落)
  ms: Record<string, number[]>;
}
function tally(files: { c: Cached; t: Truth }[], rowIds: readonly string[]): Tally {
  const T: Tally = { agg: {}, conf: {}, fb: {}, ms: {} };
  for (const { c, t } of files) {
    const gs = groupsOf(c);
    for (const row of rowIds) {
      const res = c.rows[row];
      for (const v of ['full', 'down'] as const) {
        const s = scoreChords(t.chords, res, t.beats, v);
        const e = editCounts(t.chords, res, t.beats, v);
        for (const g of gs) addFile((T.agg[`${v}|${row}|${g}`] ??= newAgg()), s, e);
      }
      const fb = row === 'bassT8' ? null : fixedBroken(t.chords, c.rows.bassT8, res, t.beats, 'down');
      for (const g of gs) {
        addConfusion((T.conf[`${row}|${g}`] ??= newConfusion()), t.chords, res, t.beats, 'down');
        if (fb) {
          const x = (T.fb[`${row}|${g}`] ??= { fixed: 0, broken: 0, units: 0 });
          x.fixed += fb.fixed;
          x.broken += fb.broken;
          x.units += fb.units;
        }
      }
      (T.ms[row] ??= []).push(c.ms[row] ?? 0);
    }
  }
  return T;
}
const S = (T: Tally, v: 'full' | 'down', row: string, g: string) => summarize(T.agg[`${v}|${row}|${g}`] ?? newAgg());

/** The G1 lines for one row (plan「G1 の決定」, §5). Synthetic lines use the dev baseline rows of the same run. */
export function g1Lines(T: Tally, row: string): { line: string; value: string; target: string; pass: boolean | null }[] {
  const d = (g: string) => S(T, 'down', row, g);
  const b = (g: string) => S(T, 'down', 'bassT8', g);
  const g2 = (g: string) => S(T, 'down', 'bassG2', g);
  const out: { line: string; value: string; target: string; pass: boolean | null }[] = [];
  const ge = (line: string, x: number | null, min: number | null, label = f3(min)) => out.push({ line, value: f3(x), target: `≥ ${label}`, pass: x === null || min === null ? null : x >= min - 1e-9 });
  const le = (line: string, x: number | null, max: number) => out.push({ line, value: f3(x), target: `≤ ${f3(max)}`, pass: x === null ? null : x <= max + 1e-9 });
  const has = (g: string) => (T.agg[`down|${row}|${g}`]?.files ?? 0) > 0;
  const add = (x: number | null, k: number) => (x === null ? null : x + k);
  if (has('REC')) ge('1 名前 落 録音 ALL（基準 +.05）', d('REC').name.rate, add(b('REC').name.rate, 0.05));
  if (has('B2')) ge('1 名前 落 合成 B2（基準 +.05）', d('B2').name.rate, add(b('B2').name.rate, 0.05));
  if (has('REC')) ge('2 /X の点のルート 録音（基準 +.20、かつ G2 既定以上）', d('REC').slashRoot.rate, Math.max(add(b('REC').slashRoot.rate, 0.2) ?? 0, g2('REC').slashRoot.rate ?? 0));
  if (has('B1')) ge('2 /X の点のルート 合成 B1（基準 +.20）', d('B1').slashRoot.rate, add(b('B1').slashRoot.rate, 0.2));
  if (has('REC')) le('3 誤った /X 録音 ALL', d('REC').wrongSlash, 0.02);
  if (has('LR')) le('3 誤った /X 合成 LR', d('LR').wrongSlash, 0.05);
  if (has('LR')) ge('4 後戻り LR 名前（G2 既定 −.01）', d('LR').name.rate, add(g2('LR').name.rate, -0.01));
  if (has('Lpool')) ge('4 後戻り L0〜L3・LV 名前（G2 既定 −.01）', d('Lpool').name.rate, add(g2('Lpool').name.rate, -0.01));
  if (has('REC')) ge('4 後戻り 録音 ALL 名前（G2 既定 −.02）', d('REC').name.rate, add(g2('REC').name.rate, -0.02));
  const hand = (g: string, r: string) => handEditsPer100(S(T, 'down', r, g));
  for (const g of ['REC', 'SYN']) if (has(g)) {
    const x = hand(g, row);
    const base = hand(g, 'bassT8');
    out.push({ line: `5 手で直す数 / 100 拍 落 ${g === 'REC' ? '録音 ALL' : '合成（開発用 B・V・pair・B0〜B3）'}（基準 −1.5）`, value: f1(x), target: `≤ ${f1(base === null ? null : base - 1.5)}`, pass: x === null || base === null ? null : x <= base - 1.5 + 1e-9 });
  }
  return out;
}

const hist = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ');

function report(title: string, files: { c: Cached; t: Truth }[], specs: readonly RowSpec[], groups: readonly string[]): string {
  const ids = specs.map((s) => s.id);
  const T = tally(files, ids);
  const lines: string[] = [];
  lines.push(`# ${title}: ${files.length} files`);
  lines.push(`hashes: ${specs.map((s) => `${s.id} ${s.c2 ? `chords2 ${chords2ConfigHash(s.c2)} + marks ${bassConfigHash(marksConfig())}` : s.bass ? `bass ${bassConfigHash(s.bass)}` : `chords2 ${chords2ConfigHash()}`}`).join(', ')}`);
  lines.push(`files per group: ${groups.map((g) => `${g} ${T.agg[`down|v1a|${g}`]?.files ?? 0}`).join(', ')}`);
  const per = (f: (r: string, g: string) => string): [string, string[]][] => ids.map((r) => [r, groups.map((g) => f(r, g))]);
  lines.push(table('名前の当たり 落（点 [区間 Wilson]）', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return `${f3(s.name.rate)} ${ci(s.name.wilson)}`; })));
  lines.push(table('/X の点のルート 落（点 [区間 Wilson]）', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return s.slashRoot.units ? `${f3(s.slashRoot.rate)} ${ci(s.slashRoot.wilson)}` : '-'; })));
  lines.push(table('分数 P / R 落', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return s.slash.truth ? `${f3(s.slash.p)} / ${f3(s.slash.r)}` : '-'; })));
  lines.push(table('誤った /X 落', [...groups], per((r, g) => f3(S(T, 'down', r, g).wrongSlash))));
  lines.push(table('手で直す数 / 100 拍 落（全部の手数）', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return `${f1(handEditsPer100(s))} (${f1(s.editsPer100)})`; })));
  lines.push(table('名前の当たり 全', [...groups], per((r, g) => f3(S(T, 'full', r, g).name.rate))));
  lines.push(table('基準（T8 形）と比べて直した / 壊した区間（名前 落）', [...groups], per((r, g) => { const x = T.fb[`${r}|${g}`]; return x ? `+${x.fixed} / −${x.broken} (${x.units})` : '-'; })));
  lines.push('\n### /X の点のルートのずれ（結果 − 正解、半音。点）');
  for (const g of groups.filter((g) => ['REC', 'B0-3', 'B', 'V1', 'B1'].includes(g))) for (const r of ids) lines.push(`- ${g} / ${r}: [${hist(T.conf[`${r}|${g}`]?.slashRootOffset ?? {})}]`);
  lines.push('\n### G1 の線（合成は同じ実行の開発用の基準の行と比べる）');
  for (const r of ids.filter((r) => !BASE_ROWS.some((b) => b.id === r) || r === 'bassG2')) {
    lines.push(`\n**${r}**`);
    for (const l of g1Lines(T, r)) lines.push(`- ${l.pass === null ? '–' : l.pass ? '○' : '×'} ${l.line}: ${l.value}（線 ${l.target}）`);
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  lines.push(`\nrow time per file, median ms: ${ids.map((r) => `${r} ${med(T.ms[r] ?? []).toFixed(1)}`).join(', ')}`);
  return lines.join('\n');
}

export const readCache = (dir: string): Cached[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => json<Cached>(join(dir, f))) : []);

/* ------------------------------------------------------------ tune */

const TUNE_DIR = join(OUT, 'tune');

function tuneRun(argv: string[]): void {
  const [k, n] = (argOf(argv, '--shard') ?? '0/1').split('/').map(Number);
  mkdirSync(TUNE_DIR, { recursive: true });
  const specs = gridRows();
  let done = 0;
  tuneItems().forEach((it, i) => {
    if (i % n !== k || existsSync(join(TUNE_DIR, `${it.name}.json`))) return;
    loadTruth(it, 'tuning');
    processItem(it, specs, TUNE_DIR);
    done++;
  });
  console.log(`shard ${k}/${n}: ${done} files`);
}

/** T7 consistency: the baseline rows recomputed here equal the T7 cache (v1a result + applyBass). */
function t7Check(cs: Cached[]): string {
  let n = 0;
  let bad = 0;
  const key = (xs: EvalChord[]) => JSON.stringify(xs.map((c) => [c.start, c.end, c.root, c.quality, c.bass ?? null]));
  for (const c of cs) {
    const p = join(ROOT, 'out', 'chords2-baseline', 'cache', `${c.name}.json`);
    if (!existsSync(p)) continue;
    const t7 = json<{ rows: Record<string, EvalChord[]> }>(p);
    for (const r of ['v1a', 'bassT8', 'bassG2']) {
      n++;
      if (key(t7.rows[r]) !== key(c.rows[r])) bad++;
    }
  }
  return `T7 cache check: ${n - bad}/${n} baseline rows identical`;
}

function tuneReport(): void {
  const its = new Map(tuneItems().map((i) => [i.name, i]));
  const cs = readCache(TUNE_DIR).filter((c) => its.has(c.name));
  const files = cs.map((c) => ({ c, t: loadTruth(its.get(c.name)!, 'tuning') }));
  const specs = gridRows();
  const T = tally(files, specs.map((s) => s.id));
  console.log(`# T8 tuning: ${files.length} files. ${t7Check(cs)}`);
  const cols = ['B', 'V1', 'B0-3', 'B1', 'B2', 'LR', 'Lpool'];
  const rows: [string, string[]][] = specs.map((s) => {
    const fb = T.fb[`${s.id}|SYN`];
    const x = (g: string) => S(T, 'down', s.id, g);
    return [s.id, [
      ...cols.map((g) => `${f3(x(g).name.rate)} / ${f3(x(g).slashRoot.rate)}`),
      f3(x('LR').wrongSlash),
      f1(handEditsPer100(x('SYN'))),
      fb ? `+${fb.fixed}/−${fb.broken}` : '-',
    ]];
  });
  console.log(table('調整用: 名前 落 / /X の点のルート（グループごと）、LR の誤った /X、手で直す数（SYN）、直した/壊した区間（SYN、基準と比べて）', [...cols, 'LR 誤/X', '手数 SYN', '直/壊'], rows));
  for (const s of specs.filter((s) => s.c2)) {
    const ls = g1Lines(T, s.id);
    console.log(`${s.id}: ${ls.filter((l) => l.pass).length}/${ls.filter((l) => l.pass !== null).length} lines; fails: ${ls.filter((l) => l.pass === false).map((l) => l.line.split(' ').slice(0, 2).join(' ')).join(', ')}`);
  }
}

/* ------------------------------------------------------------ look */

const LOOK_DIR = join(OUT, 'look');
const SYN_GROUPS = ['B', 'V1', 'V2', 'V3', 'pair', 'B0', 'B1', 'B2', 'B3', 'B0-3', 'SYN', 'LR', 'Lpool'];
const REC_GROUPS = ['a-d', 'e-f', 'g-j', 'REC'];

function lookWorker(argv: string[]): void {
  const list = json<Item[]>(argOf(argv, '--list')!);
  mkdirSync(LOOK_DIR, { recursive: true });
  for (const it of list) {
    loadTruth(it, it.kind === 'rec' || !L_POOL.has(it.level) && it.level !== 'LR' ? 'dev' : 'tuning');
    processItem(it, T8_ROWS, LOOK_DIR);
  }
}

/** Runs the items in `jobs` child processes (each `<script> look-worker`, default this file); resolves when all exit 0. */
export async function runJobs(items: Item[], jobs: number, self = fileURLToPath(import.meta.url), out = OUT): Promise<void> {
  mkdirSync(out, { recursive: true });
  await Promise.all(
    Array.from({ length: jobs }, (_, k) => {
      const list = join(out, `look-list-${k}.json`);
      writeFileSync(list, JSON.stringify(items.filter((_, i) => i % jobs === k)));
      return new Promise<void>((res, rej) => {
        const p = spawn('npx', ['tsx', self, 'look-worker', '--list', list], { stdio: 'inherit', cwd: ROOT });
        p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker ${k} exited ${code}`))));
      });
    }),
  );
}

function lookReport(title: string, items: Item[], dir: string): string {
  const byName = new Map(items.map((i) => [i.name, i]));
  const cs = readCache(dir).filter((c) => byName.has(c.name));
  const files = cs.map((c) => {
    const it = byName.get(c.name)!;
    return { c, t: loadTruth(it, it.kind === 'rec' || (!L_POOL.has(it.level) && it.level !== 'LR') ? 'dev' : 'tuning') };
  });
  const syn = report(`${title} — 合成（開発用 + L の見張り）`, files.filter((f) => f.c.kind === 'syn'), T8_ROWS, SYN_GROUPS);
  const rec = files.some((f) => f.c.kind === 'rec') ? report(`${title} — 録音（開発用）`, files.filter((f) => f.c.kind === 'rec'), T8_ROWS, REC_GROUPS) : '';
  // the G1 lines need both: one tally over everything (groups keep synthetic and recordings apart)
  const T = tally(files, T8_ROWS.map((s) => s.id));
  const g1 = ['\n## G1 の線（録音と合成の両方）', ...['M3', 'M1', 'M2', 'bassG2'].flatMap((r) => [`\n**${r}**`, ...g1Lines(T, r).map((l) => `- ${l.pass === null ? '–' : l.pass ? '○' : '×'} ${l.line}: ${l.value}（線 ${l.target}）`)])].join('\n');
  return [syn, rec, g1].join('\n\n');
}

function selftest(argv: string[]): void {
  const cb = committedBlock({ commit: commitArg(argv) ?? git(['rev-parse', 'HEAD']) ?? undefined, head: git(['rev-parse', 'HEAD']), porcelain: git(['status', '--porcelain']) });
  if (cb) console.log(`selftest note: ${cb} (a dry run on tuning files; the look itself refuses this)`);
  const pick = tuneItems().filter((i) => ['B', 'B1', 'B2', 'LR', 'L0', 'V1'].includes(i.level));
  const items = ['B', 'B1', 'B2', 'LR', 'L0', 'V1'].map((l) => pick.find((i) => i.level === l)!);
  const dir = join(OUT, 'selftest');
  mkdirSync(dir, { recursive: true });
  for (const it of items) {
    loadTruth(it, 'tuning');
    processItem(it, T8_ROWS, dir);
  }
  const byName = new Map(items.map((i) => [i.name, i]));
  const files = readCache(dir).filter((c) => byName.has(c.name)).map((c) => ({ c, t: loadTruth(byName.get(c.name)!, 'tuning') }));
  console.log(report('selftest (tuning synthetic, not a look)', files, T8_ROWS, ['B', 'B1', 'B2', 'LR', 'L0', 'V1', 'SYN']));
}

async function look(argv: string[]): Promise<void> {
  const jobs = Number(argOf(argv, '--jobs') ?? '6');
  const takes = devTakes(readRegistry());
  const syn = devSynItems();
  const hashes = [chords2ConfigHash(), ...T8_ROWS.filter((s) => s.c2).map((s) => chords2ConfigHash(s.c2)), bassConfigHash(bassT8()), bassConfigHash(bassG2()), bassConfigHash(marksConfig())];
  const { finish, line } = beginLook(
    { look: LOOK, task: TASK, reason: 'T8: look point 2 before G2 - method B (M3, M1 with the tuning-split values) against the baseline rows on the dev synthetic (+ L watch) and the dev recordings; no tuning after this', configHashes: hashes, takes, synthetic: { split: 'dev', files: syn.length } },
    commitArg(argv),
  );
  console.log(`look-start logged: ${line.look} ${line.task} commit ${line.commit?.slice(0, 7)} takes ${takes.length} synthetic ${syn.length}`);
  const items = [...syn, ...recItems(takes)];
  await runJobs(items, jobs);
  const text = lookReport(`T8 look ${LOOK}`, items, LOOK_DIR);
  console.log(text);
  writeFileSync(join(OUT, 'look-report.md'), text);
  finish();
  console.log('\nlook-done logged');
}

/* ------------------------------------------------------------ timing */

function timing(): void {
  const clips = tuneItems().filter((i) => i.level === 'B').slice(0, 3).map((it) => {
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    return prepareInput(toMono(w.channels), w.sampleRate, true).y;
  });
  for (const minutes of [1, 3, 5]) {
    const need = minutes * 60 * 22050;
    const y = new Float32Array(need);
    for (let o = 0, i = 0; o < need; i++) {
      const c = clips[i % clips.length].subarray(0, need - o);
      y.set(c, o);
      o += c.length;
    }
    const r = runFile(y, T8_ROWS);
    console.log(`${minutes} 分: ${Object.entries(r.ms).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const argv = [sub, ...rest].filter((x) => x !== undefined);
  if (cmd === 'tune' && sub === 'run') tuneRun(rest);
  else if (cmd === 'tune' && sub === 'report') tuneReport();
  else if (cmd === 'selftest') selftest(argv);
  else if (cmd === 'look') void look(argv).catch((e) => { console.error(e); process.exit(1); });
  else if (cmd === 'look-worker') lookWorker(argv);
  else if (cmd === 'timing') timing();
  else {
    console.error('usage: t8.ts tune run [--shard k/n] | tune report | selftest | look [--jobs N] | timing');
    process.exit(2);
  }
}
