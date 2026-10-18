// Spike 4 T1: renders all synthetic humming variants (docs/audio-spike4-plan.md section 4).
//
// Run from spikes/analysis:  npx tsx render/hum/cli.ts [--out DIR] [--only GLOB] [--check] [--list]
//   default out: out/hum/ (gitignored). Writes <name>.wav (mono 16-bit, 44.1 kHz), <name>.truth.json
//   (render/hum/truth.ts) and manifest.json. Without --only, the wav/truth files of out/hum are removed
//   first (stale names); with --only (glob on names, * and ?) only those are rendered and merged into
//   the existing manifest. --check runs the truth-vs-audio checks (render/hum/check.ts) and exits 1 on a
//   failure. --list prints the variant names and splits and exits.
// One step, TS only: py/degrade.py is not needed (see render/hum/degrade.ts for why).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGenerated, gitCommit, mergeManifestVariants } from '../manifest';
import { checkH0, checkSung, excursionStats, sungTolerance, type ExcursionStats, type NoteCheck } from './check';
import { renderHum } from './render';
import { F0_HOP_SEC, HUM_SYNTH_VERSION } from './truth';
import { allHumVariants, HUM_LEVELS, SAMPLE_RATE, TAIL_SEC, type HumSplit } from './variants';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const OUT = resolve(argOf('--out') ?? fileURLToPath(new URL('../../out/hum/', import.meta.url)));
const ONLY = argOf('--only');
const CHECK = process.argv.includes('--check');
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const all = allHumVariants();
if (process.argv.includes('--list')) {
  for (const v of all) console.log(`${v.name}\t${v.split}${v.heldOut ? '\theldOut' : ''}`);
  process.exit(0);
}
const selected = all.filter((v) => ONLY === undefined || globRe(ONLY).test(v.name));
if (selected.length === 0) throw new Error(`--only ${ONLY} に合う変化形がありません`);

mkdirSync(OUT, { recursive: true });
if (ONLY === undefined) {
  const removed = cleanGenerated(OUT, ['.']);
  if (removed.length > 0) console.log(`cleaned ${removed.length} stale files`);
}

const entries: Record<string, unknown>[] = [];
const times: number[] = [];
const checks: { level: number; name: string; split: HumSplit; c: NoteCheck; x: ExcursionStats | null }[] = [];
const t0 = performance.now();
for (const v of selected) {
  const t = performance.now();
  const r = renderHum(v);
  const ms = performance.now() - t;
  times.push(ms);
  writeFileSync(join(OUT, `${v.name}.wav`), r.wav);
  writeFileSync(join(OUT, `${v.name}.truth.json`), JSON.stringify(r.truth));
  if (r.clipped > 0) console.warn(`warning: ${v.name}: ${r.clipped} samples clipped`);
  entries.push({
    name: v.name,
    melody: v.melody,
    level: `H${v.level}`,
    seed: v.seed,
    split: v.split,
    heldOut: v.heldOut,
    bpm: r.score.bpm,
    ts: [4, 4],
    startSec: r.truth.hum.info.startSec,
    register: r.score.register,
    articulation: r.params.articulation,
    notes: r.truth.melody.notes.length,
    audioSec: r.truth.source.audioSec,
    wav: `${v.name}.wav`,
    truth: `${v.name}.truth.json`,
    peak: Math.round(r.peak * 1e4) / 1e4,
    clipped: r.clipped,
    renderMs: Math.round(ms),
  });
  if (CHECK) {
    const c = v.level === 0 ? checkH0(r.samples, SAMPLE_RATE, r.truth) : checkSung(r.samples, SAMPLE_RATE, r.truth, sungTolerance(r.truth));
    checks.push({ level: v.level, name: v.name, split: v.split, c, x: v.heldOut ? null : excursionStats(r.truth) });
  }
}
const totalMs = performance.now() - t0;

const manifestPath = join(OUT, 'manifest.json');
const previous: Record<string, unknown>[] =
  ONLY !== undefined && existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')).variants ?? []) : [];
const variants = ONLY === undefined ? entries : mergeManifestVariants(all.map((v) => v.name), entries, previous);
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generator: HUM_SYNTH_VERSION,
      gitCommit: gitCommit(fileURLToPath(new URL('.', import.meta.url))),
      generatedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      tailSec: TAIL_SEC,
      f0HopSec: F0_HOP_SEC,
      splits: { tuning: [1, 2, 3], dev: [4, 5], heldOut: [6, 7] },
      variants,
    },
    null,
    1,
  ),
);

// ---- summary: counts per level x split, render time ----
const splits: HumSplit[] = ['tuning', 'dev', 'heldOut'];
console.log(`rendered ${selected.length} variants into ${OUT} in ${(totalMs / 1000).toFixed(1)} s`);
console.log(`render time per variant: max ${Math.max(...times).toFixed(0)} ms, mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)} ms`);
console.log(['level', ...splits, 'total'].join('\t'));
for (const l of HUM_LEVELS) {
  const row = splits.map((s) => selected.filter((v) => v.level === l && v.split === s).length);
  console.log([`H${l}`, ...row, row.reduce((a, b) => a + b, 0)].join('\t'));
}
const slow = times.filter((t) => t > 1000).length;
if (slow > 0) console.warn(`warning: ${slow} variants took more than 1 s`);

if (CHECK) {
  let failed = 0;
  for (const l of HUM_LEVELS) {
    const cs = checks.filter((c) => c.level === l);
    if (cs.length === 0) continue;
    const sum = (f: (c: NoteCheck) => number) => cs.reduce((a, c) => a + f(c.c), 0);
    const max = Math.max(...cs.map((c) => c.c.maxAbsCents));
    console.log(
      `check H${l}: ${sum((c) => c.passed)}/${sum((c) => c.checked)} notes within tolerance (${sum((c) => c.skipped)} skipped as too short), max |err| ${max.toFixed(l === 0 ? 6 : 2)} cents`,
    );
    for (const sp of ['tuning', 'dev'] as HumSplit[]) {
      const xs = cs.filter((c) => c.split === sp && c.x !== null).map((c) => c.x!);
      if (xs.length === 0) continue;
      const n = xs.reduce((a, x) => a + x.notes, 0);
      const pct = (k: number) => `${((100 * k) / n).toFixed(1)} %`;
      const runs = xs.reduce((a, x) => a + x.runs, 0);
      const med = [...xs.map((x) => x.medianRunSec)].sort((a, b) => a - b)[xs.length >> 1];
      console.log(
        `  excursions H${l} ${sp}: notes with a 30-300 ms run off their main semitone ${pct(xs.reduce((a, x) => a + x.withExcursion, 0))}, after the onset transition ${pct(xs.reduce((a, x) => a + x.withInnerExcursion, 0))}, run >= 100 ms ${pct(xs.reduce((a, x) => a + x.withLongExcursion, 0))} (${runs} runs, median of per-variant median ${(med * 1000).toFixed(0)} ms, ${n} notes)`,
      );
    }
    for (const c of cs) if (c.c.passed < c.c.checked) {
      failed++;
      console.error(`  FAIL ${c.name}: ${c.c.passed}/${c.c.checked} (tol ${c.c.tolCents.toFixed(1)} c, max ${c.c.maxAbsCents.toFixed(1)} c)`);
    }
  }
  if (failed > 0) process.exit(1);
}
