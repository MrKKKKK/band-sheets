// Spike 4 T1: truth JSON of a synthetic humming variant (docs/audio-spike4-plan.md section 4: two truths).
//
// <name>.truth.json is an AnalysisResult (render/types.ts) with
//   melody.notes      SUNG-time notes (after jitter): {start, end, midi, confidence: 1, cents, startTick, ticks}
//                     `midi` = the score pitch, `cents` = where it was actually sung relative to `midi`
//                     (per-note offset + tuning + drift at the note centre; vibrato/glides/jitter excluded).
//                     start = onset of the note (attack start, or the boundary inside a legato phrase),
//                     end = next boundary or end of the release. For f0/segmentation scoring.
//   melody.quantized  SCORE-time notes: a QuantizedMelody (ts/hum/types.ts) on the 16th grid from bar 1,
//                     events consecutive from tick 0 (notes + rests); note.src = index into melody.notes.
//                     For quantization scoring. onsetBiasSec = 0, grid 'sixteenth'.
//   hum.info          HumInfo: bpm, ts, startSec (bar 1 beat 1 = lead-in silence + 1 silent count-in bar).
//   hum.f0            FrameF0Track: frame f0 truth on the analyzer grid (hop 256 / 22050 s, t0 = 0); hz = 0
//                     and voiced = 0 outside phrases and where the envelope is below VOICED_ENV.
//   hum.score         the score: MelodyEvent[] (pitch strings, ticks), its alphaTex body (serializeMelody),
//                     register, transposition, key (rand only).
//   hum.variant       name, melody, level 'H0'..'H3', seed, split, heldOut.
//   hum.synth         the drawn SynthParams (articulation, vowel, sigmas, SNR, RT60, click bleed, ...).
// Synthetic only: no recording, no private chart is ever written here.

import { serializeMelody } from '../../../../src/lib/melodyTex';
import type { AnalysisResult } from '../types';
import type { FrameF0Track, HumInfo, QuantizedEvent, QuantizedMelody } from '../../ts/hum/types';
import { midiToHz, noteAt, phraseAt, type Performance } from './contour';
import { FOUR_FOUR } from './melodies';
import type { HumScore, HumVariant, SynthParams } from './variants';

export const HUM_SYNTH_VERSION = 'hum-synth-1';
/** Frame grid of the f0 truth = the analyzer's (ts/hum/config.ts: hop 256 at 22050 Hz). */
export const F0_HOP_SEC = 256 / 22050;
/** A frame is voiced when the phrase envelope is at least this fraction of full level. */
export const VOICED_ENV = 0.1;

export interface SungTruthNote {
  start: number;
  end: number;
  midi: number;
  confidence: number;
  cents: number;
  startTick: number;
  ticks: number;
}

export interface HumTruth extends Omit<AnalysisResult, 'melody'> {
  melody: { notes: SungTruthNote[]; quantized: QuantizedMelody };
  hum: {
    info: HumInfo;
    f0: FrameF0Track;
    score: HumScore & { tex: string };
    variant: { name: string; melody: string; level: string; seed: number; split: string; heldOut: boolean };
    synth: SynthParams;
  };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function f0Truth(perf: Performance, audioSec: number): FrameF0Track {
  const n = Math.floor(audioSec / F0_HOP_SEC) + 1;
  const hz: number[] = new Array(n);
  const voiced: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * F0_HOP_SEC;
    const k = phraseAt(perf, t);
    let f = 0;
    if (k >= 0) {
      const j = noteAt(perf, k, t);
      if (perf.envAt(t, k, j) >= VOICED_ENV) f = midiToHz(perf.pitchAt(t, j));
    }
    hz[i] = r4(f);
    voiced[i] = f > 0 ? 1 : 0;
  }
  return { t0: 0, hopSec: F0_HOP_SEC, hz, voiced };
}

export function quantizedTruth(perf: Performance, score: HumScore): QuantizedMelody {
  const events: QuantizedEvent[] = [];
  let t = 0;
  let k = 0;
  for (const e of score.events) {
    if (e.kind === 'note') {
      events.push({ kind: 'note', startTick: t, ticks: e.ticks, midi: perf.scoreNotes[k].midi, src: k, candidates: [], gridCandidates: [], confidence: 1 });
      k++;
    } else events.push({ kind: 'rest', startTick: t, ticks: e.ticks });
    t += e.ticks;
  }
  return { bpm: score.bpm, ts: [4, 4], startSec: r6(perf.startSec), onsetBiasSec: 0, grid: 'sixteenth', events };
}

export function buildHumTruth(v: HumVariant, score: HumScore, p: SynthParams, perf: Performance, audioSec: number): HumTruth {
  const notes: SungTruthNote[] = perf.sung.map((n, j) => ({
    start: r6(n.start),
    end: r6(n.end),
    midi: n.midi,
    confidence: 1,
    cents: Math.round(perf.centsAt((n.start + n.end) / 2, j) * 100) / 100,
    startTick: perf.scoreNotes[j].startTick,
    ticks: perf.scoreNotes[j].ticks,
  }));
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'synthetic', durationSec: r6(perf.durationSec), click: p.clickDb !== null, leadInSec: r6(perf.startSec), audioSec: r6(audioSec) },
    analyzer: { name: 'truth', version: HUM_SYNTH_VERSION, methods: ['hum-synth'] },
    timeSignature: { num: 4, den: 4, confidence: 1 },
    melody: { notes, quantized: quantizedTruth(perf, score) },
    hum: {
      info: { bpm: score.bpm, ts: [4, 4], startSec: r6(perf.startSec) },
      f0: f0Truth(perf, audioSec),
      score: { ...score, tex: serializeMelody(score.events, FOUR_FOUR) },
      variant: { name: v.name, melody: v.melody, level: `H${v.level}`, seed: v.seed, split: v.split, heldOut: v.heldOut },
      synth: { ...p },
    },
  };
}
