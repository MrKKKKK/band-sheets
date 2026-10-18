// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: filters.chroma, feature.chroma_stft(S=..., tuning=0.0), util.localmax, fft_frequencies.
/**
 * py/dsp/tempo.py event_times: onset peaks of the percussive envelope plus peaks of the novelty
 * of the harmonic chroma (full band and below 250 Hz), computed from an STFT with n_fft = 4096.
 * The candidate scoring itself lives in beats.ts (chooseOctave).
 *
 * The 4096-point power spectrogram is never stored: each frame is turned into its two chroma
 * vectors (full band, bass band) on the spot, so the memory is 2 x 12 x frames float32.
 */
import { framesToTime, localmax } from './beats';
import { StftFramer } from './core/stft';
import { MemTracker } from './core/mem';

export const EVENT_N_FFT = 4096;
export const BASS_FMAX = 250.0;
const PEAK_REL = 0.3;
const MIN_GAP = 0.03;
const TINY32 = 1.1754943508222875e-38;

/**
 * librosa.filters.chroma(sr, n_fft, n_chroma=12, tuning=0.0, ctroct=5.0, octwidth=2, norm=2,
 * base_c=True, dtype=float32): [12, 1 + n_fft/2], row-major, float32.
 */
export function chromaFilterBank(sr: number, nFft: number, nChroma = 12): Float32Array {
  const ctroct = 5.0;
  const octwidth = 2.0;
  // frequencies = linspace(0, sr, nFft, endpoint=False)[1:]
  const step = sr / nFft;
  const frq = new Float64Array(nFft);
  for (let i = 1; i < nFft; i++) frq[i] = nChroma * Math.log2((i * step) / (440.0 / 16));
  frq[0] = frq[1] - 1.5 * nChroma;
  const bw = new Float64Array(nFft);
  for (let k = 0; k < nFft - 1; k++) bw[k] = Math.max(frq[k + 1] - frq[k], 1.0);
  bw[nFft - 1] = 1.0;
  const half = Math.round(nChroma / 2);
  const wts = new Float64Array(nChroma * nFft);
  for (let k = 0; k < nFft; k++) {
    let ss = 0;
    for (let c = 0; c < nChroma; c++) {
      const d = ((((frq[k] - c + half + 10 * nChroma) % nChroma) + nChroma) % nChroma) - half;
      const w = Math.exp(-0.5 * ((2 * d) / bw[k]) ** 2);
      wts[c * nFft + k] = w;
      ss += w * w;
    }
    let nrm = Math.sqrt(ss);
    if (nrm < TINY32) nrm = 1;
    const oct = Math.exp(-0.5 * ((frq[k] / nChroma - ctroct) / octwidth) ** 2);
    for (let c = 0; c < nChroma; c++) wts[c * nFft + k] = (wts[c * nFft + k] / nrm) * oct;
  }
  const bins = 1 + nFft / 2;
  const out = new Float32Array(nChroma * bins);
  const shift = 3 * Math.floor(nChroma / 12); // base_c: roll(-3)
  for (let c = 0; c < nChroma; c++) {
    const src = (c + shift) % nChroma;
    for (let k = 0; k < bins; k++) out[c * bins + k] = wts[src * nFft + k];
  }
  return out;
}

/** tempo._novelty: 1 - cosine of consecutive 3-frame-smoothed chroma frames. chroma: [frames, 12]. */
export function novelty(chroma: Float32Array, frames: number): Float64Array {
  const nov = new Float64Array(frames);
  const k = 1 / 3;
  const c = new Float64Array(frames * 12);
  for (let t = 0; t < frames; t++) {
    for (let j = 0; j < 12; j++) {
      const at = (i: number) => (i >= 0 && i < frames ? chroma[i * 12 + j] : 0);
      c[t * 12 + j] = k * at(t + 1) + k * at(t) + k * at(t - 1);
    }
    let s = 0;
    for (let j = 0; j < 12; j++) s += c[t * 12 + j] ** 2;
    let n = Math.sqrt(s);
    if (n === 0) n = 1;
    for (let j = 0; j < 12; j++) c[t * 12 + j] /= n;
  }
  for (let t = 1; t < frames; t++) {
    let s = 0;
    for (let j = 0; j < 12; j++) s += c[t * 12 + j] * c[(t - 1) * 12 + j];
    nov[t] = 1.0 - s;
  }
  return nov;
}

/** tempo._peaks: local maxima above rel * max (frame indices). `f32` = threshold computed in float32. */
export function peaks(x: ArrayLike<number>, rel: number, f32: boolean): number[] {
  const n = x.length;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) if (x[i] > mx) mx = x[i];
  if (n === 0 || !(mx > 0)) return [];
  const thr = f32 ? Math.fround(Math.fround(rel) * mx) : rel * mx;
  const lm = localmax(x);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (lm[i] && x[i] > thr) out.push(i);
  return out;
}

export interface EventInput {
  onsetEnv: Float32Array;
  yHarm: Float32Array;
  sr?: number;
  hop?: number;
}

/** Seconds of onsets, chord changes and bass changes (sorted, de-duplicated within 30 ms). */
export function tempoEventTimes(input: EventInput, mem: MemTracker = new MemTracker()): Float64Array {
  const sr = input.sr ?? 22050;
  const hop = input.hop ?? 512;
  const ev: number[] = peaks(input.onsetEnv, PEAK_REL, true);
  const y = input.yHarm;
  if (y.length > 0) {
    const nFft = EVENT_N_FFT;
    const fr = new StftFramer(y, { nFft, hop }, mem);
    const { bins, frames } = fr;
    const fb = chromaFilterBank(sr, nFft);
    // bass band: bins with fft_frequencies < 250
    let nBass = 0;
    for (let k = 0; k < bins; k++) if (k * (1 / (nFft * (1 / sr))) < BASS_FMAX) nBass = k + 1;
    const re = mem.f32(bins);
    const im = mem.f32(bins);
    const pw = new Float32Array(bins);
    const full = mem.f32(frames * 12);
    const bass = mem.f32(frames * 12);
    const raw = new Float64Array(12);
    const emit = (out: Float32Array, t: number, kEnd: number) => {
      let mx = 0;
      for (let c = 0; c < 12; c++) {
        let s = 0;
        const o = c * bins;
        for (let k = 0; k < kEnd; k++) s += fb[o + k] * pw[k];
        const v = Math.fround(s);
        raw[c] = v;
        if (Math.abs(v) > mx) mx = Math.abs(v);
      }
      const norm = mx < TINY32 ? 1 : mx; // util.normalize(norm=inf): small norms are left alone
      for (let c = 0; c < 12; c++) out[t * 12 + c] = raw[c] / norm;
    };
    for (let t = 0; t < frames; t++) {
      fr.frame(t, re, im);
      for (let k = 0; k < bins; k++) {
        const a = Math.fround(Math.hypot(re[k], im[k]));
        pw[k] = Math.fround(a * a);
      }
      emit(full, t, bins);
      emit(bass, t, nBass);
    }
    for (const ch of [full, bass]) ev.push(...peaks(novelty(ch, frames), PEAK_REL, false));
    mem.release(re, im, full, bass);
  }
  const frames = Array.from(new Set(ev)).sort((a, b) => a - b);
  const t = framesToTime(frames, sr, hop);
  if (t.length === 0) return t;
  const keep: number[] = [t[0]];
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > MIN_GAP) keep.push(t[i]);
  return Float64Array.from(keep);
}
