// Spike 5 T2: renders the synthetic drum variants (docs/audio-spike5-plan.md section 4).
//
// Run from spikes/analysis:  npx tsx render/drum/cli.ts [--out DIR] [--only GLOB] [--check [N]] [--list]
//   default out: out/drum/ (gitignored). Writes <name>.wav (mono 16-bit, 44.1 kHz), <name>.truth.json
//   (render/drum/truth.ts) and manifest.json. Without --only, the wav/truth files of the out dir are removed first
//   (stale names); with --only (glob on names, * and ?) only those are rendered and merged into the existing
//   manifest. --check measures the truth-vs-audio onset error of every N-th hit (default 1 = all; check.ts) and
//   exits 1 when one is over 1 ms. --list prints names and splits and exits.
// Needs soundfonts/MuseScore_General.sf2 (fetch-soundfont.sh + render/sf3ToSf2.py) and drumkits/ (fetch-drum-samples.sh).
// Held-out variants (kit C, held-out room) are rendered like spike 4's and flagged `heldOut: true` in the manifest
// and the truth; analysis CLIs must refuse them (ts/hum/heldout_guard.ts pattern, T8). The check prints aggregates only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGenerated, gitCommit, mergeManifestVariants } from '../manifest';
import { checkOnsets, ONSET_TOL_SEC, type OnsetCheck } from './check';
import { KIT_DIRS, SAMPLE_RATE } from './kits';
import { renderDrum } from './render';
import { DRUM_SYNTH_VERSION } from './truth';
import { allDrumVariants, DRUM_LEVELS, DRUM_SETS, SPLITS, TAIL_SEC, type DrumSplit } from './variants';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const OUT = resolve(argOf('--out') ?? fileURLToPath(new URL('../../out/drum/', import.meta.url)));
const ONLY = argOf('--only');
const ci = process.argv.indexOf('--check');
const CHECK = ci >= 0;
const CHECK_EVERY = CHECK && process.argv[ci + 1] && !process.argv[ci + 1].startsWith('--') ? Number(process.argv[ci + 1]) : 1;
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const all = allDrumVariants();
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
const checks: { v: (typeof all)[number]; c: OnsetCheck }[] = [];
let clippedVariants = 0;
const t0 = performance.now();
for (const v of selected) {
  const t = performance.now();
  const r = renderDrum(v);
  const ms = performance.now() - t;
  times.push(ms);
  writeFileSync(join(OUT, `${v.name}.wav`), r.wav);
  writeFileSync(join(OUT, `${v.name}.truth.json`), JSON.stringify(r.truth));
  if (r.clipped > 0) clippedVariants++;
  const p = r.params;
  entries.push({
    name: v.name,
    style: v.style,
    level: `D${v.level}`,
    seed: v.seed,
    kit: v.kit,
    split: v.split,
    heldOut: v.heldOut,
    ext: v.ext,
    bpm: p.bpm,
    ts: r.pattern.ts,
    shuffle: r.pattern.shuffle,
    startSec: r.truth.drum.info.startSec,
    mic: p.mic,
    room: p.room.kind,
    noiseSnrDb: p.noiseSnrDb,
    hits: r.truth.drums.length,
    audioSec: r.truth.source.audioSec,
    wav: `${v.name}.wav`,
    truth: `${v.name}.truth.json`,
    peak: Math.round(r.peak * 1e4) / 1e4,
    clipped: r.clipped,
    renderMs: Math.round(ms),
  });
  if (CHECK) checks.push({ v, c: checkOnsets(v, CHECK_EVERY) });
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
      generator: DRUM_SYNTH_VERSION,
      gitCommit: gitCommit(fileURLToPath(new URL('.', import.meta.url))),
      generatedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      tailSec: TAIL_SEC,
      splits: SPLITS,
      sets: DRUM_SETS,
      heldOutRoom: 'fdn',
      kits: {
        A: 'soundfonts/MuseScore_General.sf2 (from the pinned sf3)',
        B: `drumkits/${KIT_DIRS.B}`,
        C: `drumkits/${KIT_DIRS.C}`,
        D: `drumkits/${KIT_DIRS.D} (MuldjordKit, CC-BY 4.0, tuning only)`,
        H: 'kit A drums + kit D HH/HO/RD/RD.bell/CR/CN (tuning only)',
      },
      variants,
    },
    null,
    1,
  ),
);

// ---- summary: counts per level x split, render time ----
const splits: DrumSplit[] = ['tuning', 'dev', 'heldOut'];
console.log(`rendered ${selected.length} variants into ${OUT} in ${(totalMs / 1000).toFixed(1)} s`);
console.log(`render time per variant: max ${Math.max(...times).toFixed(0)} ms, mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)} ms`);
console.log(['level', ...splits, 'total'].join('\t'));
for (const l of DRUM_LEVELS) {
  const row = splits.map((s) => selected.filter((v) => v.level === l && v.split === s).length);
  console.log([`D${l}`, ...row, row.reduce((a, b) => a + b, 0)].join('\t'));
}
if (clippedVariants > 0) console.warn(`warning: ${clippedVariants} variants have clipped samples`);

if (CHECK) {
  let failed = 0;
  for (const l of DRUM_LEVELS) {
    const cs = checks.filter((c) => c.v.level === l);
    if (cs.length === 0) continue;
    const n = cs.reduce((a, c) => a + c.c.checked, 0);
    const ok = cs.reduce((a, c) => a + c.c.passed, 0);
    const max = Math.max(...cs.map((c) => c.c.maxAbsSec));
    console.log(`check D${l}: ${ok}/${n} hits within ±${ONSET_TOL_SEC * 1000} ms, max |err| ${(max * 1000).toFixed(3)} ms`);
    for (const c of cs) if (c.c.passed < c.c.checked) {
      failed++;
      // held-out names are fine to print (synthetic), but keep the line to counts
      console.error(`  FAIL ${c.v.name}: ${c.c.passed}/${c.c.checked} (max ${(c.c.maxAbsSec * 1000).toFixed(3)} ms)`);
    }
  }
  if (failed > 0) process.exit(1);
}
