/**
 * Spike 6 T0: types of the bass analyzer (docs/audio-spike6-plan.md sections 2, 6 "結果の JSON").
 *
 * The result is the existing v1a `AnalysisResult` using `chords[].bass` (always null in v1a), widened with OPTIONAL
 * fields only (AnalysisChord.bassConfidence / bassKind, AnalysisResult.bassNotes), so existing readers are unaffected.
 * Nothing here holds ground truth: the bass analyzer gets the audio plus the frozen ts/dsp result (beats, segments,
 * roots, qualities) and the user's tempo hint only.
 */
import type { AnalysisChord, AnalysisNote, AnalysisResult } from '../../render/types';

export type { AnalysisChord, AnalysisNote, AnalysisResult };

/** `chords[].bassKind` (plan section 2 B-2). */
export type BassKind = NonNullable<AnalysisChord['bassKind']>;

/** Pitch class 0-11 (C = 0), as in render/types.ts ParsedChord. */
export type PitchClass = number;

/** Second-best bass reading of a segment (plan section 6 decision 7: candidates rather than a firm decision). */
export interface BassCandidate {
  pc: PitchClass;
  confidence: number;
}
