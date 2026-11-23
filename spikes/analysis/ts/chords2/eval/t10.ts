/**
 * Spike 7 T10: vocabulary stage V1 (mM7, m6, 6; docs/audio-spike7-plan.md §2.2, §2.3, §5, G1; docs/audio-spike7-t10.md).
 * From spikes/analysis, in the devcontainer:
 *
 *   npx tsx ts/chords2/eval/t10.ts tune run [--shard k/n] [--round 1|2]   TUNING material only -> out/chords2-t10/tune<r>/
 *   npx tsx ts/chords2/eval/t10.ts tune report [--round 1|2]              the grid against the selection rule (tuning numbers)
 *   npx tsx ts/chords2/eval/t10.ts selftest                               the look pipeline on 6 tuning files (not a look)
 *   BAND_SHEETS_COMMIT=SHA npx tsx ts/chords2/eval/t10.ts look [--jobs N]  look point 3 ('dev-3', once)
 *   npx tsx ts/chords2/eval/t10.ts timing                                 1 / 3 / 5 minute inputs (Node)
 *
 * The adopted config before V1 (G2, user 2026-11-22) = chords2 V0 (= v1a) + spike 6's G2-default bass stage: row
 * `bassG2`, the regression base of every V1 line. A V1 config runs chords2 at V1 (pairRule off) -> the same G2 marks
 * (pipeline.ts marksOnV2) -> the pair rule after the marks (pairsAfterBass), each of 'off' / 'context' / 'bassRoot',
 * and the "new qualities as candidates only" output of both rules (asCandidatesOnly). Baseline rows v1a / bassT8 / bassG2
 * are computed in the same run. Every file goes through prepareInput (RMS -22 dBFS). Held-out is never listed (t8.ts
 * material: every manifest / truth / registry flag is checked before a file is opened). Output: aggregates only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bassChords } from '../../bass/analyze';
import { bassConfigHash } from '../../bass/config';
import { argOf, at } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import { decodeWav } from '../../browser/wav';
import { MemTracker } from '../../dsp/core/mem';
import { toMono } from '../../dsp/core/resample';
import { colKeys } from '../../dsp/harmony';
import { analyze as analyze2 } from '../analyze';
import { chords2ConfigHash, resolveChords2Config, T10_V1_OVERRIDES, type Chords2Config, type NewSeventh } from '../config';
import { asCandidatesOnly, marksOnV2, pairsAfterBass } from '../pipeline';
import { newQualities, STAGE_ADDS } from '../vocab';
import { addFile, newAgg, type Agg } from './baselineAgg';
import { bassG2, bassT8, f1, f3, items as tuningItems, slim, table, v2Config } from './baseline';
import { frontEnd, toEvalChords } from './frontEnd';
import { handEditsLines, hasGroup, leLine, summaryOf as S, wrongSlashLines, type Line } from './g1Common';
import { choosePairRule, fixedBroken, handEditsPer100, newQualityOutput, seventhAsTriad } from './gate';
import { beginLook, commitArg, committedBlock, git, readRegistry, ROOT } from './guard';
import { prepareInput } from './input';
import { bassOnlyReading, pairUnits, readingOf, sameReading, scorePairs, soundOnlyReading, type PairItem } from './pairs';
import { devTakes } from './r2';
import { editCounts, scoreChords, truthQuality, type EvalChord } from './score';
import { devSynItems, groupsOf, L_POOL, loadTruth, readCache, recItems, runJobs, type Item, type Truth } from './t8';

const OUT = join(ROOT, 'out', 'chords2-t10');
export const LOOK = 'dev-3' as const;
export const TASK = 'T10';
const V1Q = newQualities('V1'); // mM7, m6, 6
const RULES = ['context', 'bassRoot'] as const;

/* ------------------------------------------------------------ configs and rows */

export interface V1Cfg {
  key: string;
  cfg: Chords2Config;
}
export const v1Config = (margin: number, newSeventh?: NewSeventh): Chords2Config =>
  resolveChords2Config({ stage: 'V1', newQualityMargin: margin, ...(newSeventh ? { newSeventh } : {}) });

/**
 * The config of a pair-rule row, for its hash only: runFile runs analyze() with pairRule 'off' and applies the rule in
 * `pairsAfterBass`, so the hash of the config alone says nothing about the rule. With this the hash of the row does.
 * 'off' is the config itself (same hash as before T17); 'context' / 'bassRoot' have their own.
 */
