// Spike 5 T2: truth JSON of a synthetic drum variant.
//
// <name>.truth.json is an AnalysisResult (render/types.ts) with
//   drums        every hit: t = placed onset (s, = the audible onset of the hit in this wav, ±1 ms, check.ts),
//                inst (incl. the S-拡張 names), strength = velocity / 127, confidence 1, bar (0-based), tick (written,
//                from the bar start, whole = 64), mark 'g' / 'ac'.
//   swing        {kind, confidence 1} for a shuffle pattern, swingBars per bar {bar, kind, ratio}.
//   drum.truth   the T3 scorer's DrumTruth (ts/drum/score.ts): hits, barTicks, barStartsSec (grid bar heads, no
//                swing / jitter; nBars + 1 values), swingBars, bpm.
//   drum.info    DrumInfo (what the user would type): bpm, ts, startSec = bar 1 head.
//   drum.score   the app score: style, shuffle, DrumEvent[] and its alphaTex body (serializeDrums; parseDrums reads
//                it back to the same events, render/drum/notation.test.ts). S-拡張 hits are written as their base
//                piece (`writtenAs`), the truth keeps their own name.
//   drum.variant name, style, level 'D0'..'D3', seed, kit, split, heldOut, ext.
//   drum.synth   the drawn DrumSynthParams (mic, room, noise, jitter, swing ratio, tuning, ...).
// Synthetic only: no recording is ever written here.

import type { DrumEvent } from '../../../../src/lib/drum';
import { serializeDrums } from '../../../../src/lib/drumTex';
import type { AnalysisDrumHit, AnalysisResult } from '../types';
import type { DrumInfo } from '../../ts/drum/types';
import type { DrumTruth } from '../../ts/drum/score';
import { barTicksOf, timeSig } from './notation';
import type { Pattern } from './patterns';
import type { PlacedHit } from './render';
import type { DrumSynthParams, DrumVariant } from './variants';

export const DRUM_SYNTH_VERSION = 'drum-synth-1';

export interface DrumTruthFile extends AnalysisResult {
  drums: AnalysisDrumHit[];
  drum: {
    truth: DrumTruth;
    info: DrumInfo;
    score: { style: string; shuffle: Pattern['shuffle']; ts: [number, number]; nBars: number; fillBars: number[]; events: DrumEvent[]; tex: string };
    variant: { name: string; style: string; level: string; seed: number; kit: string; split: string; heldOut: boolean; ext: boolean };
    synth: DrumSynthParams;
  };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function buildDrumTruth(
  v: DrumVariant,
  p: DrumSynthParams,
  pattern: Pattern,
  events: DrumEvent[],
  placed: PlacedHit[],
  sr: number,
  endSec: number,
  audioSec: number,
): DrumTruthFile {
  const hits = [...placed].sort((a, b) => a.at - b.at || a.inst.localeCompare(b.inst));
  const drums: AnalysisDrumHit[] = hits.map((h) => ({
    t: r6(h.at / sr),
    inst: h.inst,
    strength: Math.round((h.velocity / 127) * 1e4) / 1e4,
    confidence: 1,
    bar: h.bar,
    tick: h.tick,
    ...(h.mark ? { mark: h.mark } : {}),
  }));
  const bt = barTicksOf(pattern.ts);
  const nBars = pattern.bars.length;
  const barSec = (bt * 60) / p.bpm / (64 / pattern.ts[1]);
  const shuffled = pattern.shuffle !== 'none';
  const swingBars = pattern.bars.map((_, bar) => ({ bar, kind: pattern.shuffle, ratio: shuffled ? r6(p.swingRatio) : 0.5 }));
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'synthetic', durationSec: r6(endSec), click: false, leadInSec: r6(p.leadSec), audioSec: r6(audioSec) },
    analyzer: { name: 'truth', version: DRUM_SYNTH_VERSION, methods: ['drum-synth'] },
    timeSignature: { num: pattern.ts[0], den: pattern.ts[1], confidence: 1 },
    drums,
    ...(shuffled ? { swing: { kind: pattern.shuffle as '8' | '16', confidence: 1 } } : {}),
    swingBars,
    drum: {
      truth: {
        hits: drums.map((d) => ({ t: d.t, inst: d.inst, bar: d.bar!, tick: d.tick!, ...(d.mark ? { mark: d.mark } : {}) })),
        barTicks: bt,
        barStartsSec: Array.from({ length: nBars + 1 }, (_, b) => r6(p.startSec + b * barSec)),
        swingBars: swingBars.map(({ bar, kind }) => ({ bar, kind })),
        bpm: p.bpm,
      },
      info: { bpm: p.bpm, ts: pattern.ts, startSec: r6(p.startSec) },
      score: {
        style: pattern.style,
        shuffle: pattern.shuffle,
        ts: pattern.ts,
        nBars,
        fillBars: pattern.fillBars,
        events,
        tex: serializeDrums(events, pattern.shuffle, timeSig(pattern.ts)),
      },
      variant: { name: v.name, style: v.style, level: `D${v.level}`, seed: v.seed, kit: v.kit, split: v.split, heldOut: v.heldOut, ext: v.ext },
      synth: { ...p },
    },
  };
}
