// Spike 7 T5: renders the synthetic chords2 material (docs/audio-spike7-plan.md section 3.1, docs/audio-spike7-t5.md).
//
// Run from spikes/analysis:  npx tsx render/chords2/cli.ts [--out DIR] [--only GLOB] [--check [N]] [--list]
//   default out: out/chords2/ (gitignored). Writes <name>.wav (mono 16-bit, 44.1 kHz), <name>.truth.json
//   (render/chords2/truth.ts) and manifest.json (every variant's split / heldOut, set, stage, counts, levels).
//   Without --only, the wav/truth files of the out dir are removed first; with --only (glob on names, * and ?) only
//   those are rendered and merged into the existing manifest. --check runs check.ts on every variant (every N-th note,
//   default 1 = all) and exits 1 when a note onset is over 1 ms off its truth or a segment's struck pitch classes are
//   not its truth chord's. --list prints names and splits.
// Needs soundfonts/MuseScore_General.sf2 (fetch-soundfont.sh + render/sf3ToSf2.py), basskits/ (fetch-bass-samples.sh)
// and, for held-out, pianokits/ (fetch-piano-samples.sh). Held-out variants (c2-h-*: piano P2, bass C, FDN room) are
// rendered and flagged `heldOut: true` in the manifest and the truth; analysis tools must refuse them (plan section 4).
// Output is aggregates only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGenerated, gitCommit, mergeManifestVariants } from '../manifest';
import { SAMPLE_RATE } from '../bass/timbres';
import { checkC2, ONSET_TOL_SEC, type C2Check } from './check';
import { CHORD_SETS } from './material';
import { renderC2 } from './render';
import { CHORDS2_SYNTH_VERSION } from './truth';
import { allC2Variants, C2_SETS, TAIL_SEC, VARIATIONS } from './variants';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const OUT = resolve(argOf('--out') ?? fileURLToPath(new URL('../../out/chords2/', import.meta.url)));
const ONLY = argOf('--only');
const ci = process.argv.indexOf('--check');
const CHECK = ci >= 0;
const CHECK_EVERY = CHECK && process.argv[ci + 1] && !process.argv[ci + 1].startsWith('--') ? Number(process.argv[ci + 1]) : 1;
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const all = allC2Variants();
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
const checks: { v: (typeof all)[number]; c: C2Check }[] = [];
let clippedVariants = 0;
let cutNotes = 0;
const t0 = performance.now();
for (const v of selected) {
  const t = performance.now();
  const r = renderC2(v);
  const ms = performance.now() - t;
  writeFileSync(join(OUT, `${v.name}.wav`), r.wav);
  writeFileSync(join(OUT, `${v.name}.truth.json`), JSON.stringify(r.truth));
  if (r.clipped > 0) clippedVariants++;
  cutNotes += r.truth.chords2.cutNotes;
  const p = r.params;
  const segs = r.truth.chords2.segments;
  entries.push({
    name: v.name,
    set: v.set,
    ...(v.phrase ? { phrase: v.phrase } : {}),
    stage: r.truth.chords2.variant.stage,
    variation: v.variation,
    seed: v.seed,
    split: v.split,
    heldOut: v.heldOut,
    piano: v.piano,
    bass: v.bass,
    bpm: p.bpm,
    leadSec: p.leadSec,
    transpose: p.transpose,
    comp: p.comp,
    lhStyle: p.lhStyle,
    jitterSec: p.jitterSec,
    room: p.room.kind,
    noiseSnrDb: p.noiseSnrDb,
    key: `${r.truth.key.tonic}${r.truth.key.mode === 'minor' ? 'm' : ''}`,
    chords: segs.length,
    qualities: Object.fromEntries([...new Set(r.truth.chords.map((c) => c.quality))].sort().map((q) => [q, r.truth.chords.filter((c) => c.quality === q).length])),
    slashChords: r.truth.chords.filter((c) => c.bass !== null).length,
    pairSegments: segs.filter((s) => s.pair).length,
    rows: segs.flatMap((s) => (s.rows ?? []).map((x) => x.id)),
    notes: r.truth.chords2.notes.length,
    cutNotes: r.truth.chords2.cutNotes,
    audioSec: r.truth.source.audioSec,
    wav: `${v.name}.wav`,
    truth: `${v.name}.truth.json`,
    peak: Math.round(r.peak * 1e4) / 1e4,
    crestDb: Math.round(r.crestDb * 10) / 10,
    clipped: r.clipped,
    renderMs: Math.round(ms),
  });
  if (CHECK) checks.push({ v, c: checkC2(v, CHECK_EVERY) });
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
      generator: CHORDS2_SYNTH_VERSION,
      gitCommit: gitCommit(fileURLToPath(new URL('.', import.meta.url))),
      generatedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      tailSec: TAIL_SEC,
      splits: C2_SETS.map((s) => ({ split: s.split, prefix: `c2-${s.letter}-`, seeds: s.seeds, piano: s.piano, bass: [...new Set(s.seeds.map(s.bass))] })),
      heldOutRoom: 'fdn',
      pianos: {
        P1: 'soundfonts/MuseScore_General.sf2 (from the pinned sf3), GM 0 (tuning, dev)',
        P2: 'pianokits/vsco_upright (VSCO 2 CE Upright Piano, CC0; held-out only)',
      },
      variants,
    },
    null,
    1,
  ),
);

// ---- summary: counts per set x split, render time ----
console.log(`rendered ${selected.length} variants into ${OUT} in ${(totalMs / 1000).toFixed(1)} s`);
console.log(['set', ...C2_SETS.map((s) => s.split), 'total', 'audio min'].join('\t'));
for (const set of CHORD_SETS) {
  const row = C2_SETS.map((s) => selected.filter((v) => v.set === set && v.split === s.split).length);
  const sec = entries.filter((e) => e.set === set).reduce((a, e) => a + (e.audioSec as number), 0);
  console.log([set, ...row, row.reduce((a, b) => a + b, 0), (sec / 60).toFixed(1)].join('\t'));
}
for (const variation of VARIATIONS) {
  const es = entries.filter((e) => e.variation === variation);
  if (es.length === 0) continue;
  const crest = es.map((e) => e.crestDb as number);
  console.log(`${variation}: ${es.length} files, crest ${Math.min(...crest)}-${Math.max(...crest)} dB, peak max ${Math.max(...es.map((e) => e.peak as number))}`);
}
if (clippedVariants > 0) console.warn(`warning: ${clippedVariants} variants have clipped samples`);
if (cutNotes > 0) console.warn(`warning: ${cutNotes} notes are longer than their voice (truth chords2.cutNotes)`);

if (CHECK) {
  const sum = (f: (c: C2Check) => number) => checks.reduce((a, c) => a + f(c.c), 0);
  const max = Math.max(...checks.map((c) => c.c.maxAbsSec));
  console.log(
    `check: ${sum((c) => c.passed)}/${sum((c) => c.checked)} notes within ±${ONSET_TOL_SEC * 1000} ms (max |err| ${(max * 1000).toFixed(4)} ms), ` +
      `${sum((c) => c.pcsOk)}/${sum((c) => c.segments)} segments play exactly their truth chord's pitch classes`,
  );
  let failed = 0;
  for (const c of checks)
    if (c.c.passed < c.c.checked || c.c.pcsOk < c.c.segments) {
      failed++;
      console.error(`  FAIL ${c.v.name}: onsets ${c.c.passed}/${c.c.checked}, pcs ${c.c.pcsOk}/${c.c.segments} ${c.c.pcsBad.join('; ')}`);
    }
  if (failed > 0) process.exit(1);
}