export const rowConfig = (cfg: Chords2Config, rule: 'off' | (typeof RULES)[number]): Chords2Config => ({ ...cfg, pairRule: rule });

/** The row ids of one V1 config (the pair rule after the marks, and candidates-only of both rules). */
export const v1RowIds = (key: string): string[] => [`${key}|off`, ...RULES.flatMap((r) => [`${key}|${r}`, `${key}|${r}|cand`])];

/**
 * Tuning grids, fixed before any tuning number was read (docs/audio-spike7-t10.md「調整」). A diagnostic on three tuning
 * V1 files (before the grid) showed the new states blocked by both guards: the clear-win margin (T3 provisional .05)
 * and v1a's 7th guard (x .98 >= best triad), which also keeps most of v1a's own sevenths out on the mixes with a bass.
 * Round 1 crosses both (v1a's own 7th guard is not changed: G1 decision 10). Round 2 (the plan allows two) was not run:
 * round 1 left no value near the V1 lines (config.ts T10_V1_OVERRIDES).
 */
export const SEVENTH_GRID: (NewSeventh | undefined)[] = [undefined, { weight: 1.0, margin: 0 }, { weight: 1.02, margin: 0 }, { weight: 1.05, margin: 0 }, { weight: 1.0, margin: -0.02 }];
export function grid(round: number): V1Cfg[] {
  if (round !== 1) throw new Error(`no grid for round ${round} yet`);
  const out: V1Cfg[] = [];
  for (const m of [-0.05, -0.025, 0, 0.025, 0.05, 0.1])
    for (const sv of SEVENTH_GRID) out.push({ key: `mg${m}${sv ? ` sw${sv.weight} sm${sv.margin}` : ''}`, cfg: v1Config(m, sv) });
  return out;
}

/** The V1 values the look runs (chosen on the tuning split: config.ts T10_V1_OVERRIDES). */
export const TUNED: V1Cfg = { key: 'V1', cfg: resolveChords2Config(T10_V1_OVERRIDES) };

export interface FileRows {
  rows: Record<string, EvalChord[]>;
  ms: Record<string, number>;
}

/** Every row on one prepared signal (not changed). */
export function runFile(y: Float32Array, cfgs: readonly V1Cfg[]): FileRows {
  const now = () => performance.now();
  let t = now();
  const fe = frontEnd(y.slice());
  const ms: Record<string, number> = { front: now() - t };
  const g2 = bassG2();
  t = now();
  const low = lowCqt(y, g2.lowCqt);
  ms.lowCqt = now() - t;
  const beats = Array.from(fe.times);
  const beatKeys = colKeys(fe.input.barKeys, fe.input.barOfBeat);
  const timed = (c: Chords2Config) => toEvalChords(analyze2({ ...fe.input, mem: new MemTracker() }, c).segments, fe.times, fe.duration).map((x) => ({ ...x, bass: x.bass ?? null }));
  t = now();
  const v0 = timed(v2Config('V0'));
  ms['V0|chords'] = now() - t;
  const rows: Record<string, EvalChord[]> = { v1a: v0 };
  t = now();
  rows.bassG2 = slim(bassChords(low, v0, beats, g2));
  ms.bassG2 = now() - t;
  rows.bassT8 = slim(bassChords(low, v0, beats, bassT8()));
  for (const { key, cfg } of cfgs) {
    t = now();
    const segs = timed(cfg);
    ms[`${key}|chords`] = now() - t;
    t = now();
    const marked = slim(marksOnV2(low, segs, beats, g2)).map((x) => ({ ...x, bass: x.bass ?? null }));
    ms[`${key}|marks`] = now() - t;
    rows[`${key}|off`] = marked;
    for (const rule of RULES) {
      t = now();
      const p = slim(pairsAfterBass(low, marked, beats, beatKeys, g2, rule, cfg.stage));
      ms[`${key}|${rule}`] = now() - t;
      rows[`${key}|${rule}`] = p;
      rows[`${key}|${rule}|cand`] = slim(asCandidatesOnly(p.map((x) => ({ ...x, bass: x.bass ?? null })), cfg.stage));
    }
  }
  return { rows, ms };
}

/* ------------------------------------------------------------ material */

interface PairRow {
  id: string;
  truth: string;
  conflict: boolean;
}
type T10Truth = Truth & { chords2?: { segments?: { start: number; end: number; rows?: PairRow[] }[] } };
interface Cached extends FileRows {
  name: string;
  level: string;
  kind: 'syn' | 'rec';
}

