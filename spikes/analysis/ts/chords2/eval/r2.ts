/**
 * Spike 7 R2: look point 1 ('dev-1', before G1) on the DEV recordings (docs/audio-spike7-plan.md §4, §5, R2 row;
 * docs/audio-spike7-r2.md). The same rows as the T7 baseline (baseline.ts runRows: v1a, v1a + bass T8-form / G2 default,
 * chords2 V0-V3 with every B / pair switch off) on every recording registered as spike 7 dev (spike 6 a-f, re-registered
 * in T1, and the new g-j), loudness-normalized (prepareInput). No value is tuned here. From spikes/analysis:
 *
 *   npx tsx ts/chords2/eval/r2.ts --selftest                     dry run on 4 TUNING synthetic files (not a look)
 *   BAND_SHEETS_COMMIT=SHA npx tsx ts/chords2/eval/r2.ts --look  the one logged look (dev-1, task R2)
 *
 * Both need committed, clean code (guard.ts committedBlock / beginLook; in a worktree pass GIT_DIR / GIT_WORK_TREE).
 * The takes are read from recordings/chd-ids.local.json (split 'dev') BEFORE beginLook; held-out takes are never
 * selected, and no recording or truth file is opened before the look-start line is written. Also checked here (T4 open
 * item): spike 6 R3's numbers on the normalized a-d (t9_sweep run on the v1a segments, the same scorer as spike 6).
 * Identical pairs are recorded only (plan §2.3: judged on synthetic). Output: aggregates only (per group / per take).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../../browser/wav';
import { toMono } from '../../dsp/core/resample';
import { at, json } from '../../bass/evalCommon';
import { beatWindows, normalizeTruthSlash, noteToPc, type ScoreBeat } from '../../bass/score';
import { run as t9Run, strip, type Item as T9Item } from '../../bass/t9_sweep';
import { bassConfigHash } from '../../bass/config';
import { chords2ConfigHash } from '../config';
import { newQualities, stageQualities, suffix, type Stage } from '../vocab';
import { addConfusion, addFile, newAgg, newConfusion, summarize, type Agg, type Confusion } from './baselineAgg';
import { bassG2, bassT8, ci, f1, f3, items as tuningItems, ROW_LABEL, ROWS, runRows, STAGES, table, v2Config, type RowId } from './baseline';
import { beginLook, commitArg, committedBlock, git, readRegistry, ROOT, type Registry } from './guard';
import { prepareInput } from './input';
import { bassOnlyReading, pairReadings, scorePairs, soundOnlyReading, type PairItem, type Reading } from './pairs';
import { editCounts, scoreChords, truthQuality, type EvalChord, type Vocab } from './score';

export const LOOK = 'dev-1' as const;
export const TASK = 'R2';

interface RecTruth {
  name?: string;
  heldOut?: boolean;
  excludedBars?: number[];
  beats: ScoreBeat[];
  chords: EvalChord[];
}
/** One scored file: the rows of runRows, its truth, and what the spike 6 R3 check needs. */
export interface Scored {
  id: string;
  group: string;
  letter: string;
  truth: RecTruth;
  rows: Record<RowId, EvalChord[]>;
  v0Same: boolean;
  gainDb: number;
  t9: T9Item;
}

/** Spike 7 dev recordings of the registry (sorted ids), or the reason to refuse (pure). */
export function devTakes(registry: Registry | null): string[] {
  if (registry === null) throw new Error('recordings/chd-ids.local.json is missing or unreadable');
  return Object.keys(registry)
    .filter((id) => registry[id].split === 'dev' && registry[id].heldOut === false)
    .sort();
}
/** a-d / e-f (spike 6, re-registered) / g-j (spike 7) by the id's letter (pure). */
export const groupOf = (id: string): string => {
  const l = id.split('-')[2] ?? '';
  return 'abcd'.includes(l) ? 'a-d' : 'ef'.includes(l) ? 'e-f' : 'g-j';
};
/** The flag a dev take's truth must carry: spike 6's own flag for a-f (e/f were spike 6 hold-out), else false (pure). */
export const expectedTruthHeldOut = (e: Registry[string]): boolean => (e.from?.spike === 6 ? e.from.heldOut : false);

