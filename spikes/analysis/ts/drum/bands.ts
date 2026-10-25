/**
 * Spike 5 T5: band features of the drum analyzer (docs/audio-spike5-plan.md section 2 S-3, section 6).
 *
 * One pass of the centred Hann STFT (ts/dsp/core/stft.ts StftFramer, librosa conventions) over the analysis-rate
 * signal. Per frame and per band (config bands.edgesHz: [e0, e1) low ~BD, [e1, e2) mid ~SD, [e2, e3) high ~HH):
 *  - flux: mean over the band's bins k of max(0, L[t][k] - max(L[t-lag][k-maxBins .. k+maxBins])) with
 *    L = log(1 + logGamma * |X|): log-compressed spectral flux, half-wave rectified, with the SuperFlux lag and
 *    frequency maximum filter (Böck & Widmer 2013, own implementation) that suppress decays / slow modulation.
 *    Frames t < lag have flux 0.
 *  - energy: sum of |X|^2 over the band's bins (linear power; T6 uses it for the band rules / strengths).
 * Frame t is centred on sample t * hop. Nothing here is learned: fixed formulas only.
 */
import { StftFramer } from '../dsp/core/stft';
import type { DrumConfig } from './config';

/** Bin ranges [lo, hi) of the bands; bin k has frequency k * sr / nFft. Edges above Nyquist are clipped. */
export function bandBins(edgesHz: readonly number[], nFft: number, sr: number): [number, number][] {
  if (edgesHz.length < 2) throw new Error('bands.edgesHz needs at least 2 edges');
  const nyqBin = nFft / 2;
  const bin = (hz: number) => Math.min(nyqBin + 1, Math.max(0, Math.ceil((hz * nFft) / sr)));
  const out: [number, number][] = [];
  for (let b = 0; b + 1 < edgesHz.length; b++) {
    if (!(edgesHz[b + 1] > edgesHz[b])) throw new Error(`bands.edgesHz must increase, got ${edgesHz.join(',')}`);
    const lo = bin(edgesHz[b]);
    const hi = bin(edgesHz[b + 1]);
    if (hi <= lo) throw new Error(`band ${b} (${edgesHz[b]}-${edgesHz[b + 1]} Hz) has no bins at sr ${sr}, nFft ${nFft}`);
    out.push([lo, hi]);
  }
  return out;
}

export interface BandFeatures {
  sr: number;
  hop: number;
  frames: number;
  nBands: number;
  bins: [number, number][];
  /** [band][frame] log-compressed spectral flux. */
  flux: Float32Array[];
  /** [band][frame] power sum. */
  energy: Float32Array[];
}

export function bandFeatures(y: Float32Array, sr: number, cfg: Pick<DrumConfig, 'onset' | 'bands'>): BandFeatures {
  const { win, hop, logGamma, lag, maxBins } = cfg.onset;
  if (!(Number.isInteger(lag) && lag >= 1)) throw new Error(`onset.lag must be an integer >= 1, got ${lag}`);
  const bins = bandBins(cfg.bands.edgesHz, win, sr);
  const nBands = bins.length;
  const fr = new StftFramer(y, { nFft: win, hop });
  const frames = fr.frames;
  const flux = bins.map(() => new Float32Array(frames));
  const energy = bins.map(() => new Float32Array(frames));
  const kHi = bins[nBands - 1][1];
  const nb = fr.bins;
  // ring of the last lag + 1 frames: log magnitude (all bins) and its frequency max filter
  const logRing = Array.from({ length: lag + 1 }, () => new Float64Array(nb));
  const maxRing = Array.from({ length: lag + 1 }, () => new Float64Array(nb));
  for (let t = 0; t < frames; t++) {
    fr.frame(t);
    const { re, im } = fr;
    const L = logRing[t % (lag + 1)];
    const M = maxRing[t % (lag + 1)];
    for (let k = 0; k < Math.min(nb, kHi + maxBins); k++) L[k] = Math.log1p(logGamma * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    for (let k = 0; k < Math.min(nb, kHi); k++) {
      let m = L[k];
      for (let j = Math.max(0, k - maxBins); j <= Math.min(nb - 1, k + maxBins); j++) if (L[j] > m) m = L[j];
      M[k] = m;
    }
    const P = maxRing[(t - lag + (lag + 1) * 2) % (lag + 1)];
    for (let b = 0; b < nBands; b++) {
      const [lo, hi] = bins[b];
      let e = 0;
      let f = 0;
      for (let k = lo; k < hi; k++) {
        e += re[k] * re[k] + im[k] * im[k];
        if (t >= lag) {
          const d = L[k] - P[k];
          if (d > 0) f += d;
        }
      }
      energy[b][t] = e;
      flux[b][t] = f / (hi - lo);
    }
  }
  return { sr, hop, frames, nBands, bins, flux, energy };
}
