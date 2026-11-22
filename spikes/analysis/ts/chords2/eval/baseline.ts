/**
 * Spike 7 T7: baseline of v1a, v1a + bass and chords2 (V0-V3, everything else off) on TUNING material only
 * (docs/audio-spike7-plan.md §5, docs/audio-spike7-t7.md). From spikes/analysis, in the devcontainer:
 *
 *   npx tsx ts/chords2/eval/baseline.ts run [--shard k/n] [--set chords2|spike6|spike0]   per-file results -> out/chords2-baseline/cache
 *   npx tsx ts/chords2/eval/baseline.ts report [--json out/chords2-baseline/baseline.json]  tables from the cache
 *   npx tsx ts/chords2/eval/baseline.ts timing                                                1 / 3 / 5 minute inputs (Node)
 *
 * Material (nothing else is opened; no dev / held-out file, no beginLook): out/chords2 variants with split 'tuning'
 * (names c2-t-*), out/bass variants with split 'tuning' (spike 6 B0-B3), out/spike0 variants with heldOut false (spike 0/2
 * L0-L3, LR, V; the held-out etudes are in that folder too but never read: the manifest flag is checked before a file is
 * opened). Every file goes through prepareInput with loudness normalization (RMS -22 dBFS). Rows: v1a = the frozen
 * ts/dsp analyze; bassT8 / bassG2 = applyBass on that result (T8-equivalent / G2 default config); V0-V3 = chords2 on the
 * same beats / chroma / keys with stage V0-V3 and every B / pair switch off. v0Same checks V0 == v1a chord for chord.
 * Output: aggregates only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inspector from 'node:inspector';
import { decodeWav } from '../../browser/wav';
import { analyze as analyzeV1 } from '../../dsp/analyze';
import { toMono } from '../../dsp/core/resample';
import { MemTracker } from '../../dsp/core/mem';
import { applyBass } from '../../bass/analyze';
import { bassConfigHash, enabledBassConfig, type BassConfig } from '../../bass/config';
import { argOf, at, json } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import { noteToPc, type ScoreBeat } from '../../bass/score';
import { analyze as analyze2 } from '../analyze';
import { chords2ConfigHash, resolveChords2Config } from '../config';
import { newQualities, suffix, type Stage } from '../vocab';
import { addConfusion, addFile, newAgg, newConfusion, summarize, type Agg, type Confusion } from './baselineAgg';
import { frontEnd, toEvalChords } from './frontEnd';
import { prepareInput } from './input';
import { bassOnlyReading, pairReadings, parseReading, scorePairs, soundOnlyReading, type PairItem, type Reading } from './pairs';
import { editCounts, scoreChords, type EvalChord, type Vocab } from './score';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE = join(ROOT, 'out', 'chords2-baseline', 'cache');

export const T8EQ_OVERRIDES = { slash: { weakMinConfidence: 0 }, cliche: { split: false, redecideRoot: false } };
export const bassT8 = (): BassConfig => enabledBassConfig(T8EQ_OVERRIDES);
export const bassG2 = (): BassConfig => enabledBassConfig();
export const STAGES: readonly Stage[] = ['V0', 'V1', 'V2', 'V3'];
export const ROWS = ['v1a', 'bassT8', 'bassG2', 'V0', 'V1', 'V2', 'V3'] as const;
export type RowId = (typeof ROWS)[number];
export const ROW_LABEL: Record<RowId, string> = { v1a: 'v1a (凍結)', bassT8: 'v1a+ベース (T8 形・基準)', bassG2: 'v1a+ベース (G2 既定・参考)', V0: 'v2 V0', V1: 'v2 V1', V2: 'v2 V2', V3: 'v2 V3' };
export const v2Config = (stage: Stage) => resolveChords2Config({ stage });

/* ------------------------------------------------------------ material */

interface Item {
  name: string;
  set: 'chords2' | 'spike6' | 'spike0';
  level: string;
  wav: string;
  truth: string;
}
interface Truth {
  beats: ScoreBeat[];
  chords: EvalChord[];
  chords2?: { variant?: { split?: string; heldOut?: boolean }; segments?: { start: number; end: number; rows?: { id: string; truth: string; candidate: string; conflict: boolean }[] }[] };
  bass?: { variant?: { split?: string; heldOut?: boolean; timbre?: string } };
}

