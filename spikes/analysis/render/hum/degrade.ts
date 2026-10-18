// Spike 4 T1: degradations of the synthetic humming (docs/audio-spike4-plan.md section 4, design decision 5).
//
// py/degrade.py was checked and NOT reused as a step: it is wired to out/manifest.json and the spike-1
// level/condition tables (base variants of level 0/LR, fixed 44.1 kHz, CONDITIONS names), has no click
// bleed, and a second (Python, numpy-RNG) step would split one variant's seed across two programs and
// two containers. Instead the same simple methods are written here, in one deterministic TS pass:
//   - pink noise at an SNR measured against the ACTIVE RMS of the signal (frames of 2048 samples, frames
//     more than 40 dB below the loudest are ignored) -- same definition as degrade.py `active_rms`/`add_noise`
//     (pink here = Paul Kellet's filter on Gaussian white noise instead of an FFT 1/f shaping);
//   - room reverb: a Schroeder reverb (4 parallel combs with gains for the RT60, 2 allpasses) mixed with
//     the dry signal, cheaper than degrade.py's FFT convolution with an exp-decaying noise IR;
//   - click bleed (voice.ts addClicks) is added before the reverb (the headphone leak is in the room).
// Order: (voice + bleed) -> reverb -> noise, like degrade.py (reverb before noise).

import { gauss } from './voice';

export const ACTIVE_FRAME = 2048;
export const SILENCE_REL_DB = -40;

/** RMS over non-silent frames (degrade.py active_rms). */
export function activeRms(x: ArrayLike<number>): number {
  const n = Math.floor(x.length / ACTIVE_FRAME);
  if (n === 0) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return x.length ? Math.sqrt(s / x.length) : 0;
  }
  const e = new Float64Array(n);
  let max = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * ACTIVE_FRAME; i < (f + 1) * ACTIVE_FRAME; i++) s += x[i] * x[i];
    e[f] = s / ACTIVE_FRAME;
    max = Math.max(max, e[f]);
  }
  if (max <= 0) return 0;
  const thr = max * 10 ** (SILENCE_REL_DB / 10);
  let sum = 0;
  let cnt = 0;
  for (const v of e)
    if (v > thr) {
      sum += v;
      cnt++;
    }
  return Math.sqrt(sum / cnt);
}

/** Unit-RMS pink noise (Paul Kellet's refined filter on Gaussian white noise). */
export function pinkNoise(n: number, rnd: () => number): Float64Array {
  const y = new Float64Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const w = gauss(rnd);
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    y[i] = v;
    ss += v * v;
  }
  const k = 1 / Math.sqrt(ss / Math.max(1, n));
  for (let i = 0; i < n; i++) y[i] *= k;
  return y;
}

/** Adds pink noise so that activeRms(x) / rms(noise) = snrDb (in place). */
export function addNoise(x: Float64Array, snrDb: number, rnd: () => number): void {
  const noise = pinkNoise(x.length, rnd);
  const g = activeRms(x) / 10 ** (snrDb / 20);
  for (let i = 0; i < x.length; i++) x[i] += g * noise[i];
}

const COMB_MS = [29.7, 37.1, 41.1, 43.7];
const ALLPASS: [number, number][] = [
  [5.0, 0.7],
  [1.7, 0.7],
];
export const REVERB_WET = 0.35;

/** Schroeder reverb, output = (1 - wet) * dry + wet * reverb (same length, in place). */
export function addReverb(x: Float64Array, rt60: number, sr: number, wet = REVERB_WET): void {
  const n = x.length;
  const rev = new Float64Array(n);
  for (const ms of COMB_MS) {
    const d = Math.round((ms / 1000) * sr);
    const g = 10 ** ((-3 * d) / sr / rt60);
    const buf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const y = x[i] + (i >= d ? g * buf[i - d] : 0);
      buf[i] = y;
      rev[i] += y * (1 - g) * 0.5;
    }
  }
  for (const [ms, g] of ALLPASS) {
    const d = Math.round((ms / 1000) * sr);
    const inp = Float64Array.from(rev);
    for (let i = 0; i < n; i++) rev[i] = -g * inp[i] + (i >= d ? inp[i - d] + g * rev[i - d] : 0);
  }
  for (let i = 0; i < n; i++) x[i] = (1 - wet) * x[i] + wet * rev[i];
}
