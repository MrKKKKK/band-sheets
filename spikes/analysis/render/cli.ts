// Renders all variants into spikes/analysis/out/ (run from spikes/analysis:
// `npx tsx render/cli.ts`). Writes <song>/<name>.wav + .truth.json, manifest.json
// and out/etude/etude.bandsheet. Clears the generated files of out/saints and
// out/etude first. Variants may be prefixed with a lead-in silence and every wav
// ends with a release tail, so wav length > truth `durationSec` (see types.ts).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSong } from '../../../src/lib/parseSong';
import { saintsSampleText } from '../../../src/lib/saintsSample';
import { chordTimeline } from './chordTimeline';
import { chordEtude } from './etude';
import { pianoPartBody } from './pianoPart';
import {
  buildManifest,
  cleanGenerated,
  EXPECTED_ALPHATAB,
  gitCommit,
  peakStats,
} from './manifest';
import { MASTER_VOLUME, renderAudio, SOUND_FONT, TAIL_SEC } from './renderAudio';
import {
  ALPHATAB_VERSION,
  buildScoreTex,
  buildTruth,
  generateMidi,
  importScore,
  setPrograms,
} from './truth';
import { allVariants, ETUDE_SEED } from './variants';
import { encodeWav } from './wav';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

const etude = chordEtude(ETUDE_SEED);
const texts = { saints: saintsSampleText, etude: etude.text };
const songs = { saints: parseSong(texts.saints), etude: parseSong(texts.etude) };
const timelines = {
  saints: chordTimeline(songs.saints),
  etude: chordTimeline(songs.etude),
};

if (ALPHATAB_VERSION !== EXPECTED_ALPHATAB) {
  console.warn(
    `warning: alphaTab ${ALPHATAB_VERSION} (validated with ${EXPECTED_ALPHATAB}); rerun the whole spike 0 pipeline (T9) and check the truth`,
  );
}
// Drop stale outputs of renamed/removed variants (only files this CLI generates).
const removed = cleanGenerated(OUT, ['saints', 'etude']);
if (removed.length > 0) console.log(`cleaned ${removed.length} stale files`);

mkdirSync(join(OUT, 'saints'), { recursive: true });
mkdirSync(join(OUT, 'etude'), { recursive: true });
writeFileSync(join(OUT, 'etude', 'etude.bandsheet'), etude.text);

const manifestVariants: Record<string, unknown>[] = [];
let clippedTotal = 0;
const t0 = Date.now();
let totalBytes = 0;
for (const v of allVariants()) {
  const t = Date.now();
  const song = songs[v.song];
  const timeline = timelines[v.song];
  const score = importScore(buildScoreTex(song, pianoPartBody(timeline), v));
  setPrograms(score);
  const midi = generateMidi(score);
  const { samples, sampleRate } = renderAudio(midi, {
    click: v.click,
    leadInSec: v.leadInSec,
  });
  const truth = buildTruth({
    score,
    midi,
    timeline,
    variant: v,
    key: song.meta.key,
    sampleRate,
    soundFont: SOUND_FONT,
    audioSec: samples.length / sampleRate,
  });
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
  manifestVariants,
);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
if (clippedTotal > 0) console.warn(`warning: ${clippedTotal} samples clipped in total`);
console.log(
  `done: ${manifest.variants.length} variants, ${(totalBytes / 1e6).toFixed(0)} MB wav, ${Date.now() - t0} ms (alphaTab ${ALPHATAB_VERSION})`,
);
