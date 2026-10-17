// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: effects.hpss, decompose.hpss, util.softmask, core.magphase, onset.onset_strength(_multi), feature.melspectrogram, core.power_to_db.
/**
 * Stage 1 of the analyzer (py/dsp/audio.py): HPSS (margin 1) and onset strength, following
 * librosa notes sections 3-5. Input is the 22050 Hz mono float32 signal (resampling is not here).
 *
 * Memory: the complex STFT is never stored. HPSS keeps only |STFT| (float32, frames x 1025) plus
 * one sorted 31-value window per bin; the second pass recomputes each STFT frame, masks it and
 * overlap-adds both outputs (one complex IFFT for the pair). Onset strength stores the 128-band
 * mel dB spectrogram (needed whole for the 80 dB cut against the global max).
 */
import { RealFft } from './core/fft';
import { applyMel, melFilterBank, type MelBank } from './core/mel';
import { MemTracker } from './core/mem';
import { reflectIndex, medianFilter1d, SlidingMedians } from './core/median';
import { OverlapAdd, StftFramer, STFT_DEFAULT } from './core/stft';

export const SR = 22050;
export const HOP = 512;
export const N_FFT = 2048;
export const HPSS_KERNEL = 31;
const TINY32 = 1.1754943508222875e-38;

export interface HpssOptions {
  /** Also return |masked STFT| ([frames, bins] float32), for the parity tests only. */
  keepMaskedMagnitudes?: boolean;
}

export interface HpssResult {
  yHarm: Float32Array;
  yPerc: Float32Array;
  frames: number;
  bins: number;
  harmMag?: Float32Array;
  percMag?: Float32Array;
}

/**
 * librosa.softmask(x, xRef, power=2, split_zeros=true) for one element, float32 arithmetic.
 */
function softmask2(x: number, xRef: number): number {
  const z = Math.max(x, xRef);
  if (z < TINY32) return 0.5;
  const a = Math.fround(x / z);
  const b = Math.fround(xRef / z);
  const m = Math.fround(a * a);
  const r = Math.fround(b * b);
  return Math.fround(m / Math.fround(m + r));
}

/** librosa.effects.hpss(y, margin=1.0) with kernel 31, power 2, n_fft 2048, hop 512. */
export function hpss(y: Float32Array, mem: MemTracker = new MemTracker(), opts: HpssOptions = {}): HpssResult {
  const fr = new StftFramer(y, STFT_DEFAULT, mem);
  const { frames: F, bins: B, nFft } = fr;
  const k = HPSS_KERNEL;
  const h = (k - 1) / 2;

  // Pass 1: S = |D| (float32 of the complex64 values), frame-major.
  const S = mem.f32(F * B);
  const re32 = mem.f32(B);
  const im32 = mem.f32(B);
  for (let t = 0; t < F; t++) {
    fr.frame(t, re32, im32);
    const row = t * B;
    for (let b = 0; b < B; b++) S[row + b] = Math.hypot(re32[b], im32[b]);
  }

  // Time-direction median (harmonic): one sorted window per bin, sliding over frames.
  const lanes = new SlidingMedians(B, k, mem);
  for (let b = 0; b < B; b++) lanes.init(b, (j) => S[reflectIndex(j - h, F) * B + b]);
  const perc = mem.f32(B);
  const scratch = mem.f32(k);
  const hRe = mem.f64(B);
  const hIm = mem.f64(B);
  const pRe = mem.f64(B);
  const pIm = mem.f64(B);
  const outH = mem.f64(nFft);
  const outP = mem.f64(nFft);
  const ifft = new RealFft(nFft, mem);
  const olaH = new OverlapAdd(y.length, F, STFT_DEFAULT, mem);
  const olaP = new OverlapAdd(y.length, F, STFT_DEFAULT, mem);
  const harmMag = opts.keepMaskedMagnitudes ? mem.f32(F * B) : undefined;
  const percMag = opts.keepMaskedMagnitudes ? mem.f32(F * B) : undefined;

  for (let t = 0; t < F; t++) {
    const row = t * B;
    const sRow = S.subarray(row, row + B);
    medianFilter1d(sRow, k, perc, scratch); // frequency-direction median (percussive)
    fr.frame(t, re32, im32);
    for (let b = 0; b < B; b++) {
      const harm = lanes.median(b);
      const s = sRow[b];
      const mh = softmask2(harm, perc[b]);
      const mp = softmask2(perc[b], harm);
      // magphase: phase = D / |D| (|D| = 0 -> 1 + 0i), then (S * mask) * phase, all float32.
      const zero = s === 0 ? 1 : 0;
      const den = s + zero;
      const phr = Math.fround(Math.fround(re32[b] / den) + zero);
      const phi = Math.fround(im32[b] / den);
      const sh = Math.fround(s * mh);
      const sp = Math.fround(s * mp);
      hRe[b] = Math.fround(sh * phr);
      hIm[b] = Math.fround(sh * phi);
      pRe[b] = Math.fround(sp * phr);
      pIm[b] = Math.fround(sp * phi);
      if (harmMag && percMag) {
        harmMag[row + b] = Math.hypot(hRe[b], hIm[b]);
        percMag[row + b] = Math.hypot(pRe[b], pIm[b]);
      }
    }
    ifft.irfftPair(hRe, hIm, pRe, pIm, outH, outP);
    olaH.add(t, outH, fr.window);
    olaP.add(t, outP, fr.window);
    // advance the time windows to frame t+1
    if (t + 1 < F) {
      const oldRow = reflectIndex(t - h, F) * B;
      const newRow = reflectIndex(t + h + 1, F) * B;
      for (let b = 0; b < B; b++) lanes.replace(b, S[oldRow + b], S[newRow + b]);
    }
  }
  mem.release(S, re32, im32, perc, scratch, hRe, hIm, pRe, pIm, outH, outP, lanes);
  const yHarm = olaH.finish();
  const yPerc = olaP.finish();
  return { yHarm, yPerc, frames: F, bins: B, harmMag, percMag };
}

