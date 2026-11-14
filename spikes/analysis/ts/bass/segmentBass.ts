/**
 * Spike 6 T5 (B-1): the bass note of each chord segment (docs/audio-spike6-plan.md section 2 B-1, method 2 "lowest
 * clear pitch"; methods 1, 3, 4 were compared on the tuning split and removed, see docs/audio-spike6-t5.md).
 *
 * Input: the low semitone spectrogram (lowCqt.ts), the chord segments (the analyzer's own, or the truth's for the
 * ceiling score) and the beat times. Output per segment: pitch class, MIDI (octave guess), confidence 0-1 and the
 * second candidate. Ground truth is never read here: segments and beats are whatever the caller passes.
 *
 *  - Candidates: the first `octaves - ceil(log2(harmonics))` octaves of the spectrogram (C1-B3 with 5 octaves and
 *    4 harmonics); the octaves above are only read as overtones.
 *  - Salience (harmonic sum): sal[c] = sum over h = 1..harmonics of S[c + round(12 log2 h)]. A note whose 2nd or 3rd
 *    harmonic is louder than its fundamental still wins over the octave / fifth above, because only the true
 *    fundamental collects all of h = 1..H; a missing fundamental is recovered from h = 2..H.
 *  - Head weight: frames in the segment's first beat count `headWeight` times (the bass on the chord change is the
 *    written bass; passing notes later in the segment are not).
 *  - Pick: head-weighted mean salience per candidate note; pitch-class score = max over its octaves; MIDI = the best
 *    octave of the winning pitch class. Confidence: (best - second) / best over the 12 pitch-class scores.
 * No network: computation only.
 */
import type { BassConfig } from './config';
import type { LowCqt } from './lowCqt';
import type { BassCandidate } from './types';

export interface SegmentSpan {
  start: number;
  end: number;
}
export interface SegmentBass {
  pc: number;
  midi: number;
  confidence: number;
  second: BassCandidate;
}

export function candidateCount(low: Pick<LowCqt, 'nSemis'>, harmonics: number): number {
  const n = low.nSemis - 12 * Math.ceil(Math.log2(Math.max(1, harmonics)));
  if (n < 12) throw new Error(`lowCqt has too few octaves for ${harmonics} harmonics`);
  return n;
}

/**
 * salience() per spectrogram and harmonic count (T12): B-3 calls segmentBass once per chord segment, and recomputing
 * the whole [nCand, cols] sum each time made the bass stage grow with (length x chords). The cached array is the
 * same values; a LowCqt's `semi` is never written after lowCqt() returns.
 */
const salienceCache = new WeakMap<LowCqt, Map<number, { sal: Float32Array; nCand: number }>>();

/** Harmonic-sum salience [nCand, cols] (computed once per `low` and `harmonics`; do not write to the result). */
export function salience(low: LowCqt, harmonics: number): { sal: Float32Array; nCand: number } {
  let byH = salienceCache.get(low);
  if (!byH) salienceCache.set(low, (byH = new Map()));
  let out = byH.get(harmonics);
  if (!out) byH.set(harmonics, (out = harmonicSum(low, harmonics)));
  return out;
}

function harmonicSum(low: LowCqt, harmonics: number): { sal: Float32Array; nCand: number } {
  const nCand = candidateCount(low, harmonics);
  const { semi, cols } = low;
  const sal = new Float32Array(nCand * cols);
  for (let h = 1; h <= harmonics; h++) {
    const off = Math.round(12 * Math.log2(h));
    for (let c = 0; c < nCand; c++) {
      const src = (c + off) * cols;
      const dst = c * cols;
      for (let t = 0; t < cols; t++) sal[dst + t] += semi[src + t];
    }
  }
  return { sal, nCand };
}

const frameOf = (sec: number, low: LowCqt): number => Math.round(sec / low.frameSec);

function medianIbi(beats: readonly number[]): number {
  const d = beats
    .slice(1)
    .map((t, i) => t - beats[i])
    .sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : 0.5;
}

/** End of the segment's first beat: the first beat after start (+ 50 ms), capped at the segment end. */
function headEnd(seg: SegmentSpan, beats: readonly number[], ibi: number): number {
  const b = beats.find((t) => t > seg.start + 0.05);
  return Math.min(seg.end, b ?? seg.start + ibi);
}

/** Head-weighted mean over frames [f0, f1) of rows [0, nRows) of `m` ([nRows, cols]); frames before fh weigh headWeight. */
function segMean(m: Float32Array, nRows: number, cols: number, f0: number, f1: number, fh: number, headWeight: number): Float64Array {
  const out = new Float64Array(nRows);
  let wsum = 0;
  for (let t = Math.max(0, f0); t < Math.min(cols, f1); t++) {
    const w = t < fh ? headWeight : 1;
    wsum += w;
    for (let r = 0; r < nRows; r++) out[r] += w * m[r * cols + t];
  }
  if (wsum > 0) for (let r = 0; r < nRows; r++) out[r] /= wsum;
  return out;
}

/** Pick from per-candidate-note scores: pc score = max over octaves; MIDI = the best octave of the winning pc. */
function pick(notes: ArrayLike<number>, midi0: number): SegmentBass {
  const pcScore = new Float64Array(12);
  const pcBest = new Int32Array(12).fill(-1);
  for (let c = 0; c < notes.length; c++) {
    const pc = (midi0 + c) % 12;
    if (pcBest[pc] < 0 || notes[c] > pcScore[pc]) {
      pcScore[pc] = notes[c];
      pcBest[pc] = c;
    }
  }
  const order = [...Array(12).keys()].sort((a, b) => pcScore[b] - pcScore[a] || a - b);
  const [b1, b2] = order;
  const s1 = pcScore[b1];
  const s2 = pcScore[b2];
  return {
    pc: b1,
    midi: midi0 + pcBest[b1],
    confidence: s1 > 0 ? Math.max(0, (s1 - s2) / s1) : 0,
    second: { pc: b2, confidence: s1 > 0 ? s2 / s1 : 0 },
  };
}

/** B-1: bass of every segment. `beats` = beat times (s), ascending. Only method 2 exists (T5). */
export function segmentBass(low: LowCqt, segs: readonly SegmentSpan[], beats: readonly number[], cfg: BassConfig['segment']): SegmentBass[] {
  if (cfg.method !== 2) throw new Error(`segment.method ${cfg.method} was removed in T5 (only 2); see docs/audio-spike6-t5.md`);
  const ibi = medianIbi(beats);
  const { sal, nCand } = salience(low, cfg.harmonics);
  return segs.map((s) => {
    const f0 = frameOf(s.start, low);
    const f1 = Math.max(f0 + 1, frameOf(s.end, low));
    const fh = frameOf(headEnd(s, beats, ibi), low);
    return pick(segMean(sal, nCand, low.cols, f0, f1, fh, cfg.headWeight), low.midi0);
  });
}