/** Tuning material: every T7 tuning file (B, V1-V3, pair, B0-B3, the L sets). */
const tuneItems = (): Item[] => tuningItems().map((i) => ({ name: i.name, level: i.level, kind: 'syn' as const, wav: i.wav, truth: i.truth }));
const splitOf = (it: Pick<Item, 'kind' | 'level'>, tuning: boolean): 'tuning' | 'dev' => (tuning || (it.kind === 'syn' && (L_POOL.has(it.level) || it.level === 'LR')) ? 'tuning' : 'dev');

function processItem(it: Item, cfgs: readonly V1Cfg[], dir: string): void {
  const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
  const r = runFile(prepareInput(toMono(w.channels), w.sampleRate, true).y, cfgs);
  writeFileSync(join(dir, `${it.name}.json`), JSON.stringify({ name: it.name, level: it.level, kind: it.kind, ...r }));
}

/* ------------------------------------------------------------ aggregation */

const V0Q = new Set<string>(STAGE_ADDS.V0);
/** Truth without any quality outside v1a's vocabulary (the a-f-like files for the false-output watch). */
const noNewQuality = (t: Truth): boolean => t.chords.every((c) => {
  const q = truthQuality(c, 'full');
  return q === null || q === '5' || V0Q.has(q);
});
/** Groups of a file: t8's, plus a-f (spike 6 takes) and noNew (synthetic without new qualities). */
const groupsT10 = (c: Pick<Cached, 'level' | 'kind'>, t: Truth): string[] => [
  ...groupsOf(c),
  ...(c.kind === 'rec' && (c.level === 'a-d' || c.level === 'e-f') ? ['a-f'] : []),
  ...(c.kind === 'syn' && noNewQuality(t) ? ['noNew'] : []),
];

interface Count {
  a: number;
  b: number;
  n: number;
}
export interface Tally {
  agg: Record<string, Agg>; // `${vocab}|${row}|${group}`
  fb: Record<string, Count>; // `${vocab}|${row}|${group}` fixed a / broken b / units n vs bassG2
  sev: Record<string, Count>; // `${row}|${group}`: 7 -> maj a, min7 -> min b
  nq: Record<string, Count>; // `${row}|${group}`: new-quality points a over scored points n
  pairs: Record<string, PairItem[]>; // `${row}|${subset}` subset all | pair (read as a pair by the off row)
}

const add = (o: Record<string, Count>, k: string, a: number, b: number, n: number) => {
  const x = (o[k] ??= { a: 0, b: 0, n: 0 });
  x.a += a;
  x.b += b;
  x.n += n;
};

export function tally(files: { c: Cached; t: T10Truth }[], rowIds: readonly string[], offRowFor: (row: string) => string | null): Tally {
  const T: Tally = { agg: {}, fb: {}, sev: {}, nq: {}, pairs: {} };
  for (const { c, t } of files) {
    const gs = groupsT10(c, t);
    for (const row of rowIds) {
      const res = c.rows[row];
      if (!res) throw new Error(`${c.name}: no row ${row}`);
      for (const v of ['full', 'down'] as const) {
        const s = scoreChords(t.chords, res, t.beats, v);
        const e = editCounts(t.chords, res, t.beats, v);
        const fb = row === 'bassG2' ? null : fixedBroken(t.chords, c.rows.bassG2, res, t.beats, v);
        for (const g of gs) {
          addFile((T.agg[`${v}|${row}|${g}`] ??= newAgg()), s, e);
          if (fb) add(T.fb, `${v}|${row}|${g}`, fb.fixed, fb.broken, fb.units);
        }
      }
      const sv = seventhAsTriad(t.chords, res, t.beats);
      const nq = newQualityOutput(t.chords, res, t.beats, 'V1');
      for (const g of gs) {
        add(T.sev, `${row}|${g}`, sv.d7AsMaj, sv.m7AsMin, 0);
        add(T.nq, `${row}|${g}`, nq.points, 0, nq.n);
      }
      // identical pairs (plan §2.3, synthetic truth-table rows; V1 pairs only: sus2 / sus4 exist from V2)
      const off = offRowFor(row);
      if (c.kind !== 'syn' || !off) continue;
      for (const u of pairUnits(t.chords2?.segments)) {
        if (!u.pair || u.truth.quality.startsWith('sus')) continue;
        const base = { id: u.id, conflict: u.conflict, truth: u.truth };
        const offR = readingOf(at(c.rows[off], u.mid));
        const subsets = sameReading(offR, u.pair[0]) || sameReading(offR, u.pair[1]) ? ['all', 'pair'] : ['all'];
        for (const sub of subsets) {
          (T.pairs[`${row}|${sub}`] ??= []).push({ ...base, got: readingOf(at(res, u.mid)) });
          if (row === off) {
            // references (plan §2.3; pairs.ts), once per config: <key>|soundOnly, <key>|bassOnlyTrue
            const key = off.split('|')[0];
            (T.pairs[`${key}|soundOnly|${sub}`] ??= []).push({ ...base, got: soundOnlyReading(u.pair) });
            (T.pairs[`${key}|bassOnlyTrue|${sub}`] ??= []).push({ ...base, got: bassOnlyReading(u.pair, u.trueBass) });
          }
        }
      }
    }
  }
  return T;
}
const has = hasGroup;

