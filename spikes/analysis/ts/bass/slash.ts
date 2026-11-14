/**
 * Spike 6 T6 (B-2): slash-chord marks `/X` from the segment bass (docs/audio-spike6-plan.md section 2 B-2,
 * docs/audio-spike6-t6.md).
 *
 * Input: the chord segments (root, quality, length in beats; the analyzer's own) and their B-1 bass (segmentBass.ts).
 * A segment gets a `/X` only when its bass differs from the root AND the bass can be explained by one of three rules
 * (checked in this order; the first that fits names the kind):
 *  - pedal:     the same bass pitch class as the previous or the next segment (a bass held under changing chords,
 *               `C - F/C - G/C`).
 *  - inversion: the bass is a chord tone of the segment's quality (3rd, 5th, 7th when the quality has one). Two WEAK
 *               intervals only at confidence >= `weakMinConfidence`: the perfect 5th (a 6/4 chord; T9: in harmony a 6/4
 *               stands as a pedal, passing or cadential chord, rarely on its own, while a left hand playing 5-1-5'-1
 *               power chords puts the 5th lowest under a plain triad, docs/audio-spike6-t9.md) and the minor 3rd (T10:
 *               a minor chord over its 3rd is mostly the relative major misread by v1a, `C` read as `Am` with C in the
 *               bass, docs/audio-spike6-t10.md). Below that threshold they can still be a pedal (checked first) or a
 *               passing bass (checked next).
 *  - passing:   the bass sits between the previous and the next segment's bass, one or two semitones from each, in the
 *               same direction (`C - C/B - C/A#`), and the segment lasts at least `minBeats` beats. With `lineEnd` (B-3,
 *               `cliche.split`, T10) also the LAST note of such a line when it is the root's major 6th: the two
 *               previous basses step into it in one direction (`C - C/B - C/A# - C/A`, `Am - Am/G# - Am/G - Am/F#`;
 *               the line cliche ends on the 6th, which no other rule explains).
 * A bass that fits none of them is more likely a misreading than a chord (precision first, plan section 1), so no mark.
 * Guard: bass confidence below `minConfidence` -> no mark (the root stays, as in v1a). A mark whose second candidate
 * is the root is still written: on the tuning set that is 28 % of the correct marks (a piano left hand on the root
 * under the bass's `/X`) and almost never a wrong one (docs/audio-spike6-t6.md). The second candidate is kept on every
 * mark (plan section 6 decision 7: candidates) and written to JSON as `bassCandidates` (T7, user decision 2026-11-14),
 * so a reader can offer the root back; a weak interval held back by `weakMinConfidence` is written the same way on the
 * unmarked chord (heldWeak, T9 / T10).
 * Ground truth is never read here. No network: computation only.
 */
import { NOTE_NAMES } from '../dsp/chords';
import { intervals } from '../dsp/vocab';
import { isScaleStep, pcStep as step } from './cliche';
import type { BassConfig } from './config';
import type { SegmentBass } from './segmentBass';
import type { AnalysisChord, BassCandidate, BassKind, PitchClass } from './types';

export interface SlashChord {
  /** Root pitch class of the segment. */
  root: PitchClass;
  /** ts/dsp vocabulary quality ('maj', 'min', '7', ...). */
  quality: string;
  /** Length of the segment in beats. */
  beats: number;
}
export interface SlashMark {
  bass: PitchClass;
  kind: BassKind;
  confidence: number;
  second: BassCandidate;
}

/** Perfect fifth above the root (a 6/4 chord when it is the bass). */
const FIFTH = 7;
/** Minor third above the root. */
const MINOR_THIRD = 3;
/** Bass intervals that are an inversion only at `weakMinConfidence` (see the header). */
const isWeak = (iv: number): boolean => iv === FIFTH || iv === MINOR_THIRD;
/** Major sixth above the root (where a descending line cliche ends). */
const SIXTH = 9;

/** Why segment i's bass may differ from its root, or null when no rule explains it (see the header). */
export function bassKind(
  i: number,
  chords: readonly SlashChord[],
  bass: readonly Pick<SegmentBass, 'pc' | 'confidence'>[],
  cfg: Pick<BassConfig['slash'], 'minBeats' | 'weakMinConfidence'>,
  lineEnd = false,
): BassKind | null {
  const b = bass[i].pc;
  const { root, quality, beats } = chords[i];
  const prev = i > 0 ? bass[i - 1].pc : null;
  const next = i + 1 < bass.length ? bass[i + 1].pc : null;
  if (prev === b || next === b) return 'pedal';
  const iv = (b - root + 12) % 12;
  if (intervals(quality).slice(1).includes(iv) && (!isWeak(iv) || bass[i].confidence >= cfg.weakMinConfidence)) return 'inversion';
  if (prev !== null && next !== null && beats >= cfg.minBeats) {
    const d1 = step(prev, b);
    const d2 = step(b, next);
    if (isScaleStep(d1) && isScaleStep(d2) && Math.sign(d1) === Math.sign(d2)) return 'passing';
  }
  if (lineEnd && iv === SIXTH && i >= 2 && beats >= cfg.minBeats) {
    const d1 = step(bass[i - 2].pc, prev!);
    const d2 = step(prev!, b);
    if (isScaleStep(d1) && isScaleStep(d2) && Math.sign(d1) === Math.sign(d2)) return 'passing';
  }
  return null;
}

