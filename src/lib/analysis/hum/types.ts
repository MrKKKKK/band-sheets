/**
 * Spike 4 T0: result types of the humming analyzer (docs/audio-spike4-plan.md section 2 "result", design decision 3).
 *
 * The JSON is an `AnalysisResult` (render/types.ts) whose `melody` is widened with OPTIONAL fields only, so
 * existing readers (py/score.py melody) are unaffected:
 *   melody.notes[]      seconds-domain notes {start, end, midi, confidence} + cents + candidates   (AnalysisNote)
 *   melody.quantized    the notes on the 16th grid (QuantizedMelody below), ticks as in src/lib/melody.ts
 *   hum                 HumExtras: analyzer meta (config hash, timings, warnings), optional frame f0 track
 *
 * Units: seconds are from the start of the audio file (the analyzer input), ticks follow src/lib/melody.ts
 * (whole note = 64, a 16th = 4 ticks), `midi` is the MIDI number (C4 = 60), `cents` is relative to `midi`.
 * Nothing here holds ground truth: analyze() only gets the audio + HumInfo (what the user knows).
 */

// ---- Answer / analysis-result JSON types, copied from the research branch's spikes/analysis/render/types.ts ----
// (the app has no render/ directory; all times in seconds). Types only.

type ChordQuality =
  | 'maj'
  | 'min'
  | '7'
  | 'maj7'
  | 'min7'
  | 'dim'
  | 'aug'
  | 'sus4'
  | 'm7b5'
  | 'dim7';

export interface AnalysisBeat {
  t: number;
  downbeat: boolean;
  bar?: number;
  beat?: number;
}

export interface AnalysisChord {
  start: number;
  end: number;
  root: string;
  quality: ChordQuality;
  bass: string | null;
  text?: string;
  confidence: number;
}

export interface AnalysisNote {
  start: number;
  end: number;
  midi: number;
  confidence: number;
  // ---- spike 4 additions; all optional, absent = as before ----
  /** Deviation of the measured pitch from `midi`, in cents (-50..+50, tuning already removed). */
  cents?: number;
  /** Other pitch readings, best first, at most 3 including none for `midi` itself; see ts/hum/types.ts. */
  candidates?: { midi: number; confidence: number }[];
}

export interface AnalysisDrumHit {
  t: number;
  inst: string;
  strength: number;
  confidence: number;
}

export interface AnalysisResult {
  format: 'band-sheets-analysis';
  version: 1;
  source: {
    kind: 'synthetic' | 'recording';
    /** End of the last bar (including the lead-in); the wav is longer (release tail). */
    durationSec: number;
    click: boolean;
    /** Silence before bar 0, in seconds (synthetic only; 0 when absent). */
    leadInSec?: number;
    /** Actual wav length in seconds (synthetic only). */
    audioSec?: number;
    /** Pickup (spike 2): the silent first `cutSec` of the rendered pickup bar were cut off the wav. */
    pickup?: { beats: number; cutSec: number };
  };
  analyzer: { name: string; version: string; methods: string[] };
  render?: {
    song: 'saints' | 'etude' | 'chart';
    variant: string;
    tempo: number;
    tracks: string[];
    programs: Record<string, number>;
    sampleRate: number;
    alphaTab: string;
    soundFont: string;
  };
  beats?: AnalysisBeat[];
  timeSignature?: { num: number; den: number; confidence: number };
  key?: { tonic: string; mode: 'major' | 'minor'; confidence: number };
  /** Truth only (spike 2, T23, modulation variants): the key per bar run. */
  keys?: { startBar: number; key: string }[];
  sections?: { start: number; end: number; label: string }[];
  chords?: AnalysisChord[];
  melody?: {
    notes: AnalysisNote[];
    /** Spike 4: the notes on the beat grid (QuantizedMelody below). Optional. */
    quantized?: unknown;
  };
  drums?: AnalysisDrumHit[];
  swing?: { kind: '8' | '16'; confidence: number };
}

/** Ticks per whole note in the melody model (src/lib/melody.ts WHOLE_TICKS). A 16th is 4 ticks. */
export const WHOLE_TICKS = 64;
export const TICKS_PER_16TH = WHOLE_TICKS / 16;

/** What the user tells the analyzer (never read from ground truth). Plan design decision 4. */
export interface HumInfo {
  bpm: number;
  /** Time signature [numerator, denominator], e.g. [4, 4]. */
  ts: [number, number];
  /** Second (in the audio) at which bar 1 beat 1 starts. May be NEGATIVE: the recording starts inside a rest-led
   *  pickup bar. The analyzer treats it as approximate (grid.phaseSearch). */
  startSec: number;
  /** Optional key hint, e.g. 'C' or 'Am'; only reorders candidates near a semitone boundary (decision 6). */
  key?: string;
}

/**
 * The input form of HumInfo (analyzeHum / CLI, plan "見る時点 ① の後の決定"): EITHER `startSec` (bar-1 head, may be
 * negative) OR `firstNoteSec` (approximate second of the first sung note, the `.txt` `開始:`) with, when known,
 * `firstNoteTick` (its bar position, ticks from bar 1 beat 1; e.g. 48 for a pickup on beat 4 of a 4/4 bar 1).
 * Without `firstNoteTick` the first note is assumed to be on a beat and is put at tick 0 (bar 1 beat 1); the grid
 * phase search then finds the beat. Both are approximate; the analyzer refines the grid phase from the onsets.
 */
export interface HumInput {
  bpm: number;
  ts: [number, number];
  startSec?: number;
  firstNoteSec?: number;
  firstNoteTick?: number;
  key?: string;
}

