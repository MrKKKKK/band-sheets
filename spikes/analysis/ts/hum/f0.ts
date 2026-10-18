/**
 * Spike 4 T4: frame f0 tracking (docs/audio-spike4-plan.md section 2 "f0" and "voicing", section 7 T4).
 *
 * Own implementation of YIN (de Cheveigne & Kawahara 2002) from the paper; no third-party pitch code.
 *
 *   input            mono samples at any rate -> resampled to cfg.audio.sr (22050) with ts/dsp/core/resample.ts
 *   frames           frame i is centred on sample i * hop (t = i * hopSec, t0 = 0; the render/hum truth grid).
 *                    One frame = `win` samples starting at centre - win / 2 (zero outside the signal).
 *   difference       d(tau) = sum_{j<W} (x_j - x_{j+tau})^2 for tau = 0 .. tauMax + 1, integration window
 *                    W = win - tauMax - 1 (so the last lag still fits in the frame: 1024 - 340 - 1 = 683 at 65 Hz).
 *                    Computed as E(0) + E(tau) - 2 r(tau) with r(tau) = sum_j x_j x_{j+tau} from ONE real FFT of
 *                    size `win` (the cross-correlation of the first W samples with the whole frame does not wrap,
 *                    because j + tau < win) and the energies E(tau) from a running sum of squares.
 *   CMND             d'(0) = 1, d'(tau) = d(tau) * tau / sum_{k=1..tau} d(k)        (paper step 3)
 *   absolute thr.    the first tau in [tauMin, tauMax] with d' < yinThreshold, then down to its local minimum
 *                    (step 4); none below: the global minimum, marked "not below".  tauMin = floor(sr / fmax),
 *                    tauMax = ceil(sr / fmin).
 *   octave check     (our addition) the pick moves to the dip near 2 tau when that one is much deeper: see octaveCheck
 *   interpolation    parabola through d'(tau - 1), d'(tau), d'(tau + 1) (step 5), then Newton steps on d(t) with r(t)
 *                    from the trigonometric interpolant of the correlation spectrum (YinFrameAnalyzer.refineLag)
 *   voiced prob      YIN mode: p = clamp(1 - d'(tau) / (2 * yinThreshold)), so d' = threshold is p = 0.5.
 *                    pYIN mode (cfg.f0.pyin): ts/hum/pyin.ts (multi-threshold candidates + pitch HMM + Viterbi).
 *   voicing          (both modes) a frame is voiced when its prob >= voicing.minVoicedProb (pYIN: the Viterbi
 *                    path is in a voiced state) AND its level (RMS over the integration window, dB) is at least
 *                    voicing.noiseMarginDb above the recording's noise floor (the voicing.noisePercentile
 *                    percentile of the frame levels, floored at -100 dB; the gate is capped at noiseMarginDb below
 *                    the (1 - noisePercentile) percentile so a file without a quiet part is not all gated). Unvoiced gaps shorter than
 *                    voicing.bridgeGapMs between voiced frames whose pitch stays within 1 semitone are bridged.
 *
 * npm `pitchy` (0BSD, McLeod pitch method) is NOT used: it returns one pitch + clarity per frame, but pYIN needs
 * the whole CMND curve per frame (dips under several thresholds), the FFT is already here (ts/dsp/core/fft.ts), and
 * the YIN core is ~150 lines, so a dependency would add size without saving work.
 *
 * Evaluation (tuning + dev synthetic only): ts/hum/f0_eval.ts; librosa pyin reference: py/tools/pyin_ref.py.
 *
 * Output FrameF0Track: hz = the pitch estimate of every frame that has one (also unvoiced ones, so scoring can
 * use the mir_eval "negative = unvoiced guess" convention via trackSignedHz), 0 for silent frames; voiced = the
 * final decision as 0 / 1 (the raw probability is in F0Result.prob).
 */
import { RealFft } from '../dsp/core/fft';
import { resampleSinc } from '../dsp/core/resample';
import { DEFAULT_HUM_CONFIG, type HumConfig } from './config';
import type { FrameF0Track } from './types';
import { pyinDecode, pyinWeights, type PyinFrame } from './pyin';

/** Frames below this mean-square level (-100 dBFS) are silent: no pitch, never voiced. */
export const SILENCE_DB = -100;

