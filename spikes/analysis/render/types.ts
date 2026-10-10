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