let melBankCache: MelBank | undefined;

function melBank(): MelBank {
  melBankCache ??= melFilterBank(SR, N_FFT, 128, 0, SR / 2);
  return melBankCache;
}

/**
 * librosa.onset.onset_strength(y=y, sr=22050, hop_length=512): mel power spectrogram (128
 * Slaney bands) -> power_to_db(ref 1, amin 1e-10, top_db 80 against the GLOBAL max) -> lag-1
 * difference, max(0, .) -> mean over bands -> 3 leading zeros (lag 1 + n_fft / (2 hop)),
 * trimmed to the frame count.
 */
export function onsetStrength(y: Float32Array, mem: MemTracker = new MemTracker()): Float32Array {
  const fr = new StftFramer(y, STFT_DEFAULT, mem);
  const { frames: F, bins: B } = fr;
  const bank = melBank();
  const M = bank.nMels;
  mem.adopt(bank.weights);
  const db = mem.f32(F * M);
  const re32 = mem.f32(B);
  const im32 = mem.f32(B);
  const power = mem.f32(B);
  const mel = mem.f32(M);
  const amin = Math.fround(1e-10);
  let max = -Infinity;
  for (let t = 0; t < F; t++) {
    fr.frame(t, re32, im32);
    for (let b = 0; b < B; b++) {
      const a = Math.fround(Math.hypot(re32[b], im32[b]));
      power[b] = a * a;
    }
    applyMel(bank, power, mel);
    const row = t * M;
    for (let m = 0; m < M; m++) {
      const v = Math.fround(10 * Math.fround(Math.log10(Math.max(amin, mel[m]))));
      db[row + m] = v;
      if (v > max) max = v;
    }
  }
  const floor = Math.fround(max - 80);
  for (let i = 0; i < db.length; i++) if (db[i] < floor) db[i] = floor;

  const env = mem.f32(F);
  const lead = 1 + Math.floor(N_FFT / (2 * HOP)); // 3
  for (let t = lead; t < F; t++) {
    const cur = (t - lead + 1) * M;
    const prev = (t - lead) * M;
    let s = 0;
    for (let m = 0; m < M; m++) s += Math.max(0, Math.fround(db[cur + m] - db[prev + m]));
    env[t] = s / M;
  }
  mem.release(db, re32, im32, power, mel, bank.weights);
  return env;
}

export interface Features {
  sr: number;
  hop: number;
  duration: number;
  y: Float32Array;
  yHarm: Float32Array;
  yPerc: Float32Array;
  onsetEnv: Float32Array;
  /** Memory accounting for this stage (bytes of typed arrays). */
  mem: { peak: number; live: number; total: number };
}

/**
 * py/dsp/audio.py load_features after loading (default config: HPSS on, margin 1): y must
 * already be 22050 Hz mono float32.
 */
export function loadFeatures(y: Float32Array, mem: MemTracker = new MemTracker()): Features {
  mem.adopt(y);
  let yHarm = y;
  let yPerc = y;
  let onsetEnv: Float32Array;
  if (y.length > 0) {
    ({ yHarm, yPerc } = hpss(y, mem));
    onsetEnv = onsetStrength(yPerc, mem);
  } else {
    onsetEnv = mem.f32(0);
  }
  return {
    sr: SR,
    hop: HOP,
    duration: y.length / SR,
    y,
    yHarm,
    yPerc,
    onsetEnv,
    mem: { peak: mem.peak, live: mem.live, total: mem.total },
  };
}