/** How the bar-1 head was obtained and refined (HumMeta.grid). Seconds are in the audio file's time. */
export interface GridPhaseMeta {
  /** 'barStart' (startSec given), 'firstNote' (firstNoteSec + firstNoteTick), 'firstNoteOnly' (firstNoteSec, beat assumed). */
  startMode: 'barStart' | 'firstNote' | 'firstNoteOnly';
  /** The bar-1 head implied by the input, before the phase search. */
  givenStartSec: number;
  /** The bar-1 head used for quantization (= givenStartSec + phaseOffsetSec); also melody.quantized.startSec. */
  startSec: number;
  /** Chosen grid offset (whole grid steps, positive = bar 1 later than given) in seconds and in steps. */
  phaseOffsetSec: number;
  phaseSteps: number;
  /** Sub-step onset bias removed afterwards (= melody.quantized.onsetBiasSec). */
  onsetBiasSec: number;
  /** False for 'firstNoteOnly': ticks count from the beat of the first note, not from a known bar 1. */
  barPositionKnown: boolean;
}

/** One alternative pitch reading of a note. `confidence` in 0..1, derived from the gap between the best and second best. */
export interface PitchCandidate {
  midi: number;
  confidence: number;
  /** Set when this candidate comes from the octave-fix rule (the original reading before the fix). */
  octaveFixed?: boolean;
}

/** A seconds-domain note: AnalysisNote with its optional spike-4 fields filled in. */
export interface HumNote extends AnalysisNote {
  /** Start/end in seconds (as AnalysisNote). */
  start: number;
  end: number;
  /** Nearest semitone after tuning removal. */
  midi: number;
  /** Median pitch of the stable part relative to `midi`, in cents, after removing the recording-wide tuning offset. */
  cents: number;
  /** 0..1. */
  confidence: number;
  /** Pitch alternatives, best first, at most `pitch.candidatesMax` (3), excluding the chosen `midi`. */
  candidates: PitchCandidate[];
}

/** A grid alternative for a quantized note (second nearest grid position). */
export interface QuantCandidate {
  startTick: number;
  ticks: number;
  confidence: number;
}

/**
 * A note on the grid. Ticks are counted from the start of bar 1 (startSec), so `startTick` may be negative
 * only for a note that begins before bar 1 (clamped to 0 by default). `ticks` is positive and even; a note
 * crossing a bar line stays ONE note here (ties are the converter's job).
 */
export interface QuantizedNote {
  kind: 'note';
  startTick: number;
  ticks: number;
  midi: number;
  /** Index of the source note in `melody.notes`. */
  src: number;
  /** Pitch candidates (same as HumNote.candidates). */
  candidates: PitchCandidate[];
  /** Grid alternatives, best first, at most `grid.candidatesMax` (2). */
  gridCandidates: QuantCandidate[];
  confidence: number;
}

export interface QuantizedRest {
  kind: 'rest';
  startTick: number;
  ticks: number;
}

export type QuantizedEvent = QuantizedNote | QuantizedRest;

export interface QuantizedMelody {
  bpm: number;
  ts: [number, number];
  startSec: number;
  /** Median onset offset (sec, positive = sang late) removed before rounding (design: bias correction). */
  onsetBiasSec: number;
  /** Grid phase search (grid.phaseSearch): the bar-1 head before the search and the chosen offset (whole steps, s).
   *  startSec above is already givenStartSec + phaseOffsetSec. Absent when the search is off. */
  givenStartSec?: number;
  phaseOffsetSec?: number;
  /** 'sixteenth' (default) or 'triplet' (switch, measured on synthetic only). */
  grid: 'sixteenth' | 'triplet';
  /** Consecutive from tick 0: notes and rests, no gaps or overlaps. */
  events: QuantizedEvent[];
}

/** Per-frame f0 track (optional output, for charts and f0 scoring). All arrays have the same length. */
export interface FrameF0Track {
  /** Time of frame 0 and frame spacing in seconds. */
  t0: number;
  hopSec: number;
  /** Hz, 0 where unvoiced. */
  hz: number[];
  /** Voicing probability 0..1. */
  voiced: number[];
}

export interface HumTimings {
  /** Milliseconds per stage; keys are free-form but stable (e.g. 'decode', 'f0', 'segment', 'quantize'). */
  stagesMs: Record<string, number>;
  totalMs: number;
  /** Length of the analyzed audio in seconds. */
  audioSec: number;
}

/** Analyzer meta, goes into the result JSON as `hum`. */
export interface HumMeta {
  /** configHash() of the config used (ts/hum/config.ts). */
  configHash: string;
  /** Config name, e.g. 'hum-v0'. */
  configName: string;
  /** Git commit of the analyzer, when known (the CLI fills it in). */
  commit?: string;
  timings: HumTimings;
  /** Human-readable, e.g. 'noise floor could not be estimated', 'no voiced frames'. Never contains note sequences. */
  warnings: string[];
  /** Recording-wide tuning offset removed from all pitches, in cents. */
  tuningCents: number;
  /** The info the analyzer was given (echoed for reproducibility). */
  info: HumInput;
  /** Bar-1 head: input mode, given value, chosen phase offset and onset bias. */
  grid: GridPhaseMeta;
}

/** The `hum` field of the result JSON. */
export interface HumExtras {
  meta: HumMeta;
  /** Present only when requested (output.f0Track). */
  f0?: FrameF0Track;
}

/**
 * Humming analysis result: an AnalysisResult with `melody.notes` (HumNote[]), `melody.quantized` and `hum`.
 * `analyzer.name` is 'hum-ts'. Remains a valid AnalysisResult.
 */
export type HumAnalysisResult = Omit<AnalysisResult, 'melody' | 'analyzer'> & {
  analyzer: { name: string; version: string; methods: string[] };
  melody: { notes: HumNote[]; quantized: QuantizedMelody };
  hum: HumExtras;
};