export function items(): Item[] {
  const out: Item[] = [];
  const c2 = join(ROOT, 'out', 'chords2');
  for (const v of json<{ variants: { name: string; set: string; split: string; heldOut: boolean; wav: string; truth: string }[] }>(join(c2, 'manifest.json')).variants)
    if (v.split === 'tuning' && !v.heldOut && v.name.startsWith('c2-t-')) out.push({ name: v.name, set: 'chords2', level: v.set, wav: join(c2, v.wav), truth: join(c2, v.truth) });
  const b6 = join(ROOT, 'out', 'bass');
  for (const v of json<{ variants: { name: string; level: number; split: string; heldOut: boolean; wav: string; truth: string }[] }>(join(b6, 'manifest.json')).variants)
    if (v.split === 'tuning' && !v.heldOut) out.push({ name: v.name, set: 'spike6', level: String(v.level).startsWith('B') ? String(v.level) : `B${v.level}`, wav: join(b6, v.wav), truth: join(b6, v.truth) });
  const s0 = join(ROOT, 'out', 'spike0');
  for (const v of json<{ variants: { name: string; level: unknown; heldOut?: boolean; wav: string; truth: string }[] }>(join(s0, 'manifest.json')).variants)
    if (v.heldOut === false) out.push({ name: v.name, set: 'spike0', level: /^\d+$/.test(String(v.level)) ? `L${String(v.level)}` : String(v.level) === 'LR' ? 'LR' : `L${String(v.level)}`, wav: join(s0, v.wav), truth: join(s0, v.truth) });
  return out;
}

/** The truth file is read only after its own flags say tuning / not held out. */
function loadTruth(it: Item): Truth {
  const t = json<Truth>(it.truth);
  if (it.set === 'chords2' && (t.chords2?.variant?.split !== 'tuning' || t.chords2.variant.heldOut)) throw new Error(`${it.name}: truth is not tuning`);
  if (it.set === 'spike6' && (t.bass?.variant?.split !== 'tuning' || t.bass.variant.heldOut || t.bass.variant.timbre === 'C')) throw new Error(`${it.name}: truth is not tuning`);
  return t;
}

/* ------------------------------------------------------------ run */

export interface Cached {
  name: string;
  set: string;
  level: string;
  rows: Record<RowId, EvalChord[]>;
  v0Same: boolean;
  hashes: { v2off: string; bassT8: string; bassG2: string };
  ms: { v1a: number; front: number; stage: Record<string, number> };
}
const slim = (cs: readonly { start: number; end: number; root: string; quality: string; bass: string | null; candidates?: { root: string; quality: string }[] }[]): EvalChord[] =>
  cs.map((c) => ({ start: c.start, end: c.end, root: c.root, quality: c.quality, bass: c.bass ?? null, ...(c.candidates ? { candidates: c.candidates.map((x) => ({ root: x.root, quality: x.quality })) } : {}) }));
const sameChords = (a: readonly EvalChord[], b: readonly EvalChord[]): boolean =>
  a.length === b.length && a.every((x, i) => x.start === b[i].start && x.end === b[i].end && x.root === b[i].root && x.quality === b[i].quality && (x.bass ?? null) === (b[i].bass ?? null));

export interface RowsRun extends Omit<Cached, 'name' | 'set' | 'level'> {
  /** the frozen v1a result and the low CQT the bass rows used (R2's spike 6 R3 check reuses them) */
  v1: ReturnType<typeof analyzeV1>;
  low: ReturnType<typeof lowCqt>;
}

function runItem(it: Item): Cached {
  const wav = decodeWav(new Uint8Array(readFileSync(it.wav)));
  const { v1: _v1, low: _low, ...r } = runRows(prepareInput(toMono(wav.channels), wav.sampleRate, true).y);
  return { name: it.name, set: it.set, level: it.level, ...r };
}

