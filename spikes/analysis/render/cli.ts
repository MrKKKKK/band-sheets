// Renders all variants into spikes/analysis/out/ (run from spikes/analysis:
// `npx tsx render/cli.ts [--out DIR] [--only GLOB]`). Writes <song>/<name>.wav +
// .truth.json, manifest.json and out/etude/etude.bandsheet. Without --only it
// clears the generated files of out/saints and out/etude first; with --only
// (a glob on variant names, `*` and `?`) it renders just those, deletes
// nothing and merges them into the existing manifest.json (spike 2, T4). Variants may be prefixed with a lead-in silence and every wav
// ends with a release tail, so wav length > truth `durationSec` (see types.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordEtude, chordEtudeAABA } from './etude';
import { modulatedBars, modulateSong, modulationKeys, transposeMelodyBars } from './modulate';
import { pianoPartBody, recComp } from './pianoPart';
import {
  buildManifest,
  cleanGenerated,
  EXPECTED_ALPHATAB,
  gitCommit,
  mergeManifestVariants,
  peakStats,
  variantExtras,
} from './manifest';
import { MASTER_VOLUME, renderAudio, SOUND_FONT, SOUND_FONT_FILES, TAIL_SEC } from './renderAudio';
import {
  ALPHATAB_VERSION,
  applyPickup,
  applyTempoCurve,
  buildScoreTex,
  buildTruth,
  generateMidi,
  importScore,
  setPrograms,
} from './truth';
import { allVariants, ETUDE_SEED } from './variants';
import type { Variant } from './types';
import { encodeWav } from './wav';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const OUT = resolve(argOf('--out') ?? fileURLToPath(new URL('../out/', import.meta.url)));
const ONLY = argOf('--only');
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const etude = chordEtude(ETUDE_SEED);
const saints = parseSong(saintsSampleText);
const saintsTimeline = chordTimeline(saints);

/** Songs and timelines per variant: the etude depends on its seed / 7th share. */
const etudeCache = new Map<string, { text: string; song: ReturnType<typeof parseSong>; timeline: ReturnType<typeof chordTimeline> }>();
function songOf(v: Variant) {
  if (v.song === 'saints') return { song: saints, timeline: saintsTimeline, bandsheet: null, text: undefined };
  const seed = v.etudeSeed ?? ETUDE_SEED;
  const key = `${seed}:${v.seventhShare ?? ''}:${v.vocabShare ?? ''}:${v.etudeForm ?? ''}:${v.pickupBeats ?? ''}`;
  let e = etudeCache.get(key);
  if (!e) {
    const text =
      key === `${ETUDE_SEED}::::` ? etude.text
      : v.etudeForm === 'aaba' ? chordEtudeAABA(seed, v.pickupBeats ?? 1).text
      : chordEtude(seed, v.seventhShare, v.vocabShare).text;
    const song = parseSong(text);
    e = { text, song, timeline: chordTimeline(song) };
    etudeCache.set(key, e);
  }
  const plain = v.etudeSeed === undefined && v.seventhShare === undefined && v.vocabShare === undefined && v.etudeForm === undefined;
  const bandsheet = plain ? 'etude.bandsheet'
    : `etude-seed${seed}${v.seventhShare !== undefined ? `-sev${v.seventhShare}` : ''}${v.vocabShare !== undefined ? `-voc${v.vocabShare}` : ''}${v.etudeForm ? `-${v.etudeForm}${v.pickupBeats ?? ''}` : ''}.bandsheet`;
  return { song: e.song, timeline: e.timeline, bandsheet, text: e.text };
}

if (ALPHATAB_VERSION !== EXPECTED_ALPHATAB) {
  console.warn(
    `warning: alphaTab ${ALPHATAB_VERSION} (validated with ${EXPECTED_ALPHATAB}); rerun the whole spike 0 pipeline (T9) and check the truth`,
  );
}
// Drop stale outputs of renamed/removed variants (only files this CLI generates; never with --only).
if (ONLY === undefined) {
  const removed = cleanGenerated(OUT, ['saints', 'etude']);
  if (removed.length > 0) console.log(`cleaned ${removed.length} stale files`);
}
const selected = allVariants().filter((v) => ONLY === undefined || globRe(ONLY).test(v.name));
if (selected.length === 0) throw new Error(`--only ${ONLY} に合う変化形がありません`);

mkdirSync(join(OUT, 'saints'), { recursive: true });
mkdirSync(join(OUT, 'etude'), { recursive: true });
writeFileSync(join(OUT, 'etude', 'etude.bandsheet'), etude.text);