export interface YinGeometry {
  sr: number;
  win: number;
  hop: number;
  tauMin: number;
  tauMax: number;
  /** Integration window. */
  w: number;
}

export function yinGeometry(cfg: HumConfig = DEFAULT_HUM_CONFIG): YinGeometry {
  const { sr } = cfg.audio;
  const { win, hop, fminHz, fmaxHz } = cfg.f0;
  const tauMin = Math.max(2, Math.floor(sr / fmaxHz));
  const tauMax = Math.ceil(sr / fminHz);
  const w = win - tauMax - 1;
  if (w < tauMax) throw new Error(`f0: window ${win} too short for fmin ${fminHz} Hz (needs >= ${2 * tauMax + 1} samples)`);
  return { sr, win, hop, tauMin, tauMax, w };
}

/**
 * Computes the CMND of one frame at a time. `cmnd` (length tauMax + 2) is reused between calls.
 * Direct O(W * tau) reference: `differenceDirect`.
 */
export class YinFrameAnalyzer {
  readonly g: YinGeometry;
  /** d'(tau), tau = 0 .. tauMax + 1. */
  readonly cmnd: Float64Array;
  /** d(tau). */
  readonly diff: Float64Array;
  /** E(tau) = sum_{j=tau}^{tau+W-1} x_j^2. */
  readonly energy: Float64Array;
  /** sum_{k=1..tau} d(k). */
  readonly cum: Float64Array;
  private readonly fft: RealFft;
  private readonly frame: Float64Array;
  private readonly head: Float64Array;
  private readonly aRe: Float64Array;
  private readonly aIm: Float64Array;
  private readonly xRe: Float64Array;
  private readonly xIm: Float64Array;
  private readonly corr: Float64Array;
  /** Mean square over the integration window of the last frame. */
  meanSquare = 0;

  constructor(g: YinGeometry) {
    this.g = g;
    if ((g.win & (g.win - 1)) !== 0) throw new Error(`f0: win must be a power of two, got ${g.win}`);
    this.fft = new RealFft(g.win);
    this.frame = new Float64Array(g.win);
    this.head = new Float64Array(g.win);
    const b = g.win / 2 + 1;
    this.aRe = new Float64Array(b);
    this.aIm = new Float64Array(b);
    this.xRe = new Float64Array(b);
    this.xIm = new Float64Array(b);
    this.corr = new Float64Array(g.win);
    this.cmnd = new Float64Array(g.tauMax + 2);
    this.diff = new Float64Array(g.tauMax + 2);
    this.energy = new Float64Array(g.tauMax + 2);
    this.cum = new Float64Array(g.tauMax + 2);
  }

  /** Fills diff / cmnd / meanSquare for the frame centred on sample `centre` of `y`. Returns meanSquare. */
  analyze(y: ArrayLike<number>, centre: number): number {
    const { win, w, tauMax } = this.g;
    const fr = this.frame;
    const start = centre - win / 2;
    for (let j = 0; j < win; j++) {
      const k = start + j;
      fr[j] = k >= 0 && k < y.length ? y[k] : 0;
    }
    const nl = tauMax + 2;
    // energies E(tau) = sum_{j=tau}^{tau+W-1} x_j^2
    let e = 0;
    for (let j = 0; j < w; j++) e += fr[j] * fr[j];
    const e0 = e;
    this.meanSquare = e0 / w;
    const d = this.diff;
    const dp = this.cmnd;
    this.energy[0] = e0;
    if (this.meanSquare < Math.pow(10, SILENCE_DB / 10)) {
      this.energy.fill(0);
      this.cum.fill(0);
      d.fill(0);
      dp.fill(1);
      return this.meanSquare;
    }
    const head = this.head;
    for (let j = 0; j < win; j++) head[j] = j < w ? fr[j] : 0;
    this.fft.rfft(head, this.aRe, this.aIm);
    this.fft.rfft(fr, this.xRe, this.xIm);
    // conj(A) * X
    const bins = this.fft.bins;
    for (let k = 0; k < bins; k++) {
      const ar = this.aRe[k];
      const ai = this.aIm[k];
      const xr = this.xRe[k];
      const xi = this.xIm[k];
      this.xRe[k] = ar * xr + ai * xi;
      this.xIm[k] = ar * xi - ai * xr;
    }
    this.fft.irfft(this.xRe, this.xIm, this.corr);
    d[0] = 0;
    dp[0] = 1;
    let et = e0;
    let cum = 0;
    for (let tau = 1; tau < nl; tau++) {
      et += fr[tau + w - 1] * fr[tau + w - 1] - fr[tau - 1] * fr[tau - 1];
      this.energy[tau] = et;
      const v = e0 + et - 2 * this.corr[tau];
      d[tau] = v > 0 ? v : 0;
      cum += d[tau];
      this.cum[tau] = cum;
      dp[tau] = cum > 0 ? (d[tau] * tau) / cum : 1;
    }
    return this.meanSquare;
  }

