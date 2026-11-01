/**
 * Spike 5 T5: instrument-agnostic onset detection with per-band features (docs/audio-spike5-plan.md section 2 S-3).
 *
 * Steps (fixed formulas and hand-set values only, no learned model):
 *  1. mono input -> config audio.sr (ts/dsp/core/resample.ts resampleSinc, linear phase: no time shift).
 *  2. band features (bands.ts): per-band log-compressed spectral flux and power per STFT frame.
 *  3. per band, the flux smoothed by a centred moving average of smoothFrames frames, then a per-recording threshold: median + thresholdMads * MAD of the band's flux (MAD scaled by 1.4826),
 *     and at least relFloor * (99th percentile of the flux) so a near-silent band does not fire on numerical noise;
 *     raised per frame to localMult * (mean flux over +-localMs) (cymbal washes, decays);
 *     peaks = local maxima within +-peakWindowMs that pass the threshold, at least minDistanceMs apart (larger wins).
 *  4. merge: band peaks closer than mergeMs (to the first peak of the group) are one onset; it keeps which bands fired.
 *  5. refine the time to the energy rise (refineOnset): around the onset frame, the point of the steepest rise of the
 *     (pre-emphasised) envelope, then back to the first sample whose amplitude reaches refineRelDb below the hit's
 *     peak, but not before the valley before the rise. Falls back to the frame time when no rise is found.
 *  6. per onset and band: flux (max within the merge window) and energyDb (max band power over the next
 *     featureMs, 10 log10, relative to nothing: absolute dB of the analysis-rate STFT) for T6.
 * Times are seconds from the start of the input.
 */
import { resampleSinc } from '../dsp/core/resample';
import { bandFeatures, type BandFeatures } from './bands';
import { DEFAULT_DRUM_CONFIG, type DrumConfig } from './config';

export interface DrumOnset {
  /** Refined onset time (s). */
  t: number;
  /** STFT frame of the merged peak (first band peak of the group). */
  frame: number;
  /** Band indexes whose own peak picking fired for this onset. */
  bands: number[];
  /** [band] max flux within the merge window around the onset frame. */
  flux: number[];
  /** [band] 10 log10 of the max band power over [frame, frame + featureMs]. */
  energyDb: number[];
  /** Whether refineOnset found an energy rise (else t is the frame time). */
  refined: boolean;
}

export interface OnsetDetection {
  onsets: DrumOnset[];
  /** Analysis rate and the resampled signal (T6 reuses them). */
  sr: number;
  y: Float32Array;
  features: BandFeatures;
  /** [band] threshold used. */
  thresholds: number[];
  /** [band] number of band peaks before merging. */
  bandPeaks: number[];
  ms: { resample: number; bands: number; peaks: number; refine: number; total: number };
}

/** Value at quantile q (0..1) of a copy, linear interpolation (numpy default). */
export function quantile(x: ArrayLike<number>, q: number): number {
  const a = Float64Array.from(x as ArrayLike<number>).sort();
  if (a.length === 0) return 0;
  const p = q * (a.length - 1);
  const lo = Math.floor(p);
  const hi = Math.min(a.length - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
}

/** Centred moving average over k frames (k odd; k <= 1 returns the input); edges average the frames that exist. */
export function smooth(f: Float32Array, k: number): Float32Array {
  if (k <= 1) return f;
  const h = Math.floor(k / 2);
  const out = new Float32Array(f.length);
  for (let t = 0; t < f.length; t++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, t - h); j <= Math.min(f.length - 1, t + h); j++) {
      s += f[j];
      c++;
    }
    out[t] = s / c;
  }
  return out;
}

/** median + nMads * 1.4826 * MAD, at least relFloor * quantile(0.99). */
export function adaptiveThreshold(f: ArrayLike<number>, nMads: number, relFloor: number): number {
  const med = quantile(f, 0.5);
  const dev = new Float64Array(f.length);
  for (let i = 0; i < f.length; i++) dev[i] = Math.abs(f[i] - med);
  const mad = 1.4826 * quantile(dev, 0.5);
  return Math.max(med + nMads * mad, relFloor * quantile(f, 0.99));
}

