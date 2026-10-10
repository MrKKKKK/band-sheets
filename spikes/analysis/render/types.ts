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
  | 'sus4';

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
  /** Accompaniment shape (default block4 = a chord on every beat). */
  comp?: 'block4' | 'arp8' | 'whole';
  soundFont?: 'sonivox' | 'musescore';
  /** Piano level in dB relative to the default balance. */
  pianoGainDb?: number;
  /** Tempo per bar (length = number of bars). */
  tempoCurve?: number[];
  etudeSeed?: number;
  seventhShare?: number;
  /** Difficulty level L0-L3. */
  level?: 0 | 1 | 2 | 3;
  /** Held-out variant: not looked at during tuning. */
  heldOut?: boolean;
}

/** Difficulty level (also written to manifest.json entries as `level`). */
export type Level = 0 | 1 | 2 | 3;

/** One entry of manifest.derived.json (wavs made by py/degrade.py). Paths are relative to out/. */
export interface DerivedManifestEntry {
  name: string;
  song: Variant['song'];
  /** Name of the base variant this was derived from. */
  base: string;
  level: Level;
  heldOut: boolean;
  degrade: {
    noiseSnrDb?: number;
    reverbRt60?: number;
    gainEnvDb?: number;
    gainDb?: number;
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
  sections?: { start: number; end: number; label: string }[];
  chords?: AnalysisChord[];
  melody?: { notes: AnalysisNote[] };
  drums?: AnalysisDrumHit[];
  swing?: { kind: '8' | '16'; confidence: number };
}