  /**
   * r(tau) and its first two derivatives at a FRACTIONAL lag, from the trigonometric interpolant of the
   * cross-correlation (the conj(A) X spectrum of the last frame): r(tau) = (1/N) sum_k C_k e^{2 pi i k tau / N}.
   * At integer lags it equals the r used for d(tau).
   */
  corrAt(tau: number): [number, number, number] {
    const n = this.g.win;
    const h = n / 2;
    const re = this.xRe;
    const im = this.xIm;
    const w = (2 * Math.PI) / n;
    const cs = Math.cos(w * tau);
    const sn = Math.sin(w * tau);
    let c = 1;
    let s = 0;
    let r0 = re[0];
    let r1 = 0;
    let r2 = 0;
    for (let k = 1; k < h; k++) {
      const c2 = c * cs - s * sn;
      s = s * cs + c * sn;
      c = c2;
      const v = re[k] * c - im[k] * s; // Re(C_k e^{i w k tau})
      const dv = -(re[k] * s + im[k] * c); // d/d(w k tau)
      const wk = w * k;
      r0 += 2 * v;
      r1 += 2 * wk * dv;
      r2 -= 2 * wk * wk * v;
    }
    const ny = Math.cos(Math.PI * tau);
    r0 += re[h] * ny;
    r1 -= re[h] * Math.PI * Math.sin(Math.PI * tau);
    r2 -= re[h] * Math.PI * Math.PI * ny;
    return [r0 / n, r1 / n, r2 / n];
  }

  /**
   * Sub-sample lag of the minimum of d near integer `tau`: start from the parabola through d'(tau - 1 .. tau + 1),
   * then Newton steps on d(t) = E(0) + E(t) - 2 r(t) with r from corrAt and E linear between integer lags; stays
   * within tau +- 1 (falls back to the parabola if Newton leaves it or the curvature is not positive).
   * Needed for high bright voices: a 1000 Hz sawtooth has 22 samples per period, where the parabola alone is off
   * by up to ~10 cents.
   */
  refineLag(tau: number): number {
    const start = parabolicLag(this.cmnd, tau);
    const e = this.energy;
    let t = start;
    for (let it = 0; it < 4; it++) {
      const i = Math.max(0, Math.min(this.g.tauMax, Math.floor(t)));
      const slope = e[i + 1] - e[i];
      const [, r1, r2] = this.corrAt(t);
      const g1 = slope - 2 * r1;
      const g2 = -2 * r2;
      if (!(g2 > 0)) return start;
      const step = g1 / g2;
      t -= Math.max(-0.5, Math.min(0.5, step));
      if (Math.abs(step) < 1e-6) break;
    }
    return Math.abs(t - tau) <= 1 ? t : start;
  }

  /**
   * d' at the refined (sub-sample) minimum near integer `tau`: d(t) from corrAt and the interpolated energy,
   * normalized by the cumulative mean at the integer lag. Unlike the integer-lag d' it is not inflated when the
   * period falls between two lags (sharp dips of bright voices).
   */
  refinedDepth(tau: number): number {
    const t = this.refineLag(tau);
    const i = Math.max(0, Math.min(this.g.tauMax, Math.floor(t)));
    const e = this.energy[i] + (this.energy[i + 1] - this.energy[i]) * (t - i);
    const d = Math.max(0, this.energy[0] + e - 2 * this.corrAt(t)[0]);
    const c = this.cum[tau];
    return c > 0 ? Math.min(this.cmnd[tau], (d * tau) / c) : this.cmnd[tau];
  }
}