/** Per-frame threshold max(globalThr, mult * mean of f over [t - half, t + half]) (raised inside cymbal washes / decays). */
export function localThreshold(f: ArrayLike<number>, half: number, mult: number, globalThr: number): Float32Array {
  const n = f.length;
  const out = new Float32Array(n);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let t = 0; t < n; t++) {
    const a = Math.max(0, t - half);
    const b = Math.min(n - 1, t + half);
    while (hi < b) s += f[++hi];
    while (lo < a) s -= f[lo++];
    out[t] = Math.max(globalThr, (mult * s) / (b - a + 1));
  }
  return out;
}

/**
 * Frames that are the maximum of f within +-win frames (first of equal maxima), with f > thr, then thinned so peaks are
 * at least minDist frames apart (the larger survives; ties keep the earlier).
 */
export function pickPeaks(f: ArrayLike<number>, thr: number | ArrayLike<number>, win: number, minDist: number): number[] {
  const n = f.length;
  const cand: number[] = [];
  for (let t = 0; t < n; t++) {
    const v = f[t];
    if (!(v > (typeof thr === 'number' ? thr : thr[t]))) continue;
    let ok = true;
    for (let j = Math.max(0, t - win); j <= Math.min(n - 1, t + win) && ok; j++) {
      if (j === t) continue;
      if (f[j] > v || (f[j] === v && j < t)) ok = false;
    }
    if (ok) cand.push(t);
  }
  if (minDist <= 0) return cand;
  const byStrength = [...cand].sort((a, b) => f[b] - f[a] || a - b);
  const kept: number[] = [];
  for (const c of byStrength) if (kept.every((k) => Math.abs(k - c) >= minDist)) kept.push(c);
  return kept.sort((a, b) => a - b);
}

/** Groups of (frame, band) peaks: a peak joins the current group when within mergeFrames of the group's first frame. */
export function mergePeaks(peaks: { frame: number; band: number }[], mergeFrames: number): { frame: number; bands: number[] }[] {
  const s = [...peaks].sort((a, b) => a.frame - b.frame || a.band - b.band);
  const out: { frame: number; bands: number[] }[] = [];
  for (const p of s) {
    const last = out[out.length - 1];
    if (last && p.frame - last.frame <= mergeFrames) {
      if (!last.bands.includes(p.band)) last.bands.push(p.band);
    } else out.push({ frame: p.frame, bands: [p.band] });
  }
  for (const g of out) g.bands.sort((a, b) => a - b);
  return out;
}

export interface RefineOptions {
  /** Search radius around the frame centre (samples). */
  radius: number;
  /** Envelope block (samples). */
  block: number;
  /** Rise is measured over this many blocks. */
  riseBlocks: number;
  /** Minimum rise (dB) to accept. */
  minRiseDb: number;
  /** Onset = first sample at or above peak * 10^(relDb / 20) after the valley. */
  relDb: number;
  /** Pre-emphasis coefficient c of e[i] = y[i] - c y[i-1]. */
  preEmph: number;
}

/**
 * Onset sample near `centre` (see the file comment, step 5). Envelope = max |e| per block of the pre-emphasised signal
 * e[i] = y[i] - c y[i-1], c = exp(-2 pi refinePreEmphHz / sr), (keeps HH rises visible under a BD tail). Returns null when no rise of minRiseDb is found.
 */
export function refineOnset(y: Float32Array, centre: number, o: RefineOptions): number | null {
  const n = y.length;
  const from = Math.max(1, centre - o.radius - o.riseBlocks * o.block);
  const to = Math.min(n, centre + o.radius + o.block);
  const nb = Math.floor((to - from) / o.block);
  if (nb <= o.riseBlocks + 1) return null;
  const env = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let m = 0;
    const s = from + b * o.block;
    for (let i = s; i < s + o.block; i++) {
      const e = Math.abs(y[i] - o.preEmph * y[i - 1]);
      if (e > m) m = e;
    }
    env[b] = m;
  }
  const db = (v: number) => 20 * Math.log10(v + 1e-9);
  // steepest rise among blocks whose start is within the radius
  const firstB = o.riseBlocks;
  let best = -1;
  let bestRise = -Infinity;
  for (let b = firstB; b < nb; b++) {
    const s = from + b * o.block;
    if (s < centre - o.radius || s > centre + o.radius) continue;
    let lo = Infinity;
    for (let j = b - o.riseBlocks; j < b; j++) lo = Math.min(lo, env[j]);
    const rise = db(env[b]) - db(lo);
    if (rise > bestRise) {
      bestRise = rise;
      best = b;
    }
  }
  if (best < 0 || bestRise < o.minRiseDb) return null;
  // valley: minimum of the blocks before the rise; peak: max of the rise block and the next few
  let valley = best - o.riseBlocks;
  for (let j = best - o.riseBlocks; j < best; j++) if (env[j] <= env[valley]) valley = j;
  let peak = 0;
  for (let j = best; j < Math.min(nb, best + o.riseBlocks); j++) peak = Math.max(peak, env[j]);
  const thr = Math.max(peak * 10 ** (o.relDb / 20), env[valley] * 1.0001);
  const s0 = from + valley * o.block;
  const s1 = Math.min(n, from + (best + 1) * o.block);
  for (let i = Math.max(1, s0); i < s1; i++) {
    if (Math.abs(y[i] - o.preEmph * y[i - 1]) >= thr) return i;
  }
  return from + best * o.block;
}