/** Every row of ROWS on one prepared (22,050 Hz, normalized) signal `y` (not changed). Used by baseline and R2. */
export function runRows(y: Float32Array): RowsRun {
  const t0 = performance.now();
  const v1 = analyzeV1(y.slice());
  const v1aMs = performance.now() - t0;
  const t8 = bassT8();
  const g2 = bassG2();
  const low = lowCqt(y, t8.lowCqt);
  const rows = {
    v1a: slim(v1.result.chords),
    bassT8: slim(applyBass(low, v1.result, t8).chords),
    bassG2: slim(applyBass(low, v1.result, g2).chords),
  } as Record<RowId, EvalChord[]>;
  const fe = frontEnd(y.slice());
  const stage: Record<string, number> = {};
  for (const s of STAGES) {
    const t1 = performance.now();
    const o = analyze2({ ...fe.input, mem: new MemTracker() }, v2Config(s));
    stage[s] = performance.now() - t1;
    rows[s] = toEvalChords(o.segments, fe.times, fe.duration);
  }
  return {
    rows,
    v0Same: sameChords(rows.V0, rows.v1a),
    hashes: { v2off: chords2ConfigHash(), bassT8: bassConfigHash(t8), bassG2: bassConfigHash(g2) },
    ms: { v1a: v1aMs, front: fe.ms, stage },
    v1,
    low,
  };
}

function cmdRun(argv: string[]): void {
  const shard = (argOf(argv, '--shard') ?? '0/1').split('/').map(Number);
  const only = argOf(argv, '--set');
  mkdirSync(CACHE, { recursive: true });
  let done = 0;
  let bad = 0;
  items().forEach((it, i) => {
    if (i % shard[1] !== shard[0] || (only && it.set !== only)) return;
    const p = join(CACHE, `${it.name}.json`);
    if (existsSync(p)) return;
    try {
      const c = runItem(it);
      writeFileSync(p, JSON.stringify(c));
      done++;
      if (!c.v0Same) bad++;
    } catch (e) {
      console.error(`${it.name}: FAILED ${e instanceof Error ? e.message : e}`);
      bad++;
    }
  });
  console.log(`shard ${shard.join('/')}: ${done} files written, ${bad} problems (failures or V0 != v1a)`);
}

/* ------------------------------------------------------------ report */

export const f3 = (x: number | null | undefined): string => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(3).replace(/^0\./, '.'));
export const f1 = (x: number | null): string => (x === null ? '-' : x.toFixed(1));
export const ci = (w: { lo: number; hi: number } | null): string => (w ? `[${f3(w.lo)}-${f3(w.hi)}]` : '');

export function table(title: string, cols: string[], rows: [string, string[]][]): string {
  return [`\n### ${title}`, `| 行 | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`, ...rows.map(([l, cs]) => `| ${l} | ${cs.join(' | ')} |`)].join('\n');
}

const GROUP_ORDER = ['B', 'V1', 'V2', 'V3', 'pair', 'B0', 'B1', 'B2', 'B3', 'L0', 'L1', 'L2', 'L3', 'LR', 'LV'];

