/**
 * Spike 7 T9: the identical-pair rules (plan §2.3, ts/chords2/pairRule.ts) on the TUNING pair-example material only
 * (out/chords2 c2-t-pair-*, T5; docs/audio-spike7-t9.md). No dev / held-out file is opened: the manifest split is
 * checked before a file is read and the truth file's own flags again before it is used. From spikes/analysis:
 *
 *   npx tsx ts/chords2/eval/t9_pairs.ts run [--shard k/n]   per-file results -> out/chords2-t9/cache
 *   npx tsx ts/chords2/eval/t9_pairs.ts report              tables (aggregates only)
 *
 * Per file: prepareInput (RMS -22 dBFS) -> the v1a front end -> chords2 at V1 and V2 with pairRule 'off' -> the pair
 * post-pass with each rule and two bass sources: the estimated bass (spike 6 segmentBass on the chords2 segments, T8-eq
 * config; the bass stage T8/T10 will feed) and the truth bass at the segment's middle (to separate bass errors).
 * Scored per truth-table row occurrence (pairs.ts scorePairs) at the middle of the row's segment, beside the
 * references 音だけ / ベースだけ (pairs.ts, idealized: they assume the pair was read). 「組として読めた」 = the chords2
 * segment there is one of the two readings (the post-pass can only act on those).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../../browser/wav';
import { argOf, at, json } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import { noteToPc } from '../../bass/score';
import { segmentBass } from '../../bass/segmentBass';
import { toMono } from '../../dsp/core/resample';
import { MemTracker } from '../../dsp/core/mem';
import { analyze } from '../analyze';
import { resolveChords2Config } from '../config';
import { applyDecisions, resolvePairs, segmentKeys } from '../pairRule';
import { bassT8, f3, ci, table } from './baseline';
import { frontEnd, toEvalChords } from './frontEnd';
import { prepareInput } from './input';
import { bassOnlyReading, pairReadings, parseReading, scorePairs, soundOnlyReading, type PairItem, type Reading } from './pairs';
import type { EvalChord } from './score';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const C2 = join(ROOT, 'out', 'chords2');
const CACHE = join(ROOT, 'out', 'chords2-t9', 'cache');
const STAGES = ['V1', 'V2'] as const;
const RULES = ['context', 'bassRoot'] as const;
const VARIANTS = ['off', 'context|est', 'bassRoot|est', 'context|true', 'bassRoot|true'] as const;

interface Item {
  name: string;
  wav: string;
  truth: string;
}
interface TruthRowRef {
  id: string;
  truth: string;
  candidate: string;
  conflict: boolean;
}
interface Truth {
  chords: EvalChord[];
  chords2?: { variant?: { split?: string; heldOut?: boolean }; segments?: { start: number; end: number; rows?: TruthRowRef[] }[] };
}
interface Cached {
  name: string;
  /** `${stage}|${variant}` -> chords; `${stage}|estBass` -> spans with the estimated bass pc in `root` */
  rows: Record<string, EvalChord[]>;
}

function items(): Item[] {
  const m = json<{ variants: { name: string; set: string; split: string; heldOut: boolean; wav: string; truth: string }[] }>(join(C2, 'manifest.json'));
  return m.variants
    .filter((v) => v.set === 'pair' && v.split === 'tuning' && !v.heldOut && v.name.startsWith('c2-t-pair-'))
    .map((v) => ({ name: v.name, wav: join(C2, v.wav), truth: join(C2, v.truth) }));
}

function loadTruth(it: Item): Truth {
  const t = json<Truth>(it.truth);
  if (t.chords2?.variant?.split !== 'tuning' || t.chords2.variant.heldOut) throw new Error(`${it.name}: truth is not tuning`);
  return t;
}

function runItem(it: Item, t: Truth): Cached {
  const wav = decodeWav(new Uint8Array(readFileSync(it.wav)));
  const y = prepareInput(toMono(wav.channels), wav.sampleRate, true).y;
  const fe = frontEnd(y.slice());
  const bcfg = bassT8();
  const low = lowCqt(y, bcfg.lowCqt);
  const beats = Array.from(fe.times);
  const rows: Record<string, EvalChord[]> = {};
  for (const stage of STAGES) {
    const o = analyze({ ...fe.input, mem: new MemTracker() }, resolveChords2Config({ stage }));
    const segs = o.segments;
    const span = segs.map((s) => (s.root === null ? null : toEvalChords([s], fe.times, fe.duration)[0]));
    const voiced = span.filter((s): s is EvalChord => s !== null);
    const est = segmentBass(low, voiced, beats, bcfg.segment);
    let k = 0;
    const estBass = span.map((s) => (s === null ? null : est[k++].pc));
    const trueBass = span.map((s) => {
      if (s === null) return null;
      const c = at(t.chords, (s.start + s.end) / 2);
      return c ? noteToPc(c.bass ?? c.root) : null;
    });
    const keys = segmentKeys(segs, fe.input.barKeys, fe.input.barOfBeat);
    rows[`${stage}|off`] = toEvalChords(segs, fe.times, fe.duration);
    rows[`${stage}|estBass`] = voiced.map((s, i) => ({ ...s, root: String(est[i].pc), quality: 'bass', bass: null }));
    for (const [src, bass] of [['est', estBass], ['true', trueBass]] as const)
      for (const rule of RULES) {
        const d = resolvePairs(segs.map((s, i) => ({ root: s.root, quality: s.quality, bass: bass[i], key: keys[i] })), rule, stage);
        rows[`${stage}|${rule}|${src}`] = toEvalChords(applyDecisions(segs, d, bass), fe.times, fe.duration);
      }
  }
  return { name: it.name, rows };
}

