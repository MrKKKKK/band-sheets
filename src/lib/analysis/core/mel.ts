// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: core.convert hz_to_mel / mel_to_hz / mel_frequencies / fft_frequencies, filters.mel.
/**
 * Slaney mel scale and the Slaney-normalised mel filter bank (htk=False, norm='slaney'),
 * librosa notes section 5. The triangles are computed in float64 and stored as float32, then
 * multiplied by the float64 Slaney factor and stored as float32 again, as librosa does
 * (`weights[i] = ...` into a float32 array, then `weights *= enorm`).
 */

const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;

export function hzToMel(f: number): number {
  return f >= MIN_LOG_HZ
    ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP
    : f / F_SP;
}

export function melToHz(m: number): number {
  return m >= MIN_LOG_MEL
    ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL))
    : F_SP * m;
}

/** numpy.linspace(start, stop, num) (endpoint=True), same arithmetic. */
export function linspace(
  start: number,
  stop: number,
  num: number,
): Float64Array {
  const out = new Float64Array(num);
  if (num === 0) return out;
  const div = num - 1;
  const step = div > 0 ? (stop - start) / div : 0;
  for (let i = 0; i < num; i++) out[i] = i * step + start;
  if (num > 1) out[num - 1] = stop;
  return out;
}

/** librosa.mel_frequencies(n, fmin, fmax, htk=False). */
export function melFrequencies(
  n: number,
  fmin: number,
  fmax: number,
): Float64Array {
  const mels = linspace(hzToMel(fmin), hzToMel(fmax), n);
  for (let i = 0; i < n; i++) mels[i] = melToHz(mels[i]);
  return mels;
}

/** librosa.fft_frequencies(sr, n_fft) = numpy.fft.rfftfreq(n_fft, 1/sr). */
export function fftFrequencies(sr: number, nFft: number): Float64Array {
  const val = 1 / (nFft * (1 / sr));
  const out = new Float64Array(Math.floor(nFft / 2) + 1);
  for (let k = 0; k < out.length; k++) out[k] = k * val;
  return out;
}

export interface MelBank {
  nMels: number;
  bins: number;
  /** [nMels, bins] float32, row-major. */
  weights: Float32Array;
  /** Non-zero range of each row: weights[m, lo[m] .. hi[m]) (hi exclusive). */
  lo: Int32Array;
  hi: Int32Array;
}

/** librosa.filters.mel(sr, n_fft, n_mels, fmin, fmax, htk=False, norm='slaney', dtype=float32). */
export function melFilterBank(
  sr: number,
  nFft: number,
  nMels = 128,
  fmin = 0,
  fmax = sr / 2,
): MelBank {
  const bins = Math.floor(nFft / 2) + 1;
  const weights = new Float32Array(nMels * bins);
  const fftfreqs = fftFrequencies(sr, nFft);
  const melF = melFrequencies(nMels + 2, fmin, fmax);
  const lo = new Int32Array(nMels);
  const hi = new Int32Array(nMels);
  for (let i = 0; i < nMels; i++) {
    const fd0 = melF[i + 1] - melF[i];
    const fd1 = melF[i + 2] - melF[i + 1];
    const enorm = 2 / (melF[i + 2] - melF[i]);
    let first = -1;
    let last = -1;
    for (let k = 0; k < bins; k++) {
      const lower = -(melF[i] - fftfreqs[k]) / fd0;
      const upper = (melF[i + 2] - fftfreqs[k]) / fd1;
      const w = Math.max(0, Math.min(lower, upper));
      const v = Math.fround(Math.fround(w) * enorm);
      weights[i * bins + k] = v;
      if (v !== 0) {
        if (first < 0) first = k;
        last = k;
      }
    }
    lo[i] = first < 0 ? 0 : first;
    hi[i] = first < 0 ? 0 : last + 1;
  }
  return { nMels, bins, weights, lo, hi };
}

/** Apply the bank to one power-spectrum frame (float64 sums, float32 result). */
export function applyMel(
  bank: MelBank,
  power: ArrayLike<number>,
  out: Float32Array,
): void {
  const { nMels, bins, weights, lo, hi } = bank;
  for (let m = 0; m < nMels; m++) {
    let s = 0;
    const row = m * bins;
    for (let k = lo[m]; k < hi[m]; k++) s += weights[row + k] * power[k];
    out[m] = s;
  }
}
