/**
 * Spike 4 T4: the pYIN idea (Mauch & Dixon 2014, "pYIN: a fundamental frequency estimator using probabilistic
 * threshold distributions"), written from the paper; no third-party pitch code. Switch cfg.f0.pyin.
 *
 * Stage 1 (per frame, ts/hum/f0.ts pyinFrameFrom): YIN with every threshold s_k of cfg.f0.pyinThresholds; the pick of
 *   threshold k gets the prior mass P(s_k) of a Beta(PYIN_BETA_A, PYIN_BETA_B) distribution (paper default: mean 0.1,
 *   i.e. Beta(2, 18)) over the bin around s_k (edges at the midpoints between thresholds, 0 and 1 at the ends); a pick
 *   that is not below its threshold (global minimum) gets P(s_k) * PYIN_PA (0.01). Candidates = distinct lags with the
 *   summed mass; their total is the voiced probability Pv of the frame.
 * Stage 2 (pyinDecode): HMM over 2 * B states, B = pitch bins from fminHz to fmaxHz at binsPerSemitone (5 = 20 cents),
 *   one voiced and one unvoiced state per bin (paper section 2.2). Emissions: voiced bin b = mass of the candidates
 *   nearest to b; unvoiced bin = (1 - Pv) / B. Transitions: triangular over |delta bin| <= maxJumpSemitones *
 *   binsPerSemitone (rows normalized), times the voicing switch: voiced -> unvoiced voicedToUnvoiced, unvoiced ->
 *   voiced unvoicedToVoiced. Uniform start. Viterbi in the log domain.
 * Output per frame: the decoded state's voicing, and as Hz the candidate whose bin is nearest to the decoded bin
 *   (so the pitch is not quantized to 20 cents), the bin centre when the frame has no candidate.
 */
import type { HumConfig } from './config';

export const PYIN_BETA_A = 2;
export const PYIN_BETA_B = 18;

/** One frame's candidates: Hz and probability mass (same length). */
export interface PyinFrame {
  hz: number[];
  p: number[];
}

/** Beta(a, b) CDF by Simpson integration of the density (a, b >= 1). */
export function betaCdf(x: number, a = PYIN_BETA_A, b = PYIN_BETA_B): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const n = 2000;
  const h = x / n;
  const pdf = (t: number) => Math.pow(t, a - 1) * Math.pow(1 - t, b - 1);
  let s = pdf(0) + pdf(x);
  for (let i = 1; i < n; i++) s += (i % 2 === 1 ? 4 : 2) * pdf(i * h);
  const integral = (s * h) / 3;
  return integral / betaFn(a, b);
}

function betaFn(a: number, b: number): number {
  // B(a, b) for the integer / half-integer parameters used here, via log-gamma (Lanczos).
  return Math.exp(logGamma(a) + logGamma(b) - logGamma(a + b));
}

function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

/** Prior mass per threshold (ascending thresholds): Beta mass between the midpoints; sums to 1. */
export function pyinWeights(
  thresholds: readonly number[],
  beta: readonly number[] = [PYIN_BETA_A, PYIN_BETA_B],
): number[] {
  if (beta.length !== 2 || !(beta[0] >= 1) || !(beta[1] >= 1))
    throw new Error('pyinBeta must be [a, b] with a, b >= 1');
  for (let i = 1; i < thresholds.length; i++)
    if (!(thresholds[i] > thresholds[i - 1]))
      throw new Error('pyinThresholds must be ascending');
  const edges = [0];
  for (let i = 1; i < thresholds.length; i++)
    edges.push((thresholds[i - 1] + thresholds[i]) / 2);
  edges.push(1);
  const out: number[] = [];
  for (let i = 0; i < thresholds.length; i++)
    out.push(
      betaCdf(edges[i + 1], beta[0], beta[1]) -
        betaCdf(edges[i], beta[0], beta[1]),
    );
  return out;
}

export interface PitchBins {
  fmin: number;
  bps: number;
  count: number;
}

export function pitchBins(cfg: HumConfig): PitchBins {
  const bps = cfg.f0.binsPerSemitone;
  const count =
    Math.floor(12 * Math.log2(cfg.f0.fmaxHz / cfg.f0.fminHz) * bps + 1e-9) + 1;
  return { fmin: cfg.f0.fminHz, bps, count };
}

/** Fractional bin of a frequency. */
export function binPos(b: PitchBins, hz: number): number {
  return 12 * Math.log2(hz / b.fmin) * b.bps;
}

export function binHz(b: PitchBins, bin: number): number {
  return b.fmin * Math.pow(2, bin / (12 * b.bps));
}

export interface PyinDecoded {
  hz: number[];
  prob: number[];
  voiced: boolean[];
}

const LOG_EPS = Math.log(1e-30);