/** Recall / precision (root + quality, full vocabulary; bassOnly points left out) of the V1 qualities, pooled or one. */
export function newQualityPR(T: Tally, row: string, g: string, qs: readonly string[] = V1Q): { recall: number | null; precision: number | null; tn: number; rn: number } {
  const bq = T.agg[`full|${row}|${g}`]?.byQuality ?? {};
  let th = 0, tn = 0, rh = 0, rn = 0;
  for (const q of qs) {
    th += bq[q]?.t.hit ?? 0;
    tn += bq[q]?.t.n ?? 0;
    rh += bq[q]?.r.hit ?? 0;
    rn += bq[q]?.r.n ?? 0;
  }
  return { recall: tn ? th / tn : null, precision: rn ? rh / rn : null, tn, rn };
}
const nqRate = (T: Tally, row: string, g: string): number | null => {
  const x = T.nq[`${row}|${g}`];
  return x && x.n ? x.a / x.n : null;
};
const pairScore = (T: Tally, row: string, sub = 'all') => scorePairs(T.pairs[`${row}|${sub}`] ?? []);

/** The G1 lines for a V1 row (plan「G1 の決定」, §5): regression vs the adopted config (bassG2) of the same run. */
export function g1LinesV1(T: Tally, row: string, pairRule: 'context' | 'bassRoot' | null): Line[] {
  const out: Line[] = [];
  const d = (g: string) => S(T, 'down', row, g);
  const g2 = (g: string) => S(T, 'down', 'bassG2', g);
  const reg = (line: string, x: number | null, base: number | null, target: number, stop: number) => {
    if (x === null || base === null) return out.push({ line, value: f3(x), target: '-', pass: null });
    const diff = x - base;
    out.push({ line, value: `${f3(x)}（差 ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}）`, target: `≥ ${f3(base - target)}`, pass: diff >= -target - 1e-9, user: diff < -target - 1e-9 && diff >= -stop - 1e-9 });
  };
  if (has(T, row, 'LR')) reg('4 後戻り LR 名前 落（採った設定 −.01）', d('LR').name.rate, g2('LR').name.rate, 0.01, 0.02);
  if (has(T, row, 'Lpool')) reg('4 後戻り L0〜L3・LV 名前 落（採った設定 −.01）', d('Lpool').name.rate, g2('Lpool').name.rate, 0.01, 0.02);
  if (has(T, row, 'REC')) reg('4 後戻り 録音 ALL 名前 落（採った設定 −.02）', d('REC').name.rate, g2('REC').name.rate, 0.02, 0.02);
  out.push(...wrongSlashLines(T, row));
  out.push(...handEditsLines(T, row, { vocab: 'full', base: 'bassG2', vocabLabel: '全', synLabel: '合成 SYN', baseLabel: '採った設定' }));
  if (has(T, row, 'SYN')) {
    const pr = newQualityPR(T, row, 'SYN');
    out.push({ line: '6 新しい種類の再現率 合成 SYN（mM7・m6・6 をまとめて）', value: f3(pr.recall), target: '≥ .600', pass: pr.recall === null ? null : pr.recall >= 0.6 });
    out.push({ line: '6 新しい種類の適合率 合成 SYN（G3 の決め手）', value: `${f3(pr.precision)}（出した点 ${pr.rn}）`, target: '≥ .800', pass: pr.precision === null ? false : pr.precision >= 0.8 });
  }
  if (has(T, row, 'a-f')) out.push(leLine('6 a〜f で新しい種類を出した点', nqRate(T, row, 'a-f'), 0.02));
  if (pairRule) {
    const p = pairScore(T, row);
    const br = pairScore(T, row.replace(/\|context(\|cand)?$/, '|bassRoot$1'));
    if (p.conflict.n) out.push({ line: '6 音が同じ組 食い違う例（合成）', value: `${p.conflict.hit}/${p.conflict.n} = ${f3(p.conflict.rate)}`, target: '≥ .500', pass: (p.conflict.rate ?? 0) >= 0.5 });
    if (p.all.n) out.push({ line: '6 音が同じ組 全体が bassRoot 以上（合成）', value: `${p.all.hit}/${p.all.n} = ${f3(p.all.rate)}`, target: `≥ ${f3(br.all.rate)}`, pass: (p.all.rate ?? 0) >= (br.all.rate ?? 0) - 1e-9 });
  }
  return out;
}