/** d(tau) by the definition (test reference). */
export function differenceDirect(frame: ArrayLike<number>, w: number, maxTau: number): Float64Array {
  const d = new Float64Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = frame[j] - frame[j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  return d;
}

/** First tau in [lo, hi] with dp[tau] < thr, moved down to its local minimum; -1 when none. */
export function firstDip(dp: ArrayLike<number>, lo: number, hi: number, thr: number): number {
  for (let tau = lo; tau <= hi; tau++) {
    if (dp[tau] < thr) {
      while (tau + 1 <= hi && dp[tau + 1] < dp[tau]) tau++;
      return tau;
    }
  }
  return -1;
}

/** Index of the minimum of dp over [lo, hi]. */
export function globalMin(dp: ArrayLike<number>, lo: number, hi: number): number {
  let best = lo;
  for (let tau = lo + 1; tau <= hi; tau++) if (dp[tau] < dp[best]) best = tau;
  return best;
}

/** Parabolic refinement of a minimum at integer `tau` (needs tau - 1 and tau + 1); returns the fractional lag. */
export function parabolicLag(dp: ArrayLike<number>, tau: number): number {
  const a = dp[tau - 1];
  const b = dp[tau];
  const c = dp[tau + 1];
  const den = a - 2 * b + c;
  if (!(den > 0)) return tau;
  const off = (0.5 * (a - c)) / den;
  return tau + Math.max(-1, Math.min(1, off));
}

export interface YinPick {
  /** Fractional lag (samples). */
  lag: number;
  /** d' at the integer minimum. */
  aperiodicity: number;
  /** A dip below the threshold was found. */
  below: boolean;
}

export function yinPick(
  dp: ArrayLike<number>,
  tauMin: number,
  tauMax: number,
  thr: number,
  oc: OctaveCheck = NO_OCTAVE_CHECK,
  refine: (tau: number) => number = (t) => parabolicLag(dp, t),
  depth?: (tau: number) => number,
): YinPick {
  let tau = firstDip(dp, tauMin, tauMax, thr);
  const below = tau >= 0;
  if (!below) tau = globalMin(dp, tauMin, tauMax);
  tau = octaveCheck(dp, tau, tauMax, oc, depth);
  return { lag: refine(tau), aperiodicity: dp[tau], below };
}

/**
 * Sub-octave check (our addition to YIN, not in the paper): a weak fundamental (low voices, "n" hum) makes the
 * first dip appear at HALF the period, i.e. one octave too high. Since d'(2 tau) / d'(tau) ~ d(2 tau) / d(tau)
 * (the cumulative mean roughly doubles), a signal that is really periodic at tau has a ratio near 1 or above;
 * when the dip near 2 tau (its minimum over 2 tau +- 2) is below `ratio` times d'(tau), and d'(tau) itself is at
 * least `minD` (tiny values are noise), the 2 tau dip is taken. Both dip depths are the parabola-interpolated
 * minima (estimateF0 passes YinFrameAnalyzer.refinedDepth; parabolicMin by default), not the integer-lag values. Values set by hand from two TUNING variants
 * (syn-h3-kirakira-s1, syn-h2-kirakira-s1): ratio at octave errors 0.03-0.24 (5-95 %), at correct frames 0.42-4.1.
 */
export interface OctaveCheck {
  /** 0 = off. */
  ratio: number;
  minD: number;
}
export const NO_OCTAVE_CHECK: OctaveCheck = { ratio: 0, minD: 0 };
/** The octave check of a config (cfg.f0.octaveCheckRatio / octaveCheckMinD; ratio 0 = off). */
export function octaveCheckOf(cfg: HumConfig = DEFAULT_HUM_CONFIG): OctaveCheck {
  return { ratio: cfg.f0.octaveCheckRatio, minD: cfg.f0.octaveCheckMinD };
}
/** The default config's octave check (0.35, 0.02). */
export const DEFAULT_OCTAVE_CHECK: OctaveCheck = octaveCheckOf(DEFAULT_HUM_CONFIG);

export function octaveCheck(
  dp: ArrayLike<number>,
  tau: number,
  tauMax: number,
  oc: OctaveCheck,
  depth: (tau: number) => number = (t) => parabolicMin(dp, t),
): number {
  if (!(oc.ratio > 0)) return tau;
  const d1 = depth(tau);
  if (d1 < oc.minD) return tau;
  const c = 2 * tau;
  if (c + 2 > tauMax) return tau;
  let m = c - 2;
  for (let t = c - 1; t <= c + 2; t++) if (dp[t] < dp[m]) m = t;
  return depth(m) < oc.ratio * d1 ? m : tau;
}

/**
 * Value of the parabola through dp[tau - 1 .. tau + 1] at its vertex (never above dp[tau]). Used by the octave
 * check so that a bright high voice whose period falls between two integer lags (a high d' at the integer lag,
 * a low one at the double lag that happens to be near an integer) is not mistaken for a weak fundamental.
 */
export function parabolicMin(dp: ArrayLike<number>, tau: number): number {
  const a = dp[tau - 1];
  const b = dp[tau];
  const c = dp[tau + 1];
  const den = a - 2 * b + c;
  if (!(den > 0)) return b;
  const v = b - ((a - c) * (a - c)) / (8 * den);
  return Math.max(0, Math.min(b, v));
}

/** YIN voiced probability: 1 at d' = 0, 0.5 at the threshold, 0 at twice the threshold. */
export function yinProb(aperiodicity: number, thr: number): number {
  return Math.max(0, Math.min(1, 1 - aperiodicity / (2 * thr)));
}

export interface F0Result {
  track: FrameF0Track;
  /** Raw voiced probability per frame (YIN mapping, or pYIN's total candidate probability). */
  prob: number[];
  /** Frame level in dB (mean square over the integration window), SILENCE_DB for silence. */
  levelDb: number[];
  noiseFloorDb: number;
  mode: 'yin' | 'pyin';
  /** Wall time of the f0 stage (resampling included), ms. */
  ms: number;
}

/** Resample to cfg.audio.sr when needed (returns the input when it already is at that rate). */
export function toAnalysisRate(y: Float32Array, sr: number, cfg: HumConfig = DEFAULT_HUM_CONFIG): Float32Array {
  return resampleSinc(y, sr, cfg.audio.sr);
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return SILENCE_DB;
  const s = values.slice().sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(s.length - 1, q * (s.length - 1)));
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}