const manifestVariants: Record<string, unknown>[] = [];
let clippedTotal = 0;
const t0 = Date.now();
let totalBytes = 0;
for (const v of selected) {
  const t = Date.now();
  const base = songOf(v);
  const { bandsheet, text } = base;
  if (bandsheet && text && bandsheet !== 'etude.bandsheet' && !v.modulation) writeFileSync(join(OUT, 'etude', bandsheet), text);
  // Modulation variant (spike 2, T23): transposed chart sections -> chord timeline; the melody bars follow below.
  const m = v.modulation;
  if (m && v.pickupBeats) throw new Error(`「${v.name}」: 転調と弱起は一緒に使えません`);
  const song = m ? modulateSong(base.song, m) : base.song;
  const written = m ? chordTimeline(song) : base.timeline;
  // comp 'rec' also moves anticipated chord changes: the truth follows the returned timeline.
  const rec = v.comp === 'rec' ? recComp(written, { seed: v.recSeed, pickupBeats: v.pickupBeats ?? 0 }) : null;
  const timeline = rec ? rec.timeline : written;
  if (!rec && v.pickupBeats) throw new Error(`「${v.name}」: 弱起は comp 'rec' だけで扱えます`);
  const score = importScore(buildScoreTex(song, rec ? rec.body : pianoPartBody(written, v.comp), v));
  if (m) transposeMelodyBars(score, modulatedBars(base.timeline, m), m.semitones);
  applyTempoCurve(score, v);
  setPrograms(score);
  const midi = generateMidi(score);
  let { samples, sampleRate } = renderAudio(midi, {
    click: v.click,
    leadInSec: v.leadInSec,
    soundFont: v.soundFont,
    pianoGainDb: v.pianoGainDb,
  });
  let truth = buildTruth({
    score,
    midi,
    timeline,
    variant: v,
    key: m ? m.baseKey : song.meta.key,
    ...(m ? { keys: modulationKeys(base.timeline, m) } : {}),
    sampleRate,
    soundFont: SOUND_FONT_FILES[v.soundFont ?? 'sonivox'],
    audioSec: samples.length / sampleRate,
  });
  if (v.pickupBeats) {
    // Cut the silent start of the pickup bar, keeping 10 ms before the pickup beat (the synth's attack
    // starts a few samples early), so the wav begins with the pickup. The truth shifts by the exact cut.
    const pickupSec = truth.beats!.find((b) => b.bar === 0 && b.beat === 4 - v.pickupBeats!)!.t;
    const cut = Math.round(pickupSec * sampleRate) - Math.round(0.01 * sampleRate);
    const head = peakStats(samples.subarray(0, cut)).peak;
    if (head > 1e-4) throw new Error(`「${v.name}」: 弱起の前が無音ではありません（peak ${head}）`);
    samples = samples.slice(cut);
    truth = applyPickup(truth, cut / sampleRate, v.pickupBeats);
  }
  const { peak, clipped } = peakStats(samples);
  clippedTotal += clipped;
  const wav = `${v.song}/${v.name}.wav`;
  const tr = `${v.song}/${v.name}.truth.json`;
  const bytes = encodeWav(samples, sampleRate);
  writeFileSync(join(OUT, wav), bytes);
  writeFileSync(join(OUT, tr), JSON.stringify(truth, null, 1));
  totalBytes += bytes.length;
  manifestVariants.push({
    name: v.name,
    song: v.song,
    mix: v.mix,
    tempo: v.tempo,
    swing: v.swing,
    click: v.click,
    leadInSec: v.leadInSec ?? 0,
    audioSec: truth.source.audioSec,
    ...variantExtras(v),
    peak: Math.round(peak * 1e4) / 1e4,
    wav,
    truth: tr,
  });
  console.log(
    `${v.name}: ${(samples.length / sampleRate).toFixed(1)} s audio, ${(bytes.length / 1e6).toFixed(1)} MB, peak ${peak.toFixed(3)}, ${Date.now() - t} ms`,
  );
}
const manifest = buildManifest(
  {
    alphaTab: ALPHATAB_VERSION,
    etudeSeed: ETUDE_SEED,
    soundFont: SOUND_FONT,
    gitCommit: gitCommit(fileURLToPath(new URL('.', import.meta.url))),
    generatedAt: new Date().toISOString(),
    masterVolume: MASTER_VOLUME,
    tailSec: TAIL_SEC,
  },
  ONLY === undefined
    ? manifestVariants
    : mergeManifestVariants(
        allVariants().map((v) => v.name),
        manifestVariants,
        existsSync(join(OUT, 'manifest.json')) ? (JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')).variants ?? []) : [],
      ),
);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
if (clippedTotal > 0) console.warn(`warning: ${clippedTotal} samples clipped in total`);
console.log(
  `done: ${manifest.variants.length} variants, ${(totalBytes / 1e6).toFixed(0)} MB wav, ${Date.now() - t0} ms (alphaTab ${ALPHATAB_VERSION})`,
);