const mark = (l: Line) => (l.pass === null ? '–' : l.pass ? '○' : l.user ? '△' : '×');
const fmtLines = (ls: Line[]) => ls.map((l) => `- ${mark(l)} ${l.line}: ${l.value}（線 ${l.target}）`).join('\n');

/* ------------------------------------------------------------ tune */

const tuneDir = (round: number) => join(OUT, `tune${round}`);
const offOf = (row: string): string | null => (row.includes('|') ? `${row.split('|')[0]}|off` : null);

function tuneRun(argv: string[]): void {
  const round = Number(argOf(argv, '--round') ?? '1');
  const [k, n] = (argOf(argv, '--shard') ?? '0/1').split('/').map(Number);
  const dir = tuneDir(round);
  mkdirSync(dir, { recursive: true });
  let done = 0;
  tuneItems().forEach((it, i) => {
    if (i % n !== k || existsSync(join(dir, `${it.name}.json`))) return;
    loadTruth(it, 'tuning');
    processItem(it, grid(round), dir);
    done++;
  });
  console.log(`round ${round} shard ${k}/${n}: ${done} files`);
}

/**
 * The selection rule (fixed before the tuning numbers were read), on the `bassRoot` rows of the tuning split:
 *  1. regression: LR and L0-L3/LV name (落) >= bassG2 - .01;  2. new-quality output on synthetic without new qualities
 *  <= 2 %;  3. most of {pooled V1 recall >= .60, pooled precision >= .80} (SYN);  4. higher precision;  5. higher recall;
 *  6. fewer hand edits (全, SYN). No value passing 1-2 -> none is chosen (stop / candidates-only path, plan §5).
 */
export function rank(T: Tally, keys: readonly string[]): { key: string; ok: boolean; lines: number; precision: number; recall: number; hand: number }[] {
  const lr0 = S(T, 'down', 'bassG2', 'LR').name.rate ?? 0;
  const lp0 = S(T, 'down', 'bassG2', 'Lpool').name.rate ?? 0;
  return keys
    .map((key) => {
      const row = `${key}|bassRoot`;
      const pr = newQualityPR(T, row, 'SYN');
      const ok = (S(T, 'down', row, 'LR').name.rate ?? 0) >= lr0 - 0.01 - 1e-9 && (S(T, 'down', row, 'Lpool').name.rate ?? 0) >= lp0 - 0.01 - 1e-9 && (nqRate(T, row, 'noNew') ?? 0) <= 0.02 + 1e-9;
      const precision = pr.precision ?? -1;
      const recall = pr.recall ?? -1;
      return { key, ok, lines: Number(recall >= 0.6) + Number(precision >= 0.8), precision, recall, hand: handEditsPer100(S(T, 'full', row, 'SYN')) ?? Infinity };
    })
    .sort((a, b) => Number(b.ok) - Number(a.ok) || b.lines - a.lines || b.precision - a.precision || b.recall - a.recall || a.hand - b.hand);
}