/** B-2: the `/X` mark of every segment (null = keep the root). `lineEnd`: the B-3 line-end rule (see the header). */
export function slashMarks(chords: readonly SlashChord[], bass: readonly SegmentBass[], cfg: BassConfig['slash'], lineEnd = false): (SlashMark | null)[] {
  if (chords.length !== bass.length) throw new Error(`slashMarks: ${chords.length} chords but ${bass.length} basses`);
  return chords.map((c, i) => {
    const b = bass[i];
    if (b.pc === c.root || b.confidence < cfg.minConfidence) return null;
    const kind = bassKind(i, chords, bass, cfg, lineEnd);
    return kind ? { bass: b.pc, kind, confidence: b.confidence, second: b.second } : null;
  });
}

/**
 * T9 / T10: the weak readings (5th, minor 3rd) `weakMinConfidence` held back (no mark, the root stays) as a candidate
 * for the reader (plan section 6 decision 7: candidates rather than a firm decision), so `C/G` or `Am/C` can still be
 * offered in one click. Per segment: `{ pc, confidence: 1 }` (confidence = its score relative to the best score, as
 * `SlashMark.second`; it was the best) when the segment has no mark, its bass is a weak interval and a chord tone, and
 * the bass confidence is at least `minConfidence`; else null.
 */
export function heldWeak(
  chords: readonly SlashChord[],
  bass: readonly SegmentBass[],
  marks: readonly (SlashMark | null)[],
  cfg: BassConfig['slash'],
): (BassCandidate | null)[] {
  return chords.map((c, i) => {
    const b = bass[i];
    const iv = (b.pc - c.root + 12) % 12;
    const weak = isWeak(iv) && intervals(c.quality).includes(iv);
    return !marks[i] && weak && b.confidence >= cfg.minConfidence && b.confidence < cfg.weakMinConfidence ? { pc: b.pc, confidence: 1 } : null;
  });
}

/** Beats of [start, end): the number of beat times inside it (at least 1 for a non-empty segment). */
export function beatsIn(start: number, end: number, beatTimes: readonly number[]): number {
  const eps = 1e-3;
  return Math.max(1, beatTimes.filter((t) => t >= start - eps && t < end - eps).length);
}

/** The fields withSlash writes on a marked chord (render/types.ts AnalysisChord). */
export type SlashFields = Pick<AnalysisChord, 'bassConfidence' | 'bassKind' | 'bassCandidates'> & { bass: string | null };

/**
 * Chords with the marks written: `bass` (sharp name, as ts/dsp), `bassConfidence`, `bassKind`, `bassCandidates` (the
 * second reading, T7) and `text` with `/X` inserted before a trailing `?` (the low-confidence mark of ts/dsp stays).
 * Unmarked chords are returned unchanged (same objects), except that a held-back weak reading (`held`, T9 / T10) is written as their
 * `bassCandidates` (bass and text stay as v1a). Works on render/types.ts and ts/dsp/result.ts chords alike.
 */
export function withSlash<C extends { text?: string; bass: string | null }>(
  chords: readonly C[],
  marks: readonly (SlashMark | null)[],
  held: readonly (BassCandidate | null)[] = [],
): (C & SlashFields)[] {
  if (chords.length !== marks.length) throw new Error(`withSlash: ${chords.length} chords but ${marks.length} marks`);
  return chords.map((c, i) => {
    const m = marks[i];
    const h = held[i];
    if (!m) return h ? { ...c, bassCandidates: [{ bass: NOTE_NAMES[h.pc], confidence: h.confidence }] } : c;
    const name = NOTE_NAMES[m.bass];
    const text = c.text === undefined ? undefined : c.text.replace(/(\?)?$/, `/${name}$1`);
    return {
      ...c,
      bass: name,
      ...(text === undefined ? {} : { text }),
      bassConfidence: m.confidence,
      bassKind: m.kind,
      bassCandidates: [{ bass: NOTE_NAMES[m.second.pc], confidence: m.second.confidence }],
    };
  });
}