/** Viterbi over the pitch HMM (see the file comment). Frames with no candidates (silence) have Pv = 0. */
export function pyinDecode(
  frames: readonly PyinFrame[],
  cfg: HumConfig,
): PyinDecoded {
  const bins = pitchBins(cfg);
  const B = bins.count;
  const S = 2 * B;
  const J = Math.max(0, Math.round(cfg.f0.maxJumpSemitones * bins.bps));
  const n = frames.length;
  // triangular transition weights, normalized per source row (edges have fewer targets)
  const tri = new Float64Array(J + 1);
  for (let d = 0; d <= J; d++) tri[d] = J + 1 - d;
  const logTri = Array.from(tri, (v) => Math.log(v));
  const logNorm = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let j = Math.max(0, i - J); j <= Math.min(B - 1, i + J); j++)
      s += tri[Math.abs(i - j)];
    logNorm[i] = Math.log(s);
  }
  const vu = cfg.f0.voicedToUnvoiced;
  const uv = cfg.f0.unvoicedToVoiced;
  const lVV = Math.log(1 - vu);
  const lVU = Math.log(vu);
  const lUV = Math.log(uv);
  const lUU = Math.log(1 - uv);

  const obs = new Float64Array(S);
  const prev = new Float64Array(S);
  const cur = new Float64Array(S);
  const back = new Uint16Array(n * S);
  const pv = new Array<number>(n);
  const candBin: number[][] = frames.map((f) =>
    f.hz.map((h) => Math.max(0, Math.min(B - 1, Math.round(binPos(bins, h))))),
  );

  const fillObs = (t: number) => {
    const f = frames[t];
    let tot = 0;
    for (let k = 0; k < f.p.length; k++) tot += f.p[k];
    tot = Math.min(1, tot);
    pv[t] = tot;
    const vObs = new Float64Array(B);
    for (let k = 0; k < f.p.length; k++) vObs[candBin[t][k]] += f.p[k];
    const u = (1 - tot) / B;
    const lu = u > 0 ? Math.log(u) : LOG_EPS;
    for (let b = 0; b < B; b++) {
      obs[b] = vObs[b] > 0 ? Math.log(vObs[b]) : LOG_EPS;
      obs[B + b] = lu;
    }
  };

  if (n === 0) return { hz: [], prob: [], voiced: [] };
  fillObs(0);
  const l0 = -Math.log(S);
  for (let s = 0; s < S; s++) prev[s] = l0 + obs[s];
  for (let t = 1; t < n; t++) {
    fillObs(t);
    const row = t * S;
    for (let j = 0; j < B; j++) {
      let bestV = -Infinity;
      let argV = 0;
      let bestU = -Infinity;
      let argU = 0;
      const lo = Math.max(0, j - J);
      const hi = Math.min(B - 1, j + J);
      for (let i = lo; i <= hi; i++) {
        const lt = logTri[Math.abs(i - j)] - logNorm[i];
        const fromV = prev[i] + lt;
        const fromU = prev[B + i] + lt;
        // into voiced j
        const a = fromV + lVV;
        if (a > bestV) {
          bestV = a;
          argV = i;
        }
        const b2 = fromU + lUV;
        if (b2 > bestV) {
          bestV = b2;
          argV = B + i;
        }
        // into unvoiced j
        const c = fromV + lVU;
        if (c > bestU) {
          bestU = c;
          argU = i;
        }
        const d = fromU + lUU;
        if (d > bestU) {
          bestU = d;
          argU = B + i;
        }
      }
      cur[j] = bestV + obs[j];
      back[row + j] = argV;
      cur[B + j] = bestU + obs[B + j];
      back[row + B + j] = argU;
    }
    // renormalize to avoid drifting to -Infinity over long files
    let m = -Infinity;
    for (let s = 0; s < S; s++) if (cur[s] > m) m = cur[s];
    for (let s = 0; s < S; s++) prev[s] = cur[s] - m;
  }
  let state = 0;
  for (let s = 1; s < S; s++) if (prev[s] > prev[state]) state = s;
  const path = new Array<number>(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = state;
    if (t > 0) state = back[t * S + state];
  }
  const hz = new Array<number>(n);
  const voiced = new Array<boolean>(n);
  for (let t = 0; t < n; t++) {
    const s = path[t];
    const b = s % B;
    const f = frames[t];
    voiced[t] = s < B;
    if (f.hz.length === 0) {
      hz[t] = 0;
      voiced[t] = false;
      continue;
    }
    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < f.hz.length; k++) {
      const d = Math.abs(binPos(bins, f.hz[k]) - b);
      if (d < bestD || (d === bestD && f.p[k] > f.p[bestK])) {
        bestD = d;
        bestK = k;
      }
    }
    hz[t] = bestD <= Math.max(1, J) ? f.hz[bestK] : binHz(bins, b);
  }
  return { hz, prob: pv, voiced };
}
