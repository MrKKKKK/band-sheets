// Shared types for spike 0 (docs/audio-spike0-plan.md). Changes go through
// the review/fix tasks (T10/T11) only.

export type ChordQuality =
  | 'maj'
  | 'min'
  | '7'
  | 'maj7'
  | 'min7'
  | 'dim'
  | 'aug'
  | 'sus4'
  // spike 2 (T4): half-diminished and diminished sevenths
  | 'm7b5'
  | 'dim7';

/** A parsed chord symbol. `root` and `bass` are pitch classes 0–11 (C = 0). */
export interface ChordSymbol {
  text: string;
  root: number;
  rootName: string;
  quality: ChordQuality;
  bass: number | null;
}

/** A chord change, 0-based over the whole song; lasts until the next one. */
export interface TimelineChord {
  bar: number;
  /**
   * Beat within the bar. A whole number, except in the timeline that `recComp`
   * returns (spike 2, T4), where an anticipated change sits on an eighth-note
   * position (x.5 = the "and" of beat x+1).
   */
  beat: number;
  text: string;
}

export interface ChordTimeline {
  ts: [number, number];
  bars: number;
  sections: { label: string; startBar: number; bars: number }[];
  /** Time order. The first is bar 0 beat 0 (the first chord extended back). */
  chords: TimelineChord[];
}

export type Mix = 'piano' | 'piano+drums' | 'full';

export interface Variant {
  song: 'saints' | 'etude';
  mix: Mix;
  tempo: number;
  swing: 'none' | 'asWritten';
  click: boolean;
  /** Seconds of silence before bar 0 (default 0); all truth times shift by it. */
  leadInSec?: number;
  name: string;
  // ---- spike 1 additions (docs/audio-spike1-plan.md); all optional, absent = as before ----
  /** Accompaniment shape (default block4 = a chord on every beat; 'rec' = REC-like, spike 2 T4). */
  comp?: 'block4' | 'arp8' | 'whole' | 'rec';
  soundFont?: 'sonivox' | 'musescore';
  /** Piano level in dB relative to the default balance. */
  pianoGainDb?: number;
  /** Tempo per bar (length = number of bars). */
  tempoCurve?: number[];
  etudeSeed?: number;
  seventhShare?: number;
  /** Difficulty level L0-L3, 'LR' (REC-like accompaniment) or 'V' (wider chord vocabulary). */
  level?: Level;
  /** Held-out variant: not looked at during tuning. */
  heldOut?: boolean;
  // ---- spike 2 additions (docs/audio-spike2-plan.md, T4); all optional ----
  /** Level LR only: which of L0 / L1 / L2 this one corresponds to. */
  lrGrade?: 0 | 1 | 2;
  /** Seed of the REC-like accompaniment (comp 'rec'); default 1. */
  recSeed?: number;
  /** comp 'rec' only: 'hard' = the harder REC-like style of T4b (pianoPart.ts REC_HARD); absent = T4 style. */
  recStyle?: 'hard';
  /** Etude form: 'aaba' = etude3 (A1 A2 B A3, 8 bars each, with a pickup). Absent = A1 B1 A2 B2. */
  etudeForm?: 'aaba';
  /** Beats of pickup (anacrusis) before bar 1; the silent rest of the pickup bar is cut from the wav. */
  pickupBeats?: number;
  /** Share of etude chord slots replaced by dim / aug / sus4 / m7b5 / dim7. */
  vocabShare?: number;
  // ---- spike 2 addition (T23) ----
  /** Modulation variant: the chart sections (indexes in chart order) listed here are transposed. */
  modulation?: Modulation;
}

/**
 * Modulation of a variant (docs/audio-spike2-plan.md, design decision 11): `sections` (chart-section
 * indexes) are transposed by `semitones`; the other sections keep the song's key `baseKey`.
 * `tag` goes into the variant name.
 */
export interface Modulation {
  sections: number[];
  semitones: number;
  baseKey: string;
  tag: string;
}

/** One entry of the truth `keys`: from bar `startBar` (0 = first downbeat) the key is `key` ("C", "F#m"). */
export interface TruthKey {
  startBar: number;
  key: string;
}

/** Difficulty level (also written to manifest.json entries as `level`). */
export type Level = 0 | 1 | 2 | 3 | 'LR' | 'V';

/** One entry of manifest.derived.json (wavs made by py/degrade.py). Paths are relative to out/. */
export interface DerivedManifestEntry {
  name: string;
  song: Variant['song'];
  /** Name of the base variant this was derived from. */
  base: string;
  level: Level;
  /** Level LR only. */
  lrGrade?: 0 | 1 | 2;
  heldOut: boolean;
  degrade: {
    noiseSnrDb?: number;
    reverbRt60?: number;
    gainEnvDb?: number;
    gainDb?: number;
    /** Maximizer (spike 2): make-up gain to this active RMS, then a brickwall limiter. */
    maxTargetRmsDb?: number;
    maxCeilingDb?: number;
  };
  wav: string;
  truth: string;
}

// ---- Answer / analysis-result JSON (all times in seconds) ----

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
    song: Variant['song'];
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
  /** Truth only (spike 2, T23, modulation variants): the key per bar run; scored by py/score.py. */
  keys?: TruthKey[];
  sections?: { start: number; end: number; label: string }[];
  chords?: AnalysisChord[];
  melody?: { notes: AnalysisNote[] };
  drums?: AnalysisDrumHit[];
  swing?: { kind: '8' | '16'; confidence: number };
}