function cmdRun(argv: string[]): void {
  const shard = (argOf(argv, '--shard') ?? '0/1').split('/').map(Number);
  mkdirSync(CACHE, { recursive: true });
  let done = 0;
  items().forEach((it, i) => {
    if (i % shard[1] !== shard[0]) return;
    const p = join(CACHE, `${it.name}.json`);
    if (existsSync(p)) return;
    writeFileSync(p, JSON.stringify(runItem(it, loadTruth(it))));
    done++;
  });
  console.log(`shard ${shard.join('/')}: ${done} files written`);
}

const readingOf = (c: EvalChord | undefined): Reading | null => (c ? { root: noteToPc(c.root), quality: c.quality } : null);
const same = (a: Reading | null, b: Reading) => a !== null && a.root === b.root && a.quality === b.quality;

function cmdReport(): void {
  const byName = new Map(items().map((i) => [i.name, i]));
  const files = readdirSync(CACHE).filter((f) => f.endsWith('.json'));
  const out: string[] = [`# T9: identical-pair rules on the tuning pair examples (${files.length} files)`];
  for (const stage of STAGES) {
    const by: Record<string, PairItem[]> = {};
    const push = (k: string, x: PairItem) => (by[k] ??= []).push(x);
    for (const f of files) {
      const c = json<Cached>(join(CACHE, f));
      const it = byName.get(c.name);
      if (!it) throw new Error(`${c.name}: not a tuning pair item`);
      const t = loadTruth(it);
      for (const seg of t.chords2?.segments ?? [])
        for (const row of seg.rows ?? []) {
          const truth = parseReading(row.truth.split('/')[0]);
          const pair = pairReadings(truth);
          if (!pair || (stage === 'V1' && truth.quality.startsWith('sus'))) continue; // sus2 / sus4 exist from V2
          const mid = (seg.start + seg.end) / 2;
          const base = { id: row.id, conflict: row.conflict, truth };
          const off = readingOf(at(c.rows[`${stage}|off`], mid));
          const asPair = same(off, pair[0]) || same(off, pair[1]);
          const groups = asPair ? ['all', 'pair'] : ['all'];
          for (const g of groups) {
            for (const v of VARIANTS) push(`${g}|${v}`, { ...base, got: readingOf(at(c.rows[`${stage}|${v}`], mid)) });
            const trueBass = row.truth.includes('/') ? noteToPc(row.truth.split('/')[1]) : truth.root;
            const eb = at(c.rows[`${stage}|estBass`], mid);
            push(`${g}|soundOnly`, { ...base, got: soundOnlyReading(pair) });
            push(`${g}|bassOnlyTrue`, { ...base, got: bassOnlyReading(pair, trueBass) });
            push(`${g}|bassOnlyEst`, { ...base, got: eb ? bassOnlyReading(pair, Number(eb.root)) : null });
            push(`${g}|estBassRight`, { ...base, got: eb && Number(eb.root) === trueBass ? truth : null });
          }
        }
    }
    const LABEL: [string, string][] = [
      ['off', 'v2（規則なし）'],
      ['context|est', 'context（推定ベース）'],
      ['bassRoot|est', 'bassRoot（推定ベース）'],
      ['context|true', 'context（正しいベース）'],
      ['bassRoot|true', 'bassRoot（正しいベース）'],
      ['soundOnly', '参考: 音だけ'],
      ['bassOnlyEst', '参考: ベースだけ（推定ベース）'],
      ['bassOnlyTrue', '参考: ベースだけ（正しいベース）'],
      ['estBassRight', '（推定ベースが正しい割合）'],
    ];
    const cell = (u: ReturnType<typeof scorePairs>['all']) => (u.n ? `${u.hit}/${u.n} = ${f3(u.rate)} ${ci(u.wilson)}` : '-');
    for (const g of ['all', 'pair'] as const) {
      const title = `${stage}: ${g === 'all' ? '全部の行（区間単位）' : '組として読めた区間だけ'}`;
      out.push(table(title, ['食い違う例', '食い違わない例', '全体'], LABEL.map(([k, l]) => {
        const s = scorePairs(by[`${g}|${k}`] ?? []);
        return [l, [cell(s.conflict), cell(s.nonConflict), cell(s.all)]];
      })));
    }
    // per row id, context / bassRoot (est) on the pair-read subset
    const ids = [...new Set((by['all|off'] ?? []).map((x) => x.id))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const rate = (k: string, id: string) => {
      const xs = (by[k] ?? []).filter((x) => x.id === id);
      return xs.length ? `${xs.filter((x) => same(x.got, x.truth)).length}/${xs.length}` : '-';
    };
    out.push(table(`${stage}: 行ごと（組として読めた数 / 全部、規則の当たり / 組として読めた数）`, ['組として読めた', 'context 推定', 'bassRoot 推定', 'context 正しい', 'bassRoot 正しい'], ids.map((id) => [
      id,
      [`${(by['pair|off'] ?? []).filter((x) => x.id === id).length}/${(by['all|off'] ?? []).filter((x) => x.id === id).length}`, rate('pair|context|est', id), rate('pair|bassRoot|est', id), rate('pair|context|true', id), rate('pair|bassRoot|true', id)],
    ])));
  }
  console.log(out.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') cmdRun(rest);
  else if (cmd === 'report') cmdReport();
  else {
    console.error('usage: t9_pairs.ts run [--shard k/n] | report');
    process.exit(2);
  }
}
