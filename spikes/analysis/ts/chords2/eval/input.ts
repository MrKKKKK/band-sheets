/**
 * Spike 7 T4: the input stage of the chords2 harness, in the order of the app's src/analysis/worker/runChords.ts:
 * resample to 22,050 Hz (ts/dsp `resampleSinc`, the research branch's sinc the app copies) -> optional input loudness
 * normalization (the app's src/lib/analysis/inputLevel.ts, imported, not copied) -> analyze. Off = spike 6's input
 * (rec_eval.ts without --normalize-rms); on = spike 6 R3 / issue #96 (one gain for the whole signal, RMS -22 dBFS, peak <= -1 dBFS).
 */
import { normalizeLevel } from '../../../../../src/lib/analysis/inputLevel';
import { resampleSinc, toMono } from '../../dsp/core/resample';

/** Sampling rate the chord analyzer runs at (runChords.ts CHORDS_SR). */
export const CHORDS_SR = 22050;

export interface PreparedInput {
  y: Float32Array;
  sampleRate: number;
  /** the gain applied in dB (0 when normalization is off, or the input is empty / silent) */
  gainDb: number;
}

/** Mono samples at `sampleRate` -> the signal `analyze` gets. A resampled copy is made, so `samples` is never changed. */
export function prepareInput(samples: Float32Array, sampleRate: number, normalize: boolean): PreparedInput {
  const r = resampleSinc(samples, sampleRate, CHORDS_SR);
  const y = r === samples ? samples.slice() : r; // resampleSinc returns its input at the same rate
  return { y, sampleRate: CHORDS_SR, gainDb: normalize ? normalizeLevel(y) : 0 };
}

/** Channels of a decoded file -> prepareInput. */
export const prepareChannels = (channels: Float32Array[], sampleRate: number, normalize: boolean): PreparedInput => prepareInput(toMono(channels), sampleRate, normalize);