function cmdReport(argv: string[]): void {
  const its = new Map(items().map((i) => [i.name, i]));
  const caches: { it: Item; c: Cached; t: Truth }[] = [];
  for (const it of its.values()) {
    const p = join(CACHE, `${it.name}.json`);
    if (!existsSync(p)) continue;
    caches.push({ it, c: { ...json<Cached>(p), level: it.level }, t: loadTruth(it) });
  }
  const groups = GROUP_ORDER.filter((g) => caches.some((x) => x.c.level === g));
  const A: Record<string, Agg> = {};
  const key = (v: Vocab, row: RowId, g: string) => `${v}|${row}|${g}`;
  const conf: Record<string, Confusion> = {};
  let v0Bad = 0;
  const pairItemsByRow: Record<string, PairItem[]> = {};
  const pairRef: Record<string, PairItem[]> = { soundOnly: [], bassOnly: [] };
  for (const { c, t } of caches) {
    if (!c.v0Same) v0Bad++;
    for (const row of ROWS)
      for (const v of ['full', 'down'] as const) {
        const s = scoreChords(t.chords, c.rows[row], t.beats, v);
        const e = editCounts(t.chords, c.rows[row], t.beats, v);
        for (const g of [c.level, 'ALL']) addFile((A[key(v, row, g)] ??= newAgg()), s, e);
      }
    for (const row of ROWS) {
      addConfusion((conf[`${row}|${c.level}`] ??= newConfusion()), t.chords, c.rows[row], t.beats, 'full');
    }
    if (c.level === 'pair')
      for (const seg of t.chords2?.segments ?? [])
        for (const row of seg.rows ?? []) {
          const mid = (seg.start + seg.end) / 2;
          const truth = parseReading(row.truth.split('/')[0]);
          const pair = pairReadings(truth);
          const base = { id: row.id, conflict: row.conflict, truth };
          for (const id of ROWS) {
            const rc = at(c.rows[id], mid);
            const got: Reading | null = rc ? { root: noteToPc(rc.root), quality: rc.quality } : null;
            (pairItemsByRow[id] ??= []).push({ ...base, got });
          }
          if (pair) {
            const bassPc = row.truth.includes('/') ? noteToPc(row.truth.split('/')[1]) : truth.root; // the row's bass (TRUTH_ROWS): the slash note, else the root
            pairRef.soundOnly.push({ ...base, got: soundOnlyReading(pair) });
            pairRef.bassOnly.push({ ...base, got: bassOnlyReading(pair, bassPc) });
          }
        }
  }
  const S = (v: Vocab, row: RowId, g: string) => summarize(A[key(v, row, g)] ?? newAgg());
  const cols = [...groups, 'ALL'];
  const per = (f: (v: Vocab, row: RowId, g: string) => string, v: Vocab): [string, string[]][] => ROWS.map((r) => [ROW_LABEL[r], cols.map((g) => f(v, r, g))]);
  const out: string[] = [];
  out.push(`# baseline (tuning only): ${caches.length} files, V0 != v1a in ${v0Bad} files`);
  const first = caches[0]?.c.hashes;
  out.push(`hashes: v2 all-off ${first?.v2off}, bass T8-eq ${first?.bassT8}, bass G2 ${first?.bassG2}`);
  out.push(`files per group: ${cols.map((g) => `${g} ${g === 'ALL' ? caches.length : caches.filter((x) => x.c.level === g).length}`).join(', ')}`);
  out.push(table('名前の当たり 落（点の割合 [区間単位の Wilson 95 %]）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.name.rate)} ${ci(s.name.wilson)}`; }, 'down')));
  out.push(table('名前の当たり 全', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.name.rate)} ${ci(s.name.wilson)}`; }, 'full')));
  out.push(table('/X の点のルート 落（点の割合 [Wilson]、点数）', cols, per((v, r, g) => { const s = S(v, r, g); return s.slashRoot.units ? `${f3(s.slashRoot.rate)} ${ci(s.slashRoot.wilson)}` : '-'; }, 'down')));
  out.push(table('分数 P / R / F 落', cols, per((v, r, g) => { const s = S(v, r, g); return s.slash.truth ? `${f3(s.slash.p)}/${f3(s.slash.r)}/${f3(s.slash.f)}` : '-'; }, 'down')));
  out.push(table('誤った /X 落（正解に /X が無い点のうち。括弧は和音のある点だけ）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.wrongSlash)} (${f3(s.wrongSlashOnChord)})`; }, 'down')));
  out.push(table('直す手数 / 100 拍 落（括弧は候補から選べば直せる数）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f1(s.editsPer100)} (${f1(s.editsFixablePer100)})`; }, 'down')));
  out.push(table('直す手数 / 100 拍 全', cols, per((v, r, g) => { const s = S(v, r, g); return `${f1(s.editsPer100)} (${f1(s.editsFixablePer100)})`; }, 'full')));
  out.push(table('ベースにだけある音（全。当たった区間 / 区間）', cols, per((v, r, g) => { const s = S(v, r, g); return s.bassOnly.units ? `${s.bassOnly.unitHit}/${s.bassOnly.units}` : '-'; }, 'full')));
  out.push(table('採点した点数（落、重みつき）', cols, per((v, r, g) => String(S(v, r, g).nPoints), 'down')));

  // per quality (full), the sets of each stage
  for (const g of ['V1', 'V2', 'V3']) {
    const qs = newQualities(g as Stage);
    out.push(
      table(`${g} の新しい種類ごとの再現率 / 適合率（全。ルートと種類が合った点。括弧は正解側の点数。ベースにだけある音の点は除く）`, qs.map((q) => suffix(q)), ROWS.map((r) => [
        ROW_LABEL[r],
        qs.map((q) => {
          const x = A[key('full', r, g)]?.byQuality[q];
          return x ? `${f3(x.t.n ? x.t.hit / x.t.n : null)}/${f3(x.r.n ? x.r.hit / x.r.n : null)} (${x.t.n})` : '-';
        }),
      ])),
    );
  }

  // pairs
  const pairRows: [string, PairItem[]][] = [...ROWS.map((r) => [ROW_LABEL[r], pairItemsByRow[r] ?? []] as [string, PairItem[]]), ['参考: 音だけ', pairRef.soundOnly], ['参考: ベースだけ（正しいベース）', pairRef.bassOnly]];
  out.push(
    table('音が同じ組の読み（pair の合成。区間単位。食い違う例を主）', ['食い違う例', '食い違わない例', '全体'], pairRows.map(([l, xs]) => {
      const s = scorePairs(xs);
      const cell = (u: typeof s.all) => (u.n ? `${u.hit}/${u.n} = ${f3(u.rate)} ${ci(u.wilson)}` : '-');
      return [l, [cell(s.conflict), cell(s.nonConflict), cell(s.all)]];
    })),
  );

  // confusion: quality (root matched), top errors per row and group
  out.push('\n### 取り違え: 正解の種類 → 出した種類（ルートが合った点。全。当たり以外の上位 8。点数）');
  for (const g of ['V1', 'V2', 'V3', 'B', 'LR']) {
    for (const row of ['v1a', g === 'V1' ? 'V1' : g === 'V2' ? 'V2' : g === 'V3' ? 'V3' : 'V3'] as RowId[]) {
      const c = conf[`${row}|${g}`];
      if (!c) continue;
      const errs = Object.entries(c.quality)
        .filter(([k]) => k.split('|')[0] !== k.split('|')[1])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, n]) => `${suffix(k.split('|')[0]) || 'maj'}→${k.split('|')[1] === 'none' ? 'none' : suffix(k.split('|')[1]) || 'maj'} ${n}`);
      const all = Object.values(c.quality).reduce((a, b) => a + b, 0);
      out.push(`- ${g} / ${ROW_LABEL[row]}: 点 ${all}、 ${errs.join(', ')}`);
    }
  }
  out.push('\n### /X の点のルートのずれ（結果のルート − 正解のルート、半音、none = 和音なし。点数）');
  for (const g of ['B', 'B1', 'B2', 'B3', 'LR', 'V1', 'V3']) {
    for (const row of ['v1a', 'bassT8', 'bassG2'] as RowId[]) {
      const c = conf[`${row}|${g}`];
      if (!c) continue;
      const h = Object.entries(c.slashRootOffset).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ');
      const b = Object.entries(c.slashBassOffset).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ');
      if (h) out.push(`- ${g} / ${ROW_LABEL[row]}: ルート [${h}]  鳴っている低音 [${b}]`);
    }
  }
  const text = out.join('\n');
  console.log(text);
  const jp = argOf(argv, '--json');
  if (jp) {
    mkdirSync(dirname(resolve(jp)), { recursive: true });
    writeFileSync(jp, JSON.stringify({ summaries: Object.fromEntries(Object.entries(A).map(([k, a]) => [k, summarize(a)])), v0Bad }, null, 1));
  }
}

