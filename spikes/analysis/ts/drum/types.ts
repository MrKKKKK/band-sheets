/**
 * Spike 5 T0: types of the drum analyzer (docs/audio-spike5-plan.md section 2, 6 "結果の JSON").
 *
 * The JSON is an `AnalysisResult` (render/types.ts) using the EXISTING `drums` / `swing` fields, widened with
 * OPTIONAL fields only (AnalysisDrumHit.tick/bar/mark/alts, AnalysisResult.swingBars, AnalysisResult.drum), so
 * existing readers are unaffected. `swing` absent = no shuffle.
 *
 * Units: seconds are from the start of the audio file; ticks follow src/lib/melody.ts (whole note = 64, a 16th = 4);
 * `tick` of a quantized hit counts from the start of ITS bar, `bar` is 0-based from the bar containing bar 1 beat 1.
 * Nothing here holds ground truth: analyze() only gets the audio + DrumInfo (what the user knows).
 */
import type { AnalysisDrumHit, AnalysisResult } from '../../render/types';

export type { AnalysisDrumHit, AnalysisResult };

export const WHOLE_TICKS = 64;
export const TICKS_PER_16TH = WHOLE_TICKS / 16;

/** The app's 9 pieces (src/lib/drumKit.ts DrumInstrument; kept as a copy because src/ is read-only for the spike). */
export const APP_DRUM_INSTRUMENTS = ['CR', 'RD', 'HH', 'HO', 'T1', 'SD', 'T2', 'FT', 'BD'] as const;
export type AppDrumInstrument = (typeof APP_DRUM_INSTRUMENTS)[number];

/** Provisional S-拡張 names (plan section 3 持ち越しの質問 1): only the analysis `inst` uses them, not the app. */
export const EXT_DRUM_INSTRUMENTS = ['SP', 'CN', 'CB', 'SD.rim', 'SD.xs', 'RD.bell', 'HH.foot', 'HH.fsp'] as const;
export type ExtDrumInstrument = (typeof EXT_DRUM_INSTRUMENTS)[number];

export type DrumInst = AppDrumInstrument | ExtDrumInstrument;

/** Analysis stage: S-3 = BD / SD / HH (HH and HO merged into HH); S-9 = the app's 9 pieces; S-ext = plus the extensions. */
export type DrumLevel = 'S-3' | 'S-9' | 'S-ext';

/** Instruments an analysis level may output. */
export const LEVEL_INSTRUMENTS: Readonly<Record<DrumLevel, readonly DrumInst[]>> = {
  'S-3': ['BD', 'SD', 'HH'],
  'S-9': APP_DRUM_INSTRUMENTS,
  'S-ext': [...APP_DRUM_INSTRUMENTS, ...EXT_DRUM_INSTRUMENTS],
};

/** What the user tells the analyzer (the `.txt`: bpm, 拍子, 開始). Plan design decision 4. */
export interface DrumInfo {
  bpm: number;
  /** Time signature [numerator, denominator]. `bpm` counts quarter notes (eighths for x/8, as in the hum spike). */
  ts: [number, number];
  /** Second (in the audio) of the first hit (approximate, `開始:`); the analyzer refines the grid phase. */
  startSec: number;
}

/** analyze() input: the mono samples plus what the user knows. */
export interface DrumInput extends DrumInfo {
  samples: Float32Array;
  sampleRate: number;
  /** Default 'S-3' until T11. */
  level?: DrumLevel;
}

/** Instrument alternative of a hit (plan design decision 5: candidates rather than a firm decision). */
export interface InstCandidate {
  inst: DrumInst;
  confidence: number;
}

/** Dynamic mark from the hit strength distribution of the recording: `g` ghost, `ac` accent, absent = normal. */
export type DrumMark = 'g' | 'ac';

/** A hit on the beat grid. `src` indexes `result.drums`. */
export interface QuantizedDrumHit {
  bar: number;
  /** Ticks from the start of `bar`. */
  tick: number;
  inst: DrumInst;
  mark?: DrumMark;
  strength: number;
  confidence: number;
  src: number;
  alts?: InstCandidate[];
}

export interface QuantizedDrums {
  bpm: number;
  ts: [number, number];
  /** Bar-1 head used for the grid (audio time). */
  startSec: number;
  /** '8th triplet' grid is chosen by the shuffle decision (plan section 2). */
  grid: 'sixteenth' | 'triplet';
  hits: QuantizedDrumHit[];
}

/** Per-bar shuffle value. `ratio` = onset position of the off-beat inside its beat pair (0.5 straight, 0.667 = 2:1). */
export interface DrumSwingBar {
  bar: number;
  kind: 'none' | '8' | '16';
  ratio: number;
}

/** Info of one stage (onset, bands, classify, strength, quantize, swing ...). */
export interface DrumStageInfo {
  name: string;
  ms: number;
  /** Hits (or onset candidates) leaving the stage, when countable. */
  count?: number;
  note?: string;
}

export interface DrumMeta {
  configHash: string;
  configName: string;
  level: DrumLevel;
  timings: { stagesMs: Record<string, number>; totalMs: number; audioSec: number };
  warnings: string[];
  info: DrumInfo;
  /** Grid phase: bar-1 head given vs used. */
  grid: { givenStartSec: number; startSec: number; phaseOffsetSec: number; onsetBiasSec: number };
  stages: DrumStageInfo[];
}

/** The `drum` field of the result JSON. */
export interface DrumExtras {
  meta: DrumMeta;
  quantized?: QuantizedDrums;
}

/** analyze() output. It is an AnalysisResult: `drums` seconds-domain hits, `swing`/`swingBars`, `drum` extras. */
export interface DrumAnalysisResult extends AnalysisResult {
  drums: AnalysisDrumHit[];
  drum: DrumExtras;
}
