// Renders the private chart-based songs (spike 2, T28). Run from spikes/analysis, AFTER `python py/charts.py`:
//   npx tsx render/chartsCli.ts [--charts recordings/charts] [--out DIR] [--only GLOB]
// Reads <charts>/chart-NN.song.json (gitignored) and writes <out>/charts/chart-NN-{block,rec,rechard}.{wav,truth.json}
// plus <out>/charts/manifest.charts.json (entries private: true, level CH, merged by name). Only anonymous ids are
// printed. Nothing under <out>/charts or <charts> may ever be committed or uploaded.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartBlockBody, chartKeys, chartSongFor, chartTimeline, chartVariants, validateChartSong } from './charts';
import { peakStats, variantExtras } from './manifest';
import { REC_HARD, recComp } from './pianoPart';
import { renderAudio, SOUND_FONT_FILES } from './renderAudio';
import { applyPickup, applyTempoCurve, buildScoreTex, buildTruth, generateMidi, importScore, setPrograms } from './truth';
import { encodeWav } from './wav';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} の値がありません`);
  return v;
}
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHARTS = resolve(argOf('--charts') ?? join(HERE, '../recordings/charts'));
const OUT = resolve(argOf('--out') ?? join(HERE, '../out'));
const ONLY = argOf('--only');
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

const files = existsSync(CHARTS) ? readdirSync(CHARTS).filter((f) => /^chart-\d+\.song\.json$/.test(f)).sort() : [];
if (files.length === 0) {
  console.log('chart-NN.song.json がありません。先に python py/charts.py を実行してください。');
  process.exit(0);
}
mkdirSync(join(OUT, 'charts'), { recursive: true });
const manifestPath = join(OUT, 'charts', 'manifest.charts.json');
const previous: Record<string, unknown>[] = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')).variants ?? []) : [];
const fresh: Record<string, unknown>[] = [];

for (const f of files) {
  const cs = validateChartSong(JSON.parse(readFileSync(join(CHARTS, f), 'utf8')));
  const written = chartTimeline(cs);
  const song = chartSongFor(cs);
  for (const v of chartVariants(cs)) {
    if (ONLY !== undefined && !globRe(ONLY).test(v.name)) continue;
    const t = Date.now();
    const rec =
      v.comp === 'rec'
        ? recComp(written, { ...(v.recStyle === 'hard' ? REC_HARD : {}), seed: v.recSeed, pickupBeats: v.pickupBeats ?? 0 })
        : null;
    const timeline = rec ? rec.timeline : written;
    const score = importScore(buildScoreTex(song, rec ? rec.body : chartBlockBody(cs, written), v));
    applyTempoCurve(score, v);
    setPrograms(score);
    const midi = generateMidi(score);
    let { samples, sampleRate } = renderAudio(midi, { click: v.click, leadInSec: v.leadInSec, soundFont: v.soundFont, pianoGainDb: v.pianoGainDb });
    const keys = chartKeys(cs);
    let truth = buildTruth({
      score,
      midi,
      timeline,
      variant: v,
      ...(keys.length > 0 ? { key: keys[0].key, keys } : {}),
      sampleRate,
      soundFont: SOUND_FONT_FILES[v.soundFont ?? 'sonivox'],
      audioSec: samples.length / sampleRate,
    });
    if (v.pickupBeats) {
      const pickupSec = truth.beats!.find((b) => b.bar === 0 && b.beat === 4 - v.pickupBeats!)!.t;
      const cut = Math.round(pickupSec * sampleRate) - Math.round(0.01 * sampleRate);
      const head = peakStats(samples.subarray(0, cut)).peak;
      if (head > 1e-4) throw new Error(`${v.name}: 弱起の前が無音ではありません（peak ${head}）`);
      samples = samples.slice(cut);
      truth = applyPickup(truth, cut / sampleRate, v.pickupBeats);
    }
    const { peak } = peakStats(samples);
    const wav = `charts/${v.name}.wav`;
    const tr = `charts/${v.name}.truth.json`;
    writeFileSync(join(OUT, wav), encodeWav(samples, sampleRate));
    writeFileSync(join(OUT, tr), JSON.stringify(truth, null, 1));
    fresh.push({
      name: v.name,
      song: v.song,
      mix: v.mix,
      tempo: v.tempo,
      swing: v.swing,
      click: v.click,
      leadInSec: 0,
      audioSec: truth.source.audioSec,
      ...variantExtras(v),
      private: true,
      take: cs.id,
      peak: Math.round(peak * 1e4) / 1e4,
      wav,
      truth: tr,
    });
    console.log(`${v.name}: ${(samples.length / sampleRate).toFixed(1)} s, ${Date.now() - t} ms`);
  }
}
const freshNames = new Set(fresh.map((e) => e.name));
const variants = [...previous.filter((e) => !freshNames.has(e.name as string)), ...fresh].sort((a, b) =>
  (a.name as string).localeCompare(b.name as string),
);
writeFileSync(manifestPath, JSON.stringify({ variants }, null, 1));
console.log(`done: ${fresh.length} variants rendered, ${variants.length} in manifest.charts.json`);
