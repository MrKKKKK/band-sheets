/**
 * Spike 7 T17: the numbers of the app-target bass config (config.ts `appBassConfig()`: spike 6's G2 config without
 * `redecideRoot`, hash 77cc49d1ca67) on the TUNING synthetic sets the T7 baseline used (same material, same metrics,
 * same group names; docs/audio-spike7-t17.md). NOT a look: no dev / hold-out / recording file is opened (baseline.ts
 * `items()` selects tuning by the manifest flags, `loadTruth` checks the truth file's own flags). The app config's dev /
 * recording numbers are NOT measured.
 *
 *   npx tsx ts/chords2/eval/appBass.ts run [--shard k/n]   -> out/chords2-t17/cache (one row `bassApp` per file)
 *   npx tsx ts/chords2/eval/appBass.ts report              -> table (rows v1a / bassT8 / bassG2 from the T7 cache, bassApp)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../../browser/wav';
import { applyBass } from '../../bass/analyze';
import { bassConfigHash } from '../../bass/config';
import { argOf, json } from '../../bass/evalCommon';
import { lowCqt } from '../../bass/lowCqt';
import { analyze as analyzeV1 } from '../../dsp/analyze';
import { toMono } from '../../dsp/core/resample';
import { appBassConfig } from '../config';
import { addFile, newAgg, summarize, type Agg } from './baselineAgg';
import { ci, f1, f3, items, loadTruth, slim, table, type Cached } from './baseline';
import { prepareInput } from './input';
import { editCounts, scoreChords, type EvalChord, type Vocab } from './score';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const BASE = join(ROOT, 'out', 'chords2-baseline', 'cache');
const OUT = join(ROOT, 'out', 'chords2-t17', 'cache');
const GROUPS = ['B', 'V1', 'V2', 'V3', 'pair', 'B0', 'B1', 'B2', 'B3', 'L0', 'L1', 'L2', 'L3', 'LR', 'LV'];

function run(argv: string[]): void {
  const [k, n] = (argOf(argv, '--shard') ?? '0/1').split('/').map(Number);
  mkdirSync(OUT, { recursive: true });
  const cfg = appBassConfig();
  let done = 0;
  items().forEach((it, i) => {
    const p = join(OUT, `${it.name}.json`);
    if (i % n !== k || existsSync(p)) return;
    loadTruth(it); // flag check only; the truth is not scored here
    const w = decodeWav(new Uint8Array(readFileSync(it.wav)));
    const y = prepareInput(toMono(w.channels), w.sampleRate, true).y;
    const v1 = analyzeV1(y.slice());
    const row = slim(applyBass(lowCqt(y, cfg.lowCqt), v1.result, cfg).chords);
    writeFileSync(p, JSON.stringify({ name: it.name, hash: bassConfigHash(cfg), rows: { bassApp: row } }));
    done++;
  });
  console.log(`shard ${k}/${n}: ${done} files`);
}

function report(): void {
  const ROWS = ['v1a', 'bassT8', 'bassG2', 'bassApp'] as const;
  const A: Record<string, Agg> = {};
  let files = 0;
  let hash = '';
  for (const it of items()) {
    const q = join(OUT, `${it.name}.json`);
    const b = join(BASE, `${it.name}.json`);
    if (!existsSync(q) || !existsSync(b)) continue;
    const app = json<{ hash: string; rows: { bassApp: EvalChord[] } }>(q);
    const base = json<Cached>(b);
    hash = app.hash;
    const t = loadTruth(it);
    files++;
    const level = it.level;
    for (const row of ROWS) {
      const res = row === 'bassApp' ? app.rows.bassApp : base.rows[row];
      for (const v of ['full', 'down'] as const) {
        const s = scoreChords(t.chords, res, t.beats, v);
        const e = editCounts(t.chords, res, t.beats, v);
        for (const g of [level, 'ALL']) addFile((A[`${v}|${row}|${g}`] ??= newAgg()), s, e);
      }
    }
  }
  const groups = GROUPS.filter((g) => A[`down|bassApp|${g}`]);
  const cols = [...groups, 'ALL'];
  const S = (v: Vocab, row: string, g: string) => summarize(A[`${v}|${row}|${g}`] ?? newAgg());
  const per = (f: (v: Vocab, row: string, g: string) => string, v: Vocab): [string, string[]][] => ROWS.map((r) => [r, cols.map((g) => f(v, r, g))]);
  const out = [`# T17: app-target bass config (hash ${hash}) on the T7 tuning material: ${files} files (no look; dev / recording not measured)`];
  out.push(table('名前の当たり 落（点の割合 [区間単位の Wilson 95 %]）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.name.rate)} ${ci(s.name.wilson)}`; }, 'down')));
  out.push(table('/X の点のルート 落', cols, per((v, r, g) => { const s = S(v, r, g); return s.slashRoot.units ? `${f3(s.slashRoot.rate)} ${ci(s.slashRoot.wilson)}` : '-'; }, 'down')));
  out.push(table('分数 P / R / F 落', cols, per((v, r, g) => { const s = S(v, r, g); return s.slash.truth ? `${f3(s.slash.p)}/${f3(s.slash.r)}/${f3(s.slash.f)}` : '-'; }, 'down')));
  out.push(table('誤った /X 落（括弧は和音のある点だけ）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f3(s.wrongSlash)} (${f3(s.wrongSlashOnChord)})`; }, 'down')));
  out.push(table('直す手数 / 100 拍 落（括弧は候補から選べば直せる数）', cols, per((v, r, g) => { const s = S(v, r, g); return `${f1(s.editsPer100)} (${f1(s.editsFixablePer100)})`; }, 'down')));
  console.log(out.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') run(rest);
  else if (cmd === 'report') report();
  else {
    console.error('usage: appBass.ts run [--shard k/n] | report');
    process.exit(2);
  }
}
