/**
 * Spike 6 T5 (B-1): the pitch-class-UNFOLDED low CQT as a semitone spectrogram (docs/audio-spike6-plan.md section 2,
 * section 6 decision 2). Calls the frozen ts/dsp/core/cqt.ts (streamed per octave), never edits it.
 *
 * Bin layout as in ts/dsp/chroma.ts (cqToChromaMap): with fmin = C1 (32.7 Hz), 36 bins per octave and the estimated
 * tuning applied, semitone m (m = 0 = C1 = MIDI 24) is the 3-bin block {3m - 1, 3m, 3m + 1}; a semitone's value is the
 * block's max (a slightly mistuned note still lands in its own semitone). Output: row-major [nSemis, cols] float32,
 * frame t centred at t * hop / sr (librosa center=True).
 * No network: computation only.
 */
import { cqtMagnitudeStream, estimateTuning } from '../dsp/core/cqt';
import type { MemTracker } from '../dsp/core/mem';

export const LOW_SR = 22050;
export const LOW_HOP = 512;
/** MIDI number of semitone 0 when fminHz is C1 (32.70 Hz). */
export const C1_MIDI = 24;

export interface LowCqt {
  /** [nSemis, cols] magnitudes. */
  semi: Float32Array;
  nSemis: number;
  cols: number;
  /** MIDI of semitone row 0. */
  midi0: number;
  /** Seconds per column. */
  frameSec: number;
  tuning: number;
}

export interface LowCqtParams {
  fminHz: number;
  octaves: number;
  binsPerOctave: number;
}

/** MIDI of a frequency, rounded (for the row-0 label). */
const hzToMidi = (hz: number): number => Math.round(69 + 12 * Math.log2(hz / 440));

/** Semitone spectrogram of 22050 Hz mono `y`. `tuning` (fractions of a bin) is estimated from y unless given. */
export function lowCqt(y: Float32Array, p: LowCqtParams, opts: { tuning?: number; mem?: MemTracker } = {}): LowCqt {
  const bpo = p.binsPerOctave;
  if (bpo % 12 !== 0) throw new Error(`lowCqt: binsPerOctave must be a multiple of 12, got ${bpo}`);
  const per = bpo / 12;
  const half = (per - 1) >> 1; // 1 for 36 bins per octave
  const tuning = opts.tuning ?? estimateTuning(y, { sr: LOW_SR, bpo }, opts.mem);
  const nBins = p.octaves * bpo;
  const nSemis = p.octaves * 12;
  let semi: Float32Array | null = null;
  let cols = 0;
  cqtMagnitudeStream(
    y,
    { sr: LOW_SR, hop: LOW_HOP, fmin: p.fminHz, nBins, bpo, tuning },
    (lo, nb, c, block) => {
      if (!semi) {
        cols = c;
        semi = new Float32Array(nSemis * cols);
      }
      const s = semi;
      for (let b = lo; b < lo + nb; b++) {
        const m = Math.floor((b + half) / per); // bin 3m-1..3m+1 -> m
        if (m < 0 || m >= nSemis) continue;
        const src = (b - lo) * c;
        const dst = m * cols;
        for (let t = 0; t < c; t++) if (block[src + t] > s[dst + t]) s[dst + t] = block[src + t];
      }
    },
    opts.mem,
  );
  if (!semi) throw new Error('lowCqt: no CQT output');
  return { semi, nSemis, cols, midi0: hzToMidi(p.fminHz), frameSec: LOW_HOP / LOW_SR, tuning };
}