function score(id: string, group: string, wav: string, truth: RecTruth): Scored {
  const w = decodeWav(new Uint8Array(readFileSync(wav)));
  const p = prepareInput(toMono(w.channels), w.sampleRate, true);
  const r = runRows(p.y);
  const letter = id.split('-')[2] ?? id;
  return {
    id,
    group,
    letter,
    truth,
    rows: r.rows,
    v0Same: r.v0Same,
    gainDb: p.gainDb,
    t9: { level: letter, timbre: '-', low: r.low, truth: truth.chords, truthBeats: truth.beats, v1a: strip(r.v1.result.chords), v1aBeats: r.v1.result.beats.map((b) => b.t), ceiling: true },
  };
}

/** Points (2 per beat, weight 0.5) whose full truth quality is outside `stage`'s vocabulary, and all scored points. */
export function outsideVocab(truth: readonly EvalChord[], beats: readonly ScoreBeat[], stage: Stage): { out: number; n: number } {
  const voc = new Set(stageQualities(stage));
  const tt = normalizeTruthSlash(truth) as EvalChord[];
  let out = 0;
  let n = 0;
  for (const w of beatWindows(beats))
    for (const f of [0.25, 0.75]) {
      const tc = at(tt, w[0] + f * (w[2] - w[0]));
      const q = tc ? truthQuality(tc, 'full') : null;
      if (q === null) continue;
      n += 0.5;
      if (!voc.has(q)) out += 0.5;
    }
  return { out, n };
}

/** Identical-pair units of one file: every truth chord whose quality is in a pair (recorded only, plan §2.3). */
export function pairUnits(truth: readonly EvalChord[], rows: Record<RowId, EvalChord[]>): { byRow: Record<string, PairItem[]>; soundOnly: PairItem[]; bassOnly: PairItem[] } {
  const byRow: Record<string, PairItem[]> = {};
  const soundOnly: PairItem[] = [];
  const bassOnly: PairItem[] = [];
  (normalizeTruthSlash(truth) as EvalChord[]).forEach((c, i) => {
    const t: Reading = { root: noteToPc(c.root), quality: c.originalQuality ?? c.quality };
    const pair = pairReadings(t);
    if (!pair) return;
    const bassPc = c.bass ? noteToPc(c.bass) : t.root;
    const base = { id: String(i), conflict: bassPc !== t.root, truth: t };
    const mid = (c.start + c.end) / 2;
    for (const row of ROWS) {
      const rc = at(rows[row], mid);
      (byRow[row] ??= []).push({ ...base, got: rc ? { root: noteToPc(rc.root), quality: rc.quality } : null });
    }
    soundOnly.push({ ...base, got: soundOnlyReading(pair) });
    bassOnly.push({ ...base, got: bassOnlyReading(pair, bassPc) });
  });
  return { byRow, soundOnly, bassOnly };
}