/**
 * The voicing decision shared by both modes: `candidate[i]` (prob / Viterbi) AND the level gate, then short
 * gaps bridged. Returns 0 / 1 per frame and the noise floor used.
 */
export function voicingDecision(
  candidate: boolean[],
  hz: number[],
  levelDb: number[],
  cfg: HumConfig = DEFAULT_HUM_CONFIG,
): { voiced: number[]; noiseFloorDb: number } {
  const v = cfg.voicing;
  const floor = Math.max(SILENCE_DB, percentile(levelDb, v.noisePercentile));
  // A file with no quiet part (all sung) would gate everything: cap the gate at noiseMarginDb below the loud level.
  const loud = percentile(levelDb, 1 - v.noisePercentile);
  const gate = Math.min(floor + v.noiseMarginDb, loud - v.noiseMarginDb);
  const n = candidate.length;
  const voiced = new Array<number>(n);
  for (let i = 0; i < n; i++) voiced[i] = candidate[i] && hz[i] > 0 && levelDb[i] > SILENCE_DB && levelDb[i] >= gate ? 1 : 0;
  const hopSec = cfg.f0.hop / cfg.audio.sr;
  const maxGap = Math.floor((v.bridgeGapMs / 1000) / hopSec + 1e-9);
  if (maxGap > 0) {
    let i = 0;
    while (i < n) {
      if (voiced[i] === 1) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && voiced[j] === 0) j++;
      const len = j - i;
      if (i > 0 && j < n && len <= maxGap) {
        const a = hz[i - 1];
        const b = hz[j];
        const near = (f: number, ref: number) => f > 0 && Math.abs(1200 * Math.log2(f / ref)) <= 100;
        let ok = near(b, a);
        for (let k = i; k < j && ok; k++) ok = near(hz[k], a) || near(hz[k], b);
        if (ok) for (let k = i; k < j; k++) voiced[k] = 1;
      }
      i = j;
    }
  }
  return { voiced, noiseFloorDb: floor };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Frame f0 track of `y` (mono, sample rate `sr`). YIN by default, pYIN-style when cfg.f0.pyin.
 * Number of frames: floor(len / hop) + 1 at the analysis rate.
 */