export function detectOnsets(samples: Float32Array, sampleRate: number, cfg: DrumConfig = DEFAULT_DRUM_CONFIG): OnsetDetection {
  const t0 = performance.now();
  const sr = cfg.audio.sr;
  const y = resampleSinc(samples, sampleRate, sr);
  const t1 = performance.now();
  const features = bandFeatures(y, sr, cfg);
  const t2 = performance.now();
  const o = cfg.onset;
  const hopSec = o.hop / sr;
  const frames = (ms: number) => Math.max(0, Math.round(ms / 1000 / hopSec));
  const thresholds: number[] = [];
  const bandPeaks: number[] = [];
  const peaks: { frame: number; band: number }[] = [];
  for (let b = 0; b < features.nBands; b++) {
    const f = smooth(features.flux[b], o.smoothFrames);
    const thr = adaptiveThreshold(f, o.thresholdMads, o.relFloor);
    thresholds.push(thr);
    const p = pickPeaks(f, localThreshold(f, frames(o.localMs), o.localMult, thr), frames(o.peakWindowMs), frames(o.minDistanceMs));
    bandPeaks.push(p.length);
    for (const frame of p) peaks.push({ frame, band: b });
  }
  const mergeFrames = frames(o.mergeMs);
  const groups = mergePeaks(peaks, mergeFrames);
  const t3 = performance.now();
  const ropt: RefineOptions = {
    radius: Math.round((o.refineRadiusMs / 1000) * sr),
    block: Math.max(1, Math.round((o.refineBlockMs / 1000) * sr)),
    riseBlocks: o.refineRiseBlocks,
    minRiseDb: o.refineMinRiseDb,
    relDb: o.refineRelDb,
    preEmph: Math.exp((-2 * Math.PI * o.refinePreEmphHz) / sr),
  };
  const featFrames = frames(o.featureMs);
  const onsets: DrumOnset[] = [];
  let lastT = -Infinity;
  for (const g of groups) {
    const centre = g.frame * o.hop;
    const r = refineOnset(y, centre, ropt);
    let t = r === null ? centre / sr : r / sr;
    // keep order and the merge distance: a refined time may not move before the previous onset
    if (t <= lastT) t = Math.max(lastT + 1 / sr, centre / sr);
    lastT = t;
    const flux: number[] = [];
    const energyDb: number[] = [];
    for (let b = 0; b < features.nBands; b++) {
      let fm = 0;
      for (let j = Math.max(0, g.frame - mergeFrames); j <= Math.min(features.frames - 1, g.frame + mergeFrames); j++) fm = Math.max(fm, features.flux[b][j]);
      let em = 0;
      for (let j = g.frame; j <= Math.min(features.frames - 1, g.frame + featFrames); j++) em = Math.max(em, features.energy[b][j]);
      flux.push(fm);
      energyDb.push(10 * Math.log10(em + 1e-12));
    }
    onsets.push({ t, frame: g.frame, bands: g.bands, flux, energyDb, refined: r !== null });
  }
  const t4 = performance.now();
  return {
    onsets,
    sr,
    y,
    features,
    thresholds,
    bandPeaks,
    ms: { resample: t1 - t0, bands: t2 - t1, peaks: t3 - t2, refine: t4 - t3, total: t4 - t0 },
  };
}
