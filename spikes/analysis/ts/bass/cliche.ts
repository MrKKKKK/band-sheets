/**
 * Spike 6 T10 (B-3): split a chord segment where the bass moves by scale step under it (docs/audio-spike6-plan.md
 * section 2 B-3, docs/audio-spike6-t10.md).
 *
 * The frozen analyzer keeps one segment while the upper chord stays (`C - C/B - C/A# - C/A` can come out as one `C`).
 * Per segment: the bass of every beat (segmentBass on one-beat spans), consecutive beats with the same pitch class form
 * a group (a beat below `minConfidence` joins the group before it), and the segment is cut between two groups when
 * both last at least `minBeats` beats and the bass moves by a scale step (1 or 2 semitones). Root and quality stay the
 * segment's (plan section 3 decision 6); B-2 then decides each piece's `/X` (analyze.ts keeps a split only where a
 * piece gets a mark). `minBeats` >= 2 keeps a walking line (one note per beat) in one segment.
 * Ground truth is never read here. No network: computation only.
 */
import type { BassConfig } from './config';
import type { LowCqt } from './lowCqt';
import { segmentBass, type SegmentSpan } from './segmentBass';

export interface Piece extends SegmentSpan {
  /** Index of the segment the piece comes from. */
  src: number;
}

const EPS = 1e-3;
/** Signed pitch-class step from a to b in -5..6 semitones. */
export const pcStep = (a: number, b: number): number => ((((b - a) % 12) + 12 + 5) % 12) - 5;
export const isScaleStep = (d: number): boolean => Math.abs(d) === 1 || Math.abs(d) === 2;

/** One-beat spans of [start, end): cut at every beat strictly inside it. */
export function beatSpans(seg: SegmentSpan, beats: readonly number[]): SegmentSpan[] {
  const cuts = beats.filter((t) => t > seg.start + EPS && t < seg.end - EPS);
  const bounds = [seg.start, ...cuts, seg.end];
  return bounds.slice(1).map((end, i) => ({ start: bounds[i], end }));
}

/** B-3: the pieces of every segment (a segment that is not cut is one piece with its own start / end). */
export function splitByBass(
  low: LowCqt,
  segs: readonly SegmentSpan[],
  beats: readonly number[],
  cfg: Pick<BassConfig, 'segment' | 'slash' | 'cliche'>,
): Piece[] {
  const minBeats = Math.max(1, cfg.cliche.minBeats);
  return segs.flatMap((seg, src) => {
    const spans = beatSpans(seg, beats);
    if (spans.length < 2 * minBeats) return [{ start: seg.start, end: seg.end, src }];
    const sb = segmentBass(low, spans, beats, cfg.segment);
    const groups: { pc: number; first: number; n: number }[] = [];
    sb.forEach((b, i) => {
      const g = groups[groups.length - 1];
      if (g && (b.pc === g.pc || b.confidence < cfg.slash.minConfidence)) g.n++;
      else groups.push({ pc: b.pc, first: i, n: 1 });
    });
    const out: Piece[] = [];
    let from = seg.start;
    for (let g = 1; g < groups.length; g++) {
      const a = groups[g - 1];
      const b = groups[g];
      if (a.n >= minBeats && b.n >= minBeats && isScaleStep(pcStep(a.pc, b.pc))) {
        const at = spans[b.first].start;
        out.push({ start: from, end: at, src });
        from = at;
      }
    }
    out.push({ start: from, end: seg.end, src });
    return out;
  });
}