export function estimateF0(y: Float32Array, sr: number, cfg: HumConfig = DEFAULT_HUM_CONFIG, oc: OctaveCheck = octaveCheckOf(cfg)): F0Result {
  const t0 = performance.now();
  const x = toAnalysisRate(y, sr, cfg);
  const g = yinGeometry(cfg);
  const an = new YinFrameAnalyzer(g);
  const n = Math.floor(x.length / g.hop) + 1;
  const levelDb = new Array<number>(n);
  const prob = new Array<number>(n);
  const hz = new Array<number>(n);
  const candidate = new Array<boolean>(n);
  const thr = cfg.f0.yinThreshold;
  const pyin = cfg.f0.pyin;
  const frames: PyinFrame[] = [];
  const refine = (tau: number) => an.refineLag(tau);
  const depth = (tau: number) => an.refinedDepth(tau);
  const weights = pyin ? pyinWeights(cfg.f0.pyinThresholds, cfg.f0.pyinBeta) : [];
  for (let i = 0; i < n; i++) {
    const ms = an.analyze(x, i * g.hop);
    const db = ms > 0 ? 10 * Math.log10(ms) : SILENCE_DB;
    levelDb[i] = Math.max(SILENCE_DB, db);
    const silent = db < SILENCE_DB;
    if (pyin) {
      frames.push(silent ? { hz: [], p: [] } : pyinFrameFrom(an.cmnd, g, cfg.f0.pyinThresholds, weights, oc, refine, depth));
      continue;
    }
    if (silent) {
      prob[i] = 0;
      hz[i] = 0;
      candidate[i] = false;
      continue;
    }
    const pk = yinPick(an.cmnd, g.tauMin, g.tauMax, thr, oc, refine, depth);
    prob[i] = pk.below ? yinProb(pk.aperiodicity, thr) : Math.min(0.49, yinProb(pk.aperiodicity, thr));
    hz[i] = g.sr / pk.lag;
    candidate[i] = prob[i] >= cfg.voicing.minVoicedProb;
  }
  if (pyin) {
    const dec = pyinDecode(frames, cfg);
    for (let i = 0; i < n; i++) {
      hz[i] = dec.hz[i];
      prob[i] = dec.prob[i];
      candidate[i] = dec.voiced[i];
    }
  }
  const { voiced, noiseFloorDb } = voicingDecision(candidate, hz, levelDb, cfg);
  const track: FrameF0Track = { t0: 0, hopSec: g.hop / g.sr, hz: hz.map(r4), voiced };
  return { track, prob, levelDb, noiseFloorDb, mode: pyin ? 'pyin' : 'yin', ms: performance.now() - t0 };
}

/**
 * pYIN candidates of one frame (paper section 2.1): for each threshold s_k (prior weight P(s_k)), the YIN pick
 * with that threshold; a pick that is not below s_k (global minimum) only gets P(s_k) * PYIN_PA. Picks with the
 * same integer lag are merged.
 */
export function pyinFrameFrom(
  dp: ArrayLike<number>,
  g: YinGeometry,
  thresholds: readonly number[],
  weights: readonly number[],
  oc: OctaveCheck = NO_OCTAVE_CHECK,
  refine: (tau: number) => number = (t) => parabolicLag(dp, t),
  depth?: (tau: number) => number,
): PyinFrame {
  const byTau = new Map<number, number>();
  let gmin = -1;
  for (let k = 0; k < thresholds.length; k++) {
    let tau = firstDip(dp, g.tauMin, g.tauMax, thresholds[k]);
    let wk = weights[k];
    if (tau < 0) {
      if (gmin < 0) gmin = globalMin(dp, g.tauMin, g.tauMax);
      tau = gmin;
      wk *= PYIN_PA;
    }
    tau = octaveCheck(dp, tau, g.tauMax, oc, depth);
    byTau.set(tau, (byTau.get(tau) ?? 0) + wk);
  }
  const hz: number[] = [];
  const p: number[] = [];
  for (const [tau, w] of byTau) {
    hz.push(g.sr / refine(tau));
    p.push(w);
  }
  return { hz, p };
}

/** pYIN paper: probability given to the global minimum when no dip is below a threshold. */
export const PYIN_PA = 0.01;
