/**
 * Spike 5 T13: Node speed and memory of analyzeDrums per level on the 1 / 3 / 5 min concatenations that drumPerf.spec.ts
 * writes (out/drum/t13/concat-<n>min.wav; tuning / kit A / D2 only). One fresh process per run (so VmHWM is per run):
 *   npx tsx ts/browser/drumPerfNode.ts <minutes> <level> [bpm]      (from spikes/analysis)
 * Prints one JSON line: analysis ms, RSS before (after reading the wav), peak (VmHWM), increase.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeDrums } from '../drum/analyze';
import { resolveDrumConfig } from '../drum/config';
import type { DrumLevel } from '../drum/types';
import { decodeWav } from './wav';

const [minArg, levelArg, bpmArg] = process.argv.slice(2);
const min = Number(minArg);
const level = levelArg as DrumLevel;
if (![1, 3, 5].includes(min) || !['S-3', 'S-9', 'S-ext'].includes(level)) throw new Error('usage: drumPerfNode.ts <1|3|5> <S-3|S-9|S-ext> [bpm]');
const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+) kB`).exec(readFileSync('/proc/self/status', 'utf8'))![1]) / 1024;

const wav = decodeWav(new Uint8Array(readFileSync(join(import.meta.dirname, '../../out/drum/t13', `concat-${min}min.wav`))));
const samples = wav.channels[0];
global.gc?.();
const before = kb('VmRSS');
const t0 = performance.now();
const r = analyzeDrums({ bpm: Number(bpmArg ?? 110), ts: [4, 4], startSec: 0, samples, sampleRate: wav.sampleRate, level }, resolveDrumConfig({}));
const ms = performance.now() - t0;
const peak = kb('VmHWM');
console.log(JSON.stringify({ minutes: min, level, analysisMs: Math.round(ms), hits: r.drums.length, rssBeforeMb: Math.round(before), rssPeakMb: Math.round(peak), rssIncreaseMb: Math.round(peak - before) }));