/** The tables (aggregates only) and the spike 6 R3 check; printed. */
export function report(title: string, files: Scored[]): void {
  const groups = [...new Set(files.map((f) => f.group))].sort();
  const cols = [...groups, 'ALL'];
  const A: Record<string, Agg> = {};
  const key = (v: Vocab, row: RowId, g: string) => `${v}|${row}|${g}`;
  const conf: Record<string, Confusion> = {};
  const rootHit: Record<string, { hit: number; n: number }> = {};
  const outside: Record<string, { out: number; n: number }> = {};
  const pairs: Record<string, PairItem[]> = { soundOnly: [], bassOnly: [] };
  for (const f of files) {
    const t = f.truth;
    for (const row of ROWS) {
      for (const v of ['full', 'down'] as const) {
        const s = scoreChords(t.chords, f.rows[row], t.beats, v);
        const e = editCounts(t.chords, f.rows[row], t.beats, v);
        for (const g of [f.group, 'ALL', `take:${f.id}`]) addFile((A[key(v, row, g)] ??= newAgg()), s, e);
        if (v === 'down') for (const g of [f.group, 'ALL']) {
          const r = (rootHit[`${row}|${g}`] ??= { hit: 0, n: 0 });
          r.hit += s.root.hit;
          r.n += s.root.n;
        }
      }
      addConfusion((conf[row] ??= newConfusion()), t.chords, f.rows[row], t.beats, 'full');
    }
    for (const st of STAGES)
      for (const g of [f.group, 'ALL']) {
        const o = outsideVocab(t.chords, t.beats, st);
        const x = (outside[`${st}|${g}`] ??= { out: 0, n: 0 });
        x.out += o.out;
        x.n += o.n;
      }
    const pu = pairUnits(t.chords, f.rows);
    for (const [r, xs] of Object.entries(pu.byRow)) (pairs[r] ??= []).push(...xs);
    pairs.soundOnly.push(...pu.soundOnly);
    pairs.bassOnly.push(...pu.bassOnly);
  }
  const S = (v: Vocab, row: RowId, g: string) => summarize(A[key(v, row, g)] ?? newAgg());
  const per = (f: (v: Vocab, r: RowId, g: string) => string, v: Vocab, cs = cols): [string, string[]][] => ROWS.map((r) => [ROW_LABEL[r], cs.map((g) => f(v, r, g))]);
  const name = (v: Vocab, r: RowId, g: string) => { const s = S(v, r, g); return `${f3(s.name.rate)} ${ci(s.name.wilson)}`; };
  const out: string[] = [];
  const gains = (g: string) => files.filter((f) => g === 'ALL' || f.group === g).map((f) => f.gainDb).sort((a, b) => a - b);
  out.push(`# ${title}: ${files.length} files, V0 != v1a in ${files.filter((f) => !f.v0Same).length}`);
  out.push(`hashes: v2 all-off ${chords2ConfigHash()}, V1-V3 ${(['V1', 'V2', 'V3'] as Stage[]).map((s) => chords2ConfigHash(v2Config(s))).join(' ')}, bass T8-eq ${bassConfigHash(bassT8())}, bass G2 ${bassConfigHash(bassG2())}`);
  out.push(`files per group: ${cols.map((g) => `${g} ${g === 'ALL' ? files.length : files.filter((f) => f.group === g).length}`).join(', ')}`);
  out.push(`input gain dB (min / median / max): ${cols.map((g) => { const x = gains(g); return `${g} ${x[0]?.toFixed(1)} / ${x[Math.floor(x.length / 2)]?.toFixed(1)} / ${x[x.length - 1]?.toFixed(1)}`; }).join(', ')}`);
  out.push(table('名前の当たり 落（点の割合 [区間単位の Wilson 95 %]）', cols, per(name, 'down')));
  out.push(table('名前の当たり 全', cols, per(name, 'full')));
  out.push(table('ルートの当たり 落（点の割合）', cols, ROWS.map((r) => [ROW_LABEL[r], cols.map((g) => { const x = rootHit[`${r}|${g}`]; return x?.n ? f3(x.hit / x.n) : '-'; })])));
  out.push(table('/X の点のルート 落（点の割合 [Wilson]、当たり点 / 点）', cols, per((v, r, g) => { const a = A[key(v, r, g)]; const s = S(v, r, g); return s.slashRoot.units ? `${f3(s.slashRoot.rate)} ${ci(s.slashRoot.wilson)} ${a.slashRootP.hit}/${a.slashRootP.n}` : '-'; }, 'down')));
  out.push(table('分数 P / R / F 落', cols, per((v, r, g) => { const s = S(v, r, g); return s.slash.truth ? `${f3(s.slash.p)}/${f3(s.slash.r)}/${f3(s.slash.f)}` : '-'; }, 'down')));
  out.push(table('誤った /X 落（正解に /X が無い点のうち。括弧は和音のある点だけ）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.wrongSlash)} (${f3(s.wrongSlashOnChord)})`; }, 'down')));
  out.push(table('直す手数 / 100 拍 落（括弧は候補から選べば直せる数）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f1(s.editsPer100)} (${f1(s.editsFixablePer100)})`; }, 'down')));
  out.push(table('直す手数 / 100 拍 全', cols, per((v, r, g) => { const s = S(v, r, g); return `${f1(s.editsPer100)} (${f1(s.editsFixablePer100)})`; }, 'full')));
  out.push(table('ベースにだけある音 bassOnly（全。当たった区間 / 区間）', cols, per((v, r, g) => { const s = S(v, r, g); return s.bassOnly.units ? `${s.bassOnly.unitHit}/${s.bassOnly.units}` : '-'; }, 'full')));
  out.push(table('採点した点数（全 / 落、重みつき）', cols, per((_v, r, g) => `${S('full', r, g).nPoints} / ${S('down', r, g).nPoints}`, 'full')));
  out.push(table('正解の種類がその段階の語彙に無い点（全。点 / 採点した点。v1a・ベースの行は V0 を見る）', cols, STAGES.map((st) => [st, cols.map((g) => { const x = outside[`${st}|${g}`]; return x?.n ? `${x.out}/${x.n} = ${f3(x.out / x.n)}` : '-'; })])));
  const takes = files.map((f) => `take:${f.id}`);
  out.push(table('録音ごとの名前の当たり 落（点の割合）', files.map((f) => f.letter), per((v, r, g) => f3(S(v, r, g).name.rate), 'down', takes)));
  out.push(table('録音ごとの誤った /X 落', files.map((f) => f.letter), per((v, r, g) => f3(S(v, r, g).wrongSlash), 'down', takes)));
  const qs = newQualities('V3');
  out.push(table('新しい種類ごとの再現率 / 適合率（全、ALL。括弧は正解側の点数。ベースにだけある音の点は除く）', qs.map((q) => suffix(q)), ROWS.map((r) => [ROW_LABEL[r], qs.map((q) => { const x = A[key('full', r, 'ALL')]?.byQuality[q]; return x ? `${f3(x.t.n ? x.t.hit / x.t.n : null)}/${f3(x.r.n ? x.r.hit / x.r.n : null)} (${x.t.n})` : '-'; })])));
  const pairRows: [string, PairItem[]][] = [...ROWS.map((r) => [ROW_LABEL[r], pairs[r] ?? []] as [string, PairItem[]]), ['参考: 音だけ', pairs.soundOnly], ['参考: ベースだけ（正しいベース）', pairs.bassOnly]];
  out.push(table('音が同じ組の読み（録音は記録だけ。区間単位。食い違う例を主）', ['食い違う例', '食い違わない例', '全体'], pairRows.map(([l, xs]) => {
    const s = scorePairs(xs);
    const cell = (u: typeof s.all) => (u.n ? `${u.hit}/${u.n} = ${f3(u.rate)} ${ci(u.wilson)}` : '-');
    return [l, [cell(s.conflict), cell(s.nonConflict), cell(s.all)]];
  })));
  out.push('\n### 取り違え: 正解の種類 → 出した種類（ALL、ルートが合った点。全。当たり以外の上位 10。点数）');
  for (const row of ['v1a', 'bassT8', 'V3'] as RowId[]) {
    const c = conf[row];
    const errs = Object.entries(c.quality).filter(([k]) => k.split('|')[0] !== k.split('|')[1]).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, n]) => `${suffix(k.split('|')[0]) || 'maj'}→${k.split('|')[1] === 'none' ? 'none' : suffix(k.split('|')[1]) || 'maj'} ${n}`);
    out.push(`- ${ROW_LABEL[row]}: 点 ${Object.values(c.quality).reduce((a, b) => a + b, 0)}、 ${errs.join(', ')}`);
  }
  out.push('\n### /X の点のルートのずれ（ALL。結果のルート − 正解のルート、半音、none = 和音なし。点数）');
  for (const row of ['v1a', 'bassT8', 'bassG2'] as RowId[]) {
    const c = conf[row];
    const h = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ');
    out.push(`- ${ROW_LABEL[row]}: ルート [${h(c.slashRootOffset)}]  鳴っている低音 [${h(c.slashBassOffset)}]`);
  }
  console.log(out.join('\n'));

  // T4 open item: spike 6 R3 on the normalized a-d (spike 6's t9_sweep scorer on the v1a segments; R3 = nominal grid gave the same numbers)
  const ad = files.filter((f) => f.group === 'a-d');
  if (ad.length) {
    console.log(`\n## spike 6 R3 check (a-d, ${ad.length} files): v1a name 落 ${f3(S('down', 'v1a', 'a-d').name.rate)}, root 落 ${f3(rootHit['v1a|a-d'].hit / rootHit['v1a|a-d'].n)}, /X-point root ${A[key('down', 'v1a', 'a-d')].slashRootP.hit}/${A[key('down', 'v1a', 'a-d')].slashRootP.n}`);
    const lv = [...ad.map((f) => f.letter), 'ALL'];
    t9Run('T8-eq (spike 6 R3: segBass .918, P/R/F .843/.269/.408, wrong/X .023, cliche .750, saved 1.95)', bassT8(), ad.map((f) => f.t9), false, false, lv);
    t9Run('G2 default (spike 6 R3: segBass .918, P/R/F .907/.244/.384, wrong/X .011)', bassG2(), ad.map((f) => f.t9), false, false, lv);
  }
  // v1a segments only: the truth-segment ceiling would hand the bass stage truth qualities v1a does not know (mM7 ...)
  console.log('\n## bass stage (spike 6 t9_sweep scorer, v1a segments only) on every file of this run');
  const lvAll = [...files.map((f) => f.letter), 'ALL'];
  const v1aOnly = files.map((f) => ({ ...f.t9, ceiling: false }));
  t9Run('T8-eq', bassT8(), v1aOnly, false, false, lvAll);
  t9Run('G2 default', bassG2(), v1aOnly, false, false, lvAll);
}

function gitState(argv: string[]) {
  return { commit: commitArg(argv), head: git(['rev-parse', 'HEAD']), porcelain: git(['status', '--porcelain']) };
}

/** Dry run: the same pipeline and tables on 4 tuning synthetic files (no look, nothing dev or held out is opened). */
function selftest(argv: string[]): void {
  const cb = committedBlock({ ...gitState(argv), commit: commitArg(argv) ?? git(['rev-parse', 'HEAD']) ?? undefined });
  if (cb) throw new Error(`selftest: ${cb}`);
  const pick = tuningItems().filter((i) => i.set === 'spike6' && i.level === 'B1').slice(0, 2).concat(tuningItems().filter((i) => i.set === 'chords2' && (i.level === 'V1' || i.level === 'pair')).slice(0, 2));
  const files = pick.map((it, k) => {
    const t = json<RecTruth>(it.truth);
    return score(`syn-0${k + 1}-${'abgh'[k]}`, groupOf(`x-0-${'abgh'[k]}`), it.wav, { beats: t.beats, chords: t.chords });
  });
  report('selftest (tuning synthetic, not a look)', files);
}

function look(argv: string[]): void {
  const registry = readRegistry();
  const takes = devTakes(registry);
  const hashes = [chords2ConfigHash(), ...(['V1', 'V2', 'V3'] as Stage[]).map((s) => chords2ConfigHash(v2Config(s))), bassConfigHash(bassT8()), bassConfigHash(bassG2())];
  const { finish, line } = beginLook({ look: LOOK, task: TASK, reason: 'R2: look point 1 before G1 - the T7 baseline rows on the loudness-normalized dev recordings (spike 6 a-f + new g-j); no tuning', configHashes: hashes, takes }, commitArg(argv));
  console.log(`look-start logged: ${line.look} ${line.task} commit ${line.commit?.slice(0, 7)} takes ${takes.length}`);
  const files = takes.map((id) => {
    const t = json<RecTruth>(join(ROOT, 'recordings', `${id}.truth.json`));
    if (t.name !== id || t.heldOut !== expectedTruthHeldOut(registry![id]) || (t.excludedBars ?? []).length) throw new Error(`${id}: truth flags / excluded bars not as expected`);
    return score(id, groupOf(id), join(ROOT, 'recordings', `${id}.wav`), t);
  });
  report(`R2 look ${LOOK} (dev recordings, normalized input)`, files);
  finish();
  console.log('\nlook-done logged');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest(argv);
  else if (argv.includes('--look')) look(argv);
  else {
    console.error('usage: r2.ts --selftest | --look');
    process.exit(2);
  }
}
