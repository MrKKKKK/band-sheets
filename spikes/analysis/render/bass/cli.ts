// Spike 6 T2: renders the synthetic bass variants (docs/audio-spike6-plan.md section 4).
//
// Run from spikes/analysis:  npx tsx render/bass/cli.ts [--out DIR] [--only GLOB] [--check [N]] [--list]
//   default out: out/bass/ (gitignored). Writes <name>.wav (mono 16-bit, 44.1 kHz), <name>.truth.json
//   (render/bass/truth.ts) and manifest.json. Without --only, the wav/truth files of the out dir are removed first
//   (stale names); with --only (glob on names, * and ?) only those are rendered and merged into the existing
//   manifest. --check runs check.ts on every variant (every N-th note, default 1 = all) and exits 1 when a note onset
//   is over 1 ms off its truth or a chord's head note does not play the written bass. --list prints names and splits.
// Needs soundfonts/MuseScore_General.sf2 (fetch-soundfont.sh + render/sf3ToSf2.py) and basskits/ (fetch-bass-samples.sh).
// Held-out variants (timbre C, held-out room) are rendered and flagged `heldOut: true` in the manifest and the truth;
// analysis CLIs must refuse them. Output is aggregates only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGenerated, gitCommit, mergeManifestVariants } from '../manifest';
import { checkBass, ONSET_TOL_SEC, type BassCheck } from './check';
import { renderBass } from './render';
import { SAMPLE_RATE, SFZ_FILES, TIMBRE_GAIN } from './timbres';
import { BASS_SYNTH_VERSION } from './truth';
import { allBassVariants, BASS_LEVELS, BASS_SETS, levelLabel, SPLITS, TAIL_SEC, type BassSplit } from './variants';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const OUT = resolve(argOf('--out') ?? fileURLToPath(new URL('../../out/bass/', import.meta.url)));
const ONLY = argOf('--only');
const ci = process.argv.indexOf('--check');
const CHECK = ci >= 0;
const CHECK_EVERY = CHECK && process.argv[ci + 1] && !process.argv[ci + 1].startsWith('--') ? Number(process.argv[ci + 1]) : 1;
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const all = allBassVariants();
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
const checks: { v: (typeof all)[number]; c: BassCheck }[] = [];
let clippedVariants = 0;
let cutNotes = 0;
const t0 = performance.now();
for (const v of selected) {
  const t = performance.now();
  const r = renderBass(v);
  const ms = performance.now() - t;
  times.push(ms);
  writeFileSync(join(OUT, `${v.name}.wav`), r.wav);
  writeFileSync(join(OUT, `${v.name}.truth.json`), JSON.stringify(r.truth));
  if (r.clipped > 0) clippedVariants++;
  cutNotes += r.truth.bass.cutNotes;
  const p = r.params;
  const segs = r.truth.bass.segments;
  entries.push({
    name: v.name,
    style: v.style,
    level: levelLabel(v),
    seed: v.seed,
    timbre: v.timbre,
    split: v.split,
    heldOut: v.heldOut,
    bpm: p.bpm,
    leadSec: p.leadSec,
    comp: p.comp,
    pianoRoot: p.pianoRoot,
    drift: p.drift,
    room: p.room.kind,
    phone: p.phone,
    noiseSnrDb: p.noiseSnrDb,
    sectionKinds: r.truth.bass.sectionKinds.map((k) => k.kind),
    chords: segs.length,
    slashChords: (r.truth.chords ?? []).filter((c) => c.bass !== null).length,
    notes: r.truth.bassNotes.length,
    cutNotes: r.truth.bass.cutNotes,
    audioSec: r.truth.source.audioSec,
    wav: `${v.name}.wav`,
    truth: `${v.name}.truth.json`,
    peak: Math.round(r.peak * 1e4) / 1e4,
    clipped: r.clipped,
    renderMs: Math.round(ms),
  });
  if (CHECK) checks.push({ v, c: checkBass(v, CHECK_EVERY) });
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
      generator: BASS_SYNTH_VERSION,
      gitCommit: gitCommit(fileURLToPath(new URL('.', import.meta.url))),
      generatedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      tailSec: TAIL_SEC,
      splits: SPLITS,
      sets: BASS_SETS,
      heldOutRoom: 'fdn',
      timbres: {
        A: 'soundfonts/MuseScore_General.sf2 (from the pinned sf3), GM 33',
        B: `basskits/${SFZ_FILES.B} (sfz key = MIDI + 12)`,
        C: `basskits/${SFZ_FILES.C} (held-out only)`,
      },
      timbreGain: TIMBRE_GAIN,
      variants,
    },
    null,
    1,
  ),
);

// ---- summary: counts per level x split x timbre, render time ----
const cols: [BassSplit, string][] = BASS_SETS.flatMap((s) => s.timbres.map((t) => [s.split, t] as [BassSplit, string]));
console.log(`rendered ${selected.length} variants into ${OUT} in ${(totalMs / 1000).toFixed(1)} s`);
console.log(`render time per variant: max ${Math.max(...times).toFixed(0)} ms, mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)} ms`);
console.log(['level', ...cols.map(([s, t]) => `${s}/${t}`), 'total'].join('\t'));
for (const l of BASS_LEVELS) {
  const row = cols.map(([s, t]) => selected.filter((v) => v.level === l && v.split === s && v.timbre === t).length);
  console.log([`B${l}`, ...row, row.reduce((a, b) => a + b, 0)].join('\t'));
}
if (clippedVariants > 0) console.warn(`warning: ${clippedVariants} variants have clipped samples`);
if (cutNotes > 0) console.warn(`warning: ${cutNotes} notes are longer than their sample (truth bass.cutNotes)`);

if (CHECK) {
  let failed = 0;
  for (const l of BASS_LEVELS) {
    const cs = checks.filter((c) => c.v.level === l);
    if (cs.length === 0) continue;
    const sum = (f: (c: BassCheck) => number) => cs.reduce((a, c) => a + f(c.c), 0);
    const max = Math.max(...cs.map((c) => c.c.maxAbsSec));
    console.log(
      `check B${l}: ${sum((c) => c.passed)}/${sum((c) => c.checked)} notes within ±${ONSET_TOL_SEC * 1000} ms (max |err| ${(max * 1000).toFixed(4)} ms), ` +
        `${sum((c) => c.headsOk)}/${sum((c) => c.segments)} chord heads play the written bass`,
    );
    for (const c of cs)
      if (c.c.passed < c.c.checked || c.c.headsOk < c.c.segments) {
        failed++;
        console.error(`  FAIL ${c.v.name}: onsets ${c.c.passed}/${c.c.checked}, heads ${c.c.headsOk}/${c.c.segments}`);
      }
  }
  if (failed > 0) process.exit(1);
}