function tuneReport(argv: string[]): void {
  const round = Number(argOf(argv, '--round') ?? '1');
  const its = new Map(tuneItems().map((i) => [i.name, i]));
  const cs = readCache(tuneDir(round)) as unknown as Cached[];
  const files = cs.filter((c) => its.has(c.name)).map((c) => ({ c, t: loadTruth(its.get(c.name)!, 'tuning') as T10Truth }));
  const cfgs = grid(round);
  const rowIds = ['bassG2', ...cfgs.flatMap((c) => [`${c.key}|off`, ...RULES.map((r) => `${c.key}|${r}`)])];
  const T = tally(files, rowIds, offOf);
  const lines: string[] = [`# T10 tuning round ${round}: ${files.length} files (no-new-quality synthetic ${T.agg['down|bassG2|noNew']?.files ?? 0})`];
  const cols = ['LR 落', 'Lpool 落', 'noNew 新', 'R 全体', 'P 全体', ...V1Q.map((q) => `${q} R/P`), '手数 全 SYN', '直/壊 全 SYN', '組 食い違う ctx / br', '組 全体 ctx / br', '7→maj・m7→m SYN'];
  const rowOf = (key: string, row: string): [string, string[]] => {
    const pr = newQualityPR(T, row, 'SYN');
    const fb = T.fb[`full|${row}|SYN`];
    const sv = T.sev[`${row}|SYN`];
    const pc = pairScore(T, `${key}|context`);
    const pb = pairScore(T, `${key}|bassRoot`);
    return [row, [
      f3(S(T, 'down', row, 'LR').name.rate), f3(S(T, 'down', row, 'Lpool').name.rate), f3(nqRate(T, row, 'noNew')), f3(pr.recall), `${f3(pr.precision)} (${pr.rn})`,
      ...V1Q.map((q) => { const x = newQualityPR(T, row, 'SYN', [q]); return `${f3(x.recall)} / ${f3(x.precision)}`; }),
      f1(handEditsPer100(S(T, 'full', row, 'SYN'))), fb ? `+${fb.a}/−${fb.b}` : '-',
      `${pc.conflict.hit}/${pb.conflict.hit} (${pb.conflict.n})`, `${pc.all.hit}/${pb.all.hit} (${pb.all.n})`, sv ? `${sv.a} / ${sv.b}` : '-',
    ]];
  };
  const rows: [string, string[]][] = [rowOf('', 'bassG2'), ...cfgs.flatMap((c) => [`${c.key}|off`, `${c.key}|bassRoot`, `${c.key}|context`].map((r) => rowOf(c.key, r)))];
  lines.push(table('調整用（行ごと。R/P = 再現率 / 適合率、新しい種類は mM7・m6・6、組は当たった数 context / bassRoot（行の数））', cols, rows));
  lines.push(`\nbassG2 SYN hand edits 全 ${f1(handEditsPer100(S(T, 'full', 'bassG2', 'SYN')))}`);
  lines.push('\n## 選び方（表を読む前に決めた）の順');
  for (const r of rank(T, cfgs.map((c) => c.key))) lines.push(`- ${r.key}: 1-2 ${r.ok ? '○' : '×'}, lines ${r.lines}, P ${f3(r.precision)}, R ${f3(r.recall)}, hand ${f1(r.hand)}`);
  const text = lines.join('\n');
  console.log(text);
  writeFileSync(join(OUT, `tune${round}-report.md`), text);
}

/* ------------------------------------------------------------ look */

const LOOK_DIR = join(OUT, 'look');
const SYN_GROUPS = ['B', 'V1', 'V2', 'V3', 'pair', 'B0-3', 'B1', 'SYN', 'noNew', 'LR', 'Lpool'];
const REC_GROUPS = ['a-d', 'e-f', 'g-j', 'a-f', 'REC'];
const LOOK_ROWS = ['v1a', 'bassT8', 'bassG2', ...v1RowIds(TUNED.key)];

function lookWorker(argv: string[]): void {
  const list = JSON.parse(readFileSync(argOf(argv, '--list')!, 'utf8')) as Item[];
  mkdirSync(LOOK_DIR, { recursive: true });
  for (const it of list) {
    loadTruth(it, splitOf(it, false));
    processItem(it, [TUNED], LOOK_DIR);
  }
}

const ruleOf = (row: string): 'context' | 'bassRoot' | null => (row.includes('|context') ? 'context' : row.includes('|bassRoot') ? 'bassRoot' : null);