/* ------------------------------------------------------------ timing */

function profile<T>(fn: () => T): { out: T; viterbiMs: number; totalMs: number } {
  const s = new inspector.Session();
  s.connect();
  let result: { profile: { nodes: { id: number; callFrame: { functionName: string }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } } | undefined;
  s.post('Profiler.enable');
  s.post('Profiler.setSamplingInterval', { interval: 200 });
  s.post('Profiler.start');
  const out = fn();
  s.post('Profiler.stop', (_e, r) => (result = r as typeof result));
  s.disconnect();
  const p = result!.profile;
  const self = new Map<number, number>();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const incl = (id: number): number => (self.get(id) ?? 0) + (byId.get(id)!.children ?? []).reduce((a, c) => a + incl(c), 0);
  let viterbiMs = 0;
  for (const n of p.nodes) if (n.callFrame.functionName === 'viterbi') viterbiMs += incl(n.id);
  return { out, viterbiMs, totalMs: [...self.values()].reduce((a, b) => a + b, 0) };
}

function cmdTiming(): void {
  const pool = items().filter((i) => i.set === 'chords2' && i.level === 'B' && /-(clean-s1|human-s2|piano-s3)$/.test(i.name));
  const clips = pool.map((it) => {
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    return prepareInput(toMono(w.channels), w.sampleRate, true).y;
  });
  const lines: string[] = ['| 入力 | 段 | 状態 | 点〜後処理の合計 ms | Viterbi ms | Viterbi の割合 | V0 比 | 状態表のメモリ最大 MB |', '|---|---|---|---|---|---|---|---|'];
  const head: string[] = [];
  for (const minutes of [1, 3, 5]) {
    const need = minutes * 60 * 22050;
    const parts: Float32Array[] = [];
    let len = 0;
    for (let i = 0; len < need; i++) {
      const c = clips[i % clips.length];
      parts.push(c);
      len += c.length;
    }
    const y = new Float32Array(Math.min(len, need));
    let o = 0;
    for (const p of parts) {
      const n = Math.min(p.length, y.length - o);
      if (n <= 0) break;
      y.set(p.subarray(0, n), o);
      o += n;
    }
    const t0 = performance.now();
    const v1 = analyzeV1(y.slice());
    const v1aMs = performance.now() - t0;
    const stat = (n: string) => v1.stats.find((s) => s.name === n)?.ms ?? 0;
    const pass2 = stat('chords2') + stat('merge2');
    head.push(`- ${minutes} 分（${(y.length / 22050).toFixed(0)} 秒、拍 ${v1.result.beats.length}）: v1a 全体 ${v1aMs.toFixed(0)} ms、うち 2 回目のコード段（chords2 + merge2）${pass2.toFixed(0)} ms`);
    const fe = frontEnd(y.slice());
    const tl = performance.now();
    const low = lowCqt(y, bassT8().lowCqt);
    const lowMs = performance.now() - tl;
    const tb = performance.now();
    applyBass(low, v1.result, bassG2());
    head.push(`  - ベースの段: 低 CQT ${lowMs.toFixed(0)} ms + applyBass（G2 既定）${(performance.now() - tb).toFixed(0)} ms。前段（v1a の拍・クロマ・調まで）${fe.ms.toFixed(0)} ms`);
    let v0 = 0;
    for (const s of STAGES) {
      const reps: { ms: number; v: number; mem: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const mem = new MemTracker();
        const p = profile(() => analyze2({ ...fe.input, mem }, v2Config(s)));
        reps.push({ ms: p.totalMs, v: p.viterbiMs, mem: mem.peak });
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];
      const ms = med(reps.map((r) => r.ms));
      const v = med(reps.map((r) => r.v));
      if (s === 'V0') v0 = ms;
      const states = { V0: 120, V1: 156, V2: 204, V3: 240 }[s];
      lines.push(`| ${minutes} 分 | ${s} | ${states} | ${ms.toFixed(0)} | ${v.toFixed(0)} | ${f3(v / ms)} | ${(ms / v0).toFixed(2)} | ${(Math.max(...reps.map((r) => r.mem)) / 1e6).toFixed(0)} |`);
    }
  }
  console.log([...head, '', ...lines].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') cmdRun(rest);
  else if (cmd === 'report') cmdReport(rest);
  else if (cmd === 'timing') cmdTiming();
  else {
    console.error('usage: baseline.ts run [--shard k/n] [--set S] | report [--json P] | timing');
    process.exit(2);
  }
}
