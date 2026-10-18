// Spike 4 T1: render one synthetic humming variant -> wav bytes + truth (deterministic per variant).

import { encodeWav } from '../wav';
import { perform, type Performance } from './contour';
import { addNoise, addReverb } from './degrade';
import { buildHumTruth, type HumTruth } from './truth';
import { humScore, SAMPLE_RATE, streamOf, synthParams, TAIL_SEC, type HumScore, type HumVariant, type SynthParams } from './variants';
import { addClicks, synthVoice, VOICE_PEAK } from './voice';

export interface RenderedHum {
  wav: Buffer;
  samples: Float32Array;
  /** The voice + breath before click bleed, reverb and noise (for checks). */
  dry: Float64Array;
  truth: HumTruth;
  score: HumScore;
  params: SynthParams;
  perf: Performance;
  peak: number;
  clipped: number;
}

export function renderHum(v: HumVariant, sr = SAMPLE_RATE): RenderedHum {
  const score = humScore(v);
  const params = synthParams(v);
  const perf = perform(v, score, params);
  const n = Math.round((perf.durationSec + TAIL_SEC) * sr);
  const x = synthVoice(v, perf, params, score.register, sr, n);
  const dry = Float64Array.from(x);
  if (params.clickDb !== null) addClicks(x, perf.clicks, 10 ** (params.clickDb / 20) * VOICE_PEAK, sr);
  if (params.reverbRt60 !== null) addReverb(x, params.reverbRt60, sr);
  if (params.noiseSnrDb !== null) addNoise(x, params.noiseSnrDb, streamOf(v, `noise-h${v.level}`));
  const samples = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = x[i];
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
  }
  const truth = buildHumTruth(v, score, params, perf, n / sr);
  return { wav: encodeWav(samples, sr), samples, dry, truth, score, params, perf, peak, clipped };
}