function report(title: string, files: { c: Cached; t: T10Truth }[], rowIds: readonly string[], groups: readonly string[]): { text: string; T: Tally } {
  const T = tally(files, rowIds, offOf);
  const L: string[] = [`# ${title}: ${files.length} files`];
  L.push(`files per group: ${groups.map((g) => `${g} ${T.agg[`down|bassG2|${g}`]?.files ?? 0}`).join(', ')}`);
  const per = (f: (r: string, g: string) => string): [string, string[]][] => rowIds.map((r) => [r, groups.map((g) => f(r, g))]);
  L.push(table('名前の当たり 落（点 [区間 Wilson]）', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return `${f3(s.name.rate)} ${s.name.wilson ? `[${f3(s.name.wilson.lo)}-${f3(s.name.wilson.hi)}]` : ''}`; })));
  L.push(table('名前の当たり 全', [...groups], per((r, g) => f3(S(T, 'full', r, g).name.rate))));
  L.push(table('/X の点のルート 落', [...groups], per((r, g) => { const s = S(T, 'down', r, g); return s.slashRoot.units ? f3(s.slashRoot.rate) : '-'; })));
  L.push(table('誤った /X 落', [...groups], per((r, g) => f3(S(T, 'down', r, g).wrongSlash))));
  L.push(table('手で直す数 / 100 拍 全（落）', [...groups], per((r, g) => `${f1(handEditsPer100(S(T, 'full', r, g)))} (${f1(handEditsPer100(S(T, 'down', r, g)))})`)));
  L.push(table('bassG2 と比べて直した / 壊した区間 全（落）', [...groups], per((r, g) => { const a = T.fb[`full|${r}|${g}`]; const b = T.fb[`down|${r}|${g}`]; return a && b ? `+${a.a}/−${a.b} (+${b.a}/−${b.b})` : '-'; })));
  L.push(table('7th を 3 和音に読んだ点（7→maj / m7→m、全、ルートが合った点）', [...groups], per((r, g) => { const x = T.sev[`${r}|${g}`]; return x ? `${x.a} / ${x.b}` : '-'; })));
  L.push(table('新しい種類（mM7・m6・6）を出した点の割合（全）', [...groups], per((r, g) => f3(nqRate(T, r, g)))));
  L.push(table('新しい種類の再現率 / 適合率（全、ベースにだけある音の点を除く）', ['まとめて', ...V1Q], rowIds.map((r) => [r, ['', ...V1Q].map((q) => { const x = newQualityPR(T, r, 'SYN', q ? [q] : V1Q); return `${f3(x.recall)} / ${f3(x.precision)} (${x.tn} / ${x.rn})`; })])));
  if (files.some((f) => f.c.kind === 'syn')) {
    const cell = (u: { hit: number; n: number; rate: number | null }) => (u.n ? `${u.hit}/${u.n} = ${f3(u.rate)}` : '-');
    const prow = [...v1RowIds(TUNED.key), `${TUNED.key}|soundOnly`, `${TUNED.key}|bassOnlyTrue`];
    for (const sub of ['all', 'pair'])
      L.push(table(`音が同じ組（合成の正解表の行、V1 の組。${sub === 'all' ? '全部の行' : '組として読めた区間だけ'}）`, ['食い違う例', '食い違わない例', '全体'], prow.map((r) => { const p = pairScore(T, r, sub); return [r, [cell(p.conflict), cell(p.nonConflict), cell(p.all)]]; })));
  }
  return { text: L.join('\n'), T };
}

function lookReport(items: Item[], dir: string): string {
  const byName = new Map(items.map((i) => [i.name, i]));
  const cs = (readCache(dir) as unknown as Cached[]).filter((c) => byName.has(c.name));
  const files = cs.map((c) => ({ c, t: loadTruth(byName.get(c.name)!, splitOf(byName.get(c.name)!, false)) as T10Truth }));
  const syn = report(`T10 ${LOOK} — 合成（開発用 + L の見張り）`, files.filter((f) => f.c.kind === 'syn'), LOOK_ROWS, SYN_GROUPS);
  const rec = report(`T10 ${LOOK} — 録音（開発用）`, files.filter((f) => f.c.kind === 'rec'), LOOK_ROWS, REC_GROUPS);
  const T = tally(files, LOOK_ROWS, offOf);
  const out = [syn.text, rec.text, '\n## G1 の線（V1。基準 = 採った設定 bassG2、同じ実行。△ = −.01〜−.02 でユーザーが決める）'];
  for (const r of v1RowIds(TUNED.key)) out.push(`\n**${r}**\n${fmtLines(g1LinesV1(T, r, ruleOf(r)))}`);
  const pc = pairScore(T, `${TUNED.key}|context`).conflict.hit;
  const pb = pairScore(T, `${TUNED.key}|bassRoot`).conflict.hit;
  out.push(`\n## G3 の組の規則（G1 で先に決めた選び方）: 食い違う例の当たり context ${pc}、bassRoot ${pb}、差 ${pc - pb} → ${choosePairRule(pc, pb)}`);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const msKeys = [...new Set(files.flatMap((f) => Object.keys(f.c.ms)))];
  out.push(`\nstage time per file, median ms (runFile's own names): ${msKeys.map((k) => `${k} ${med(files.map((f) => f.c.ms[k] ?? 0)).toFixed(1)}`).join(', ')}`);
  return out.join('\n');
}

function selftest(argv: string[]): void {
  const cb = committedBlock({ commit: commitArg(argv) ?? git(['rev-parse', 'HEAD']) ?? undefined, head: git(['rev-parse', 'HEAD']), porcelain: git(['status', '--porcelain']) });
  if (cb) console.log(`selftest note: ${cb} (a dry run on tuning files; the look itself refuses this)`);
  const levels = ['B', 'B1', 'LR', 'L0', 'V1', 'pair'];
  const items = levels.map((l) => tuneItems().find((i) => i.level === l)!);
  const dir = join(OUT, 'selftest');
  mkdirSync(dir, { recursive: true });
  for (const it of items) {
    loadTruth(it, 'tuning');
    processItem(it, [TUNED], dir);
  }
  const byName = new Map(items.map((i) => [i.name, i]));
  const files = (readCache(dir) as unknown as Cached[]).filter((c) => byName.has(c.name)).map((c) => ({ c, t: loadTruth(byName.get(c.name)!, 'tuning') as T10Truth }));
  const { text, T } = report('selftest (tuning synthetic, not a look)', files, LOOK_ROWS, [...levels, 'SYN']);
  console.log(text);
  for (const r of v1RowIds(TUNED.key)) console.log(`\n${r}\n${fmtLines(g1LinesV1(T, r, ruleOf(r)))}`);
}

async function look(argv: string[]): Promise<void> {
  const jobs = Number(argOf(argv, '--jobs') ?? '6');
  const takes = devTakes(readRegistry());
  const syn = devSynItems();
  const hashes = [chords2ConfigHash(), ...(['off', ...RULES] as const).map((r) => chords2ConfigHash(rowConfig(TUNED.cfg, r))), bassConfigHash(bassT8()), bassConfigHash(bassG2())];
  const { finish, line } = beginLook(
    {
      look: LOOK,
      task: TASK,
      reason: `T10: look point 3 before G3 - vocabulary V1 (chords2 V1 ${chords2ConfigHash(TUNED.cfg)}, tuning-split values) + the G2 bass marks + the pair rule after the marks (off / context / bassRoot) + new qualities as candidates only, against the baseline rows v1a / bassT8 / bassG2 (the adopted config) on the dev synthetic (+ L watch) and the dev recordings; no tuning after this`,
      configHashes: hashes,
      takes,
      synthetic: { split: 'dev', files: syn.length },
    },
    commitArg(argv),
  );
  console.log(`look-start logged: ${line.look} ${line.task} commit ${line.commit?.slice(0, 7)} takes ${takes.length} synthetic ${syn.length}`);
  const items = [...syn, ...recItems(takes)];
  await runJobs(items, jobs, fileURLToPath(import.meta.url), OUT);
  const text = lookReport(items, LOOK_DIR);
  console.log(text);
  writeFileSync(join(OUT, 'look-report.md'), text);
  finish();
  console.log('\nlook-done logged');
}

/* ------------------------------------------------------------ timing */

function timing(): void {
  const clips = tuneItems().filter((i) => i.level === 'V1').slice(0, 3).map((it) => {
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
    const r = runFile(y, [TUNED]);
    console.log(`${minutes} 分: ${Object.entries(r.ms).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const argv = [sub, ...rest].filter((x) => x !== undefined);
  if (cmd === 'tune' && sub === 'run') tuneRun(rest);
  else if (cmd === 'tune' && sub === 'report') tuneReport(rest);
  else if (cmd === 'selftest') selftest(argv);
  else if (cmd === 'look') void look(argv).catch((e) => { console.error(e); process.exit(1); });
  else if (cmd === 'look-worker') lookWorker(argv);
  else if (cmd === 'timing') timing();
  else {
    console.error('usage: t10.ts tune run [--shard k/n] [--round r] | tune report [--round r] | selftest | look [--jobs N] | timing');
    process.exit(2);
  }
}
