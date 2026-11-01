/**
 * Section boundaries and labels (port of py/dsp/sections.py, default path; rule-based, no learned
 * model). See the Python module docstring for the algorithm.
 *
 * Inputs in the default config (hash adec583eb3c6), all from the analyzer's 1st pass:
 *   - beat chroma and beat bass chroma (12 x nb, row-major; `beat_chroma` / `beat_bass`),
 *   - the final beat times (s, float64; `beat_times`) and the audio duration (len(y) / sr),
 *   - the downbeat phase and beats per bar (`downbeat_phase` / `downbeat_beats_per_bar`),
 *   - y (per-beat RMS loudness) and y_perc (percussive cues, percussive_weight 0.5).
 * Phase > 0 analyzes the beats before the phase as a partial pickup bar (bar 0 of an extended grid)
 * and folds it into the first section afterwards (`unpickup`).
 *
 * numpy rules kept: np.round / Python round ties to even, pairwise summation for contiguous 1-D
 * means and sums, sequential sums for axis-0 means, argmax = first index, np.median = mean of the
 * two middle values, np.hanning symmetric. Dot products (BLAS in numpy) are plain sequential sums.
 */
import { hanningSym, median } from './beats';
import { pairwiseSum, roundHalfEven } from '../core/npmath';
import { lastBeatEnd } from './chroma';
import { RealFft } from '../core/fft';

export const LOUDNESS_SCALE_DB = 3.0;
export const SILENCE_DB = 30.0;
export const BASS_WEIGHT = 0.5;
export const STRIPE_ON = 0.5;
export const STRIPE_FULL = 0.8;
export const EDGE_FACTOR = 1.5;
export const LOUDNESS_PIN_DB = 3.0;
export const DIVISOR_COVERAGE = 0.8;
export const PERC_BANDS_HZ = [
  0.0, 200.0, 500.0, 1200.0, 3000.0, 6000.0, 11025.0,
] as const;
export const PERC_FILL_BANDS = 4;
export const PERC_HEAD_HZ = 5000.0;
export const PERC_HEAD_WINDOW = [-0.03, 0.1] as const;
export const PERC_SCALE_DB = 6.0;
export const PERC_TOL_DB = 2.0;
export const PERC_Z_TOL = 3.0;
export const PERC_Z_SCALE = 3.0;
export const PERC_NFFT = 1024;
const NBAND = PERC_BANDS_HZ.length - 1;

export interface SectionsConfig {
  enabled: boolean;
  kernel_bars: number;
  peak_threshold: number;
  min_section_bars: number;
  snap_bars: number;
  same_label_similarity: number;
  chroma_weight: number;
  loudness_weight: number;
  min_novelty: number;
  repetition_weight: number;
  snap_min_ratio: number;
  noise_factor: number;
  percussive_weight: number;
}

export const DEFAULT_SECTIONS_CONFIG: SectionsConfig = {
  enabled: true,
  kernel_bars: 4,
  peak_threshold: 0.3,
  min_section_bars: 4,
  snap_bars: 4,
  same_label_similarity: 0.85,
  chroma_weight: 1.0,
  loudness_weight: 0.5,
  min_novelty: 0.25,
  repetition_weight: 0.5,
  snap_min_ratio: 0.8,
  noise_factor: 2.5,
  percussive_weight: 0.5,
};

export interface Section {
  startBar: number;
  /** Exclusive. */
  endBar: number;
  label: string;
}

/** A dense row-major matrix. */
interface Mat {
  rows: number;
  cols: number;
  data: Float64Array;
}

const mat = (rows: number, cols: number): Mat => ({
  rows,
  cols,
  data: new Float64Array(rows * cols),
});

// ---------------------------------------------------------------- entry point

export interface SectionInputs {
  /** Beat chroma, 12 x nBeats row-major. */
  chroma: ArrayLike<number>;
  /** Beat bass chroma, 12 x nBeats row-major (null = no bass). */
  bass: ArrayLike<number> | null;
  nBeats: number;
  /** Final beat times (s). */
  beatTimes: ArrayLike<number>;
  phase: number;
  beatsPerBar: number;
  /** Mono signal and its HPSS percussive part (null = no audio features: no loudness, no drums). */
  y: ArrayLike<number> | null;
  yPerc: ArrayLike<number> | null;
  sr: number;
  /** len(y) / sr. */
  duration: number;
}

/** find_sections: sections in bars counted from the phase (end bar exclusive). */
export function findSections(
  inp: SectionInputs,
  sc: SectionsConfig = DEFAULT_SECTIONS_CONFIG,
): Section[] {
  if (!sc.enabled) return [];
  const { phase, beatsPerBar: bpb, nBeats: nb } = inp;
  const pickup = phase > 0 && nb > 0;
  const times = inp.beatTimes;
  let loud: Float64Array | null = null;
  if (inp.y !== null && times.length > 0)
    loud = beatLoudnessDb(inp.y, inp.sr, times, inp.duration);
  const {
    chroma: bc,
    bass: bb,
    loudness: bl,
  } = barFeatures(inp.chroma, inp.bass, nb, loud, phase, bpb, pickup);
  let perc: Float64Array | null = null;
  if (sc.percussive_weight > 0 && inp.yPerc !== null && times.length > 0) {
    const { bands, head } = barPercussive(
      inp.yPerc,
      inp.sr,
      times,
      inp.duration,
      phase,
      bpb,
      pickup,
    );
    perc = percussiveNovelty(bands, head, sc.kernel_bars);
  }
  const secs = segmentBars(bc, bb, bl, sc, perc, pickup);
  return pickup ? unpickup(secs) : secs;
}

/** Extended grid (bar 0 = partial pickup bar) -> bars from the phase; the pickup folds into the first section. */
export function unpickup(secs: readonly Section[]): Section[] {
  const out: Section[] = [];
  for (const s of secs) {
    const a = Math.max(0, s.startBar - 1);
    const b = s.endBar - 1;
    if (b <= a) continue;
    out.push({ startBar: out.length ? a : 0, endBar: b, label: s.label });
  }
  return out;
}

/** RMS level in dB of each beat span [times[i], times[i+1]) (the last ends at last_beat_end). */
export function beatLoudnessDb(
  y: ArrayLike<number>,
  sr: number,
  times: ArrayLike<number>,
  duration: number,
): Float64Array {
  const n = times.length;
  const edges = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) edges[i] = times[i];
  edges[n] = n ? lastBeatEnd(times, duration) : 0.0;
  const idx = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++)
    idx[i] = Math.min(Math.max(roundHalfEven(edges[i] * sr), 0), y.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const len = idx[i + 1] - idx[i];
    let p = 0.0;
    if (len > 0) {
      const sq = new Float64Array(len);
      for (let j = 0; j < len; j++) {
        const v = y[idx[i] + j];
        sq[j] = v * v;
      }
      p = pairwiseSum(sq) / len;
    }
    out[i] = 10.0 * Math.log10(p + 1e-12);
  }
  return out;
}

/** Beat index ranges [lo, hi) of the bars; with pickupBar and phase > 0 the beats [0, phase) come first. */
export function barSpans(
  nBeats: number,
  phase: number,
  beatsPerBar: number,
  pickupBar = false,
): [number, number][] {
  const bpb = Math.max(1, Math.trunc(beatsPerBar));
  const ph = Math.max(0, Math.trunc(phase));
  const n = Math.max(0, Math.ceil((nBeats - ph) / bpb));
  const spans: [number, number][] = [];
  for (let b = 0; b < n; b++)
    spans.push([ph + b * bpb, Math.min(ph + (b + 1) * bpb, nBeats)]);
  if (pickupBar && 0 < ph && ph <= nBeats) spans.unshift([0, ph]);
  return spans;
}

/** Mean of a contiguous run, numpy style (pairwise sum / n). */
function meanPairwise(a: ArrayLike<number>, start: number, n: number): number {
  return pairwiseSum(a, start, n) / n;
}

export interface BarFeatures {
  /** n x 12 */
  chroma: Mat;
  bass: Mat | null;
  loudness: Float64Array | null;
}

/** Per-beat 12 x nb arrays -> per-bar (n, 12) means; loudness as the power mean in dB. */
export function barFeatures(
  chroma: ArrayLike<number>,
  bass: ArrayLike<number> | null,
  nBeats: number,
  beatLoud: ArrayLike<number> | null,
  phase: number,
  beatsPerBar: number,
  pickupBar = false,
): BarFeatures {
  const spans = barSpans(nBeats, phase, beatsPerBar, pickupBar);
  const n = spans.length;
  const bc = mat(n, 12);
  const bb = bass !== null ? mat(n, 12) : null;
  const bl = beatLoud !== null ? new Float64Array(n) : null;
  spans.forEach(([lo, hi], b) => {
    for (let r = 0; r < 12; r++) {
      bc.data[b * 12 + r] = meanPairwise(chroma, r * nBeats + lo, hi - lo);
      if (bb && bass)
        bb.data[b * 12 + r] = meanPairwise(bass, r * nBeats + lo, hi - lo);
    }
    if (bl && beatLoud) {
      const pw = new Float64Array(hi - lo);
      for (let j = lo; j < hi; j++) pw[j - lo] = 10.0 ** (beatLoud[j] / 10.0);
      bl[b] = 10.0 * Math.log10(meanPairwise(pw, 0, pw.length) + 1e-12);
    }
  });
  return { chroma: bc, bass: bb, loudness: bl };
}

// ---------------------------------------------------------------- percussive cues (T7)

export interface BarPercussive {
  /** n x NBAND dB */
  bands: Mat;
  /** n, NaN = none */
  head: Float64Array;
}

/** Per bar: dB of the percussive power in PERC_BANDS_HZ bands, and the peak dB of >= PERC_HEAD_HZ at the downbeat. */
export function barPercussive(
  yPerc: ArrayLike<number>,
  sr: number,
  times: ArrayLike<number>,
  duration: number,
  phase: number,
  beatsPerBar: number,
  pickupBar = false,
): BarPercussive {
  const nb = times.length;
  const edgesT = new Float64Array(nb + 1);
  for (let i = 0; i < nb; i++) edgesT[i] = times[i];
  edgesT[nb] = nb ? lastBeatEnd(times, duration) : 0.0;
  const hop = PERC_NFFT / 4;
  let nFr = 0;
  let spec = new Float64Array(0); // nFr x NBAND
  let headF = new Float64Array(0);
  let centers = new Float64Array(0);
  if (yPerc.length > 0) {
    const len = Math.max(yPerc.length, PERC_NFFT);
    nFr = 1 + Math.floor((len - PERC_NFFT) / hop);
    const win = hanningSym(PERC_NFFT);
    const fft = new RealFft(PERC_NFFT);
    const bins = fft.bins;
    // np.fft.rfftfreq(n, d): k * (1 / (n * d))
    const val = 1.0 / (PERC_NFFT * (1.0 / sr));
    const bandOf = new Int8Array(bins).fill(-1);
    const isHead = new Uint8Array(bins);
    for (let k = 0; k < bins; k++) {
      const f = k * val;
      for (let j = 0; j < NBAND; j++)
        if (f >= PERC_BANDS_HZ[j] && f < PERC_BANDS_HZ[j + 1]) bandOf[k] = j;
      isHead[k] = f >= PERC_HEAD_HZ ? 1 : 0;
    }
    // bins of each band / of the head band, in ascending order (numpy's boolean-mask copy)
    const bandBins: number[][] = Array.from({ length: NBAND }, () => []);
    const headBins: number[] = [];
    for (let k = 0; k < bins; k++) {
      if (bandOf[k] >= 0) bandBins[bandOf[k]].push(k);
      if (isHead[k]) headBins.push(k);
    }
    spec = new Float64Array(nFr * NBAND);
    headF = new Float64Array(nFr);
    centers = new Float64Array(nFr);
    const frame = new Float64Array(PERC_NFFT);
    const re = new Float64Array(bins);
    const im = new Float64Array(bins);
    const pw = new Float64Array(bins);
    const tmp = new Float64Array(bins);
    for (let t = 0; t < nFr; t++) {
      const off = t * hop;
      for (let i = 0; i < PERC_NFFT; i++) {
        const s = off + i < yPerc.length ? yPerc[off + i] : 0.0;
        frame[i] = s * win[i];
      }
      fft.rfft(frame, re, im);
      for (let k = 0; k < bins; k++) {
        const a = Math.hypot(re[k], im[k]);
        pw[k] = a * a;
      }
      for (let j = 0; j < NBAND; j++) {
        const bj = bandBins[j];
        for (let q = 0; q < bj.length; q++) tmp[q] = pw[bj[q]];
        spec[t * NBAND + j] = pairwiseSum(tmp, 0, bj.length);
      }
      for (let q = 0; q < headBins.length; q++) tmp[q] = pw[headBins[q]];
      headF[t] =
        10.0 * Math.log10(pairwiseSum(tmp, 0, headBins.length) + 1e-12);
      centers[t] = (t * hop + PERC_NFFT / 2) / sr;
    }
  }

  const spans = barSpans(nb, phase, beatsPerBar, pickupBar);
  const bands = mat(spans.length, NBAND);
  const head = new Float64Array(spans.length).fill(NaN);
  spans.forEach(([lo, hi], b) => {
    // spec[m].mean(axis=0): sequential over the selected frames
    const acc = new Float64Array(NBAND);
    let cnt = 0;
    for (let t = 0; t < nFr; t++) {
      if (centers[t] >= edgesT[lo] && centers[t] < edgesT[hi]) {
        for (let j = 0; j < NBAND; j++) acc[j] += spec[t * NBAND + j];
        cnt++;
      }
    }
    for (let j = 0; j < NBAND; j++)
      bands.data[b * NBAND + j] =
        10.0 * Math.log10((cnt ? acc[j] / cnt : 0.0) + 1e-12);
    if (pickupBar && b === 0 && phase > 0) return;
    const t0 = edgesT[lo];
    let mx = -Infinity;
    let any = false;
    for (let t = 0; t < nFr; t++) {
      if (
        centers[t] >= t0 + PERC_HEAD_WINDOW[0] &&
        centers[t] < t0 + PERC_HEAD_WINDOW[1]
      ) {
        any = true;
        if (headF[t] > mx) mx = headF[t];
      }
    }
    if (any) head[b] = mx;
  });
  return { bands, head };
}

/** Column medians of rows [r0, r1) of m, over the rows where `use` is set (all when null). */
function colMedians(
  m: Mat,
  r0: number,
  r1: number,
  use: Uint8Array | null = null,
): Float64Array {
  const out = new Float64Array(m.cols);
  const col: number[] = [];
  for (let c = 0; c < m.cols; c++) {
    col.length = 0;
    for (let r = r0; r < r1; r++)
      if (!use || use[r]) col.push(m.data[r * m.cols + c]);
    out[c] = median(col);
  }
  return out;
}

function cue(db: number): number {
  return 1.0 - Math.exp(-Math.max(0.0, db - PERC_TOL_DB) / PERC_SCALE_DB);
}

/** Boundary evidence per bar (0..1): max of a cymbal attack at b, a fill at b-1, a drum block change. */
export function percussiveNovelty(
  bands: Mat,
  head: ArrayLike<number>,
  kernelBars: number,
): Float64Array {
  const n = bands.rows;
  const nc = bands.cols;
  const out = new Float64Array(n);
  if (n < 2) return out;
  const level = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let s = 0.0;
    for (let j = 0; j < nc; j++) s += 10.0 ** (bands.data[b * nc + j] / 10.0);
    level[b] = 10.0 * Math.log10(s + 1e-12);
  }
  let lmax = -Infinity;
  for (const v of level) if (v > lmax) lmax = v;
  const active = new Uint8Array(n);
  let anyActive = false;
  for (let b = 0; b < n; b++) {
    active[b] = level[b] >= lmax - SILENCE_DB ? 1 : 0;
    if (active[b]) anyActive = true;
  }
  if (!anyActive) return out;
  const ref = colMedians(bands, 0, n, active);
  const hv = new Uint8Array(n);
  let nhv = 0;
  for (let b = 0; b < n; b++) {
    hv[b] = active[b] && !Number.isNaN(head[b]) ? 1 : 0;
    nhv += hv[b];
  }
  let hMed = 0.0;
  let hSd = 0.0;
  if (nhv >= 3) {
    const hs: number[] = [];
    for (let b = 0; b < n; b++) if (hv[b]) hs.push(head[b]);
    hMed = median(hs);
    hSd = Math.max(1.4826 * median(hs.map((v) => Math.abs(v - hMed))), 0.1);
  } else hv.fill(0);
  const dev = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let s = 0.0;
    for (let j = 0; j < PERC_FILL_BANDS; j++)
      s += Math.abs(bands.data[b * nc + j] - ref[j]);
    dev[b] = s / PERC_FILL_BANDS;
  }
  const k = Math.max(2, Math.trunc(kernelBars));
  for (let b = 1; b < n; b++) {
    let accent = 0.0;
    if (hv[b]) {
      const z = (head[b] - hMed) / hSd;
      accent = 1.0 - Math.exp(-Math.max(0.0, z - PERC_Z_TOL) / PERC_Z_SCALE);
    }
    const fill = active[b - 1] ? cue(dev[b - 1]) : 0.0;
    const kk = Math.min(k, b, n - b);
    const before = colMedians(bands, b - kk, b);
    const after = colMedians(bands, b, b + kk);
    let s = 0.0;
    for (let j = 0; j < nc; j++) s += Math.abs(before[j] - after[j]);
    const block = cue(s / nc);
    out[b] = Math.max(accent, fill, block);
  }
  return out;
}

// ---------------------------------------------------------------- algorithm

/** segment_bars: the whole algorithm on per-bar arrays. barPerc = percussive novelty per bar. */
export function segmentBars(
  barChroma: Mat,
  barBass: Mat | null,
  barLoud: ArrayLike<number> | null,
  sc: SectionsConfig,
  barPerc: ArrayLike<number> | null = null,
  pickup = false,
): Section[] {
  const nAll = barChroma.rows;
  if (nAll === 0) return [];
  const [lo, hi] = activeRange(barChroma, barLoud);
  const n = hi - lo;
  const minLen = Math.max(1, sc.min_section_bars);
  if (n < 2 * minLen) return [{ startBar: 0, endBar: nAll, label: 'A' }];

  const x = chromaFeatures(
    sliceRows(barChroma, lo, hi),
    barBass === null ? null : sliceRows(barBass, lo, hi),
  );
  const s = selfSimilarity(x);
  let loud: Float64Array | null = null;
  if (barLoud !== null) {
    loud = new Float64Array(n);
    for (let i = 0; i < n; i++) loud[i] = barLoud[lo + i];
  }
  const k = Math.max(2, sc.kernel_bars);
  let homog = blockNovelty(x, loud, k, sc.chroma_weight, sc.loudness_weight);
  const rep = repetitionNovelty(s, n, minLen);
  const step =
    loud === null || sc.loudness_weight <= 0 ? null : loudnessStep(loud, 2);
  const origins = pickup && lo === 0 ? [1, 0] : [0];
  const valid: [number, number] = [k, n - k + 1];
  let origin: number | null = null;
  if (origins.length > 1) origin = gridOriginOf(homog, rep, sc, valid, origins);
  if (barPerc !== null && sc.percussive_weight > 0) {
    const h2 = new Float64Array(n);
    for (let i = 0; i < n; i++)
      h2[i] = homog[i] + sc.percussive_weight * barPerc[lo + i];
    homog = h2;
  }
  const bounds = pickBoundaries(
    homog,
    rep,
    step,
    sc,
    minLen,
    valid,
    origin === null ? origins : [origin],
  );

  const edges = [0, ...bounds.map((b) => b + lo), nAll];
  const act: [number, number][] = [];
  for (let j = 0; j + 1 < edges.length; j++)
    act.push([Math.max(edges[j], lo) - lo, Math.min(edges[j + 1], hi) - lo]);
  const labels = labelSections(s, n, act, sc.same_label_similarity);
  return labels.map((label, j) => ({
    startBar: edges[j],
    endBar: edges[j + 1],
    label,
  }));
}

function sliceRows(m: Mat, r0: number, r1: number): Mat {
  return {
    rows: r1 - r0,
    cols: m.cols,
    data: m.data.slice(r0 * m.cols, r1 * m.cols),
  };
}

/** [lo, hi) of bars between leading and trailing silence (the whole range if none is active). */
export function activeRange(
  barChroma: Mat,
  barLoud: ArrayLike<number> | null,
): [number, number] {
  const n = barChroma.rows;
  const energy = new Float64Array(n);
  let emax = -Infinity;
  for (let b = 0; b < n; b++) {
    energy[b] = pairwiseSum(barChroma.data, b * barChroma.cols, barChroma.cols);
    if (energy[b] > emax) emax = energy[b];
  }
  const thr = 1e-6 * Math.max(emax, 1e-12);
  let lmax = -Infinity;
  if (barLoud !== null)
    for (let b = 0; b < n; b++) if (barLoud[b] > lmax) lmax = barLoud[b];
  let first = -1;
  let last = -1;
  for (let b = 0; b < n; b++) {
    let a = energy[b] > thr;
    if (barLoud !== null) a = a && barLoud[b] >= lmax - SILENCE_DB;
    if (a) {
      if (first < 0) first = b;
      last = b;
    }
  }
  if (first < 0) return [0, n];
  return [first, last + 1];
}

/** Row-normalize in place (rows with norm <= 1e-12 become zero). */
function normRows(m: Mat): Mat {
  const out = mat(m.rows, m.cols);
  const sq = new Float64Array(m.cols);
  for (let r = 0; r < m.rows; r++) {
    const o = r * m.cols;
    for (let c = 0; c < m.cols; c++) sq[c] = m.data[o + c] * m.data[o + c];
    const d = Math.sqrt(pairwiseSum(sq));
    if (d > 1e-12)
      for (let c = 0; c < m.cols; c++) out.data[o + c] = m.data[o + c] / d;
  }
  return out;
}

/** Row-normalized (chroma, BASS_WEIGHT * bass) per bar. */
export function chromaFeatures(barChroma: Mat, barBass: Mat | null): Mat {
  const x = normRows(barChroma);
  if (barBass === null) return x;
  const b = normRows(barBass);
  const h = mat(x.rows, x.cols + b.cols);
  for (let r = 0; r < x.rows; r++) {
    for (let c = 0; c < x.cols; c++)
      h.data[r * h.cols + c] = x.data[r * x.cols + c];
    for (let c = 0; c < b.cols; c++)
      h.data[r * h.cols + x.cols + c] = BASS_WEIGHT * b.data[r * b.cols + c];
  }
  return normRows(h);
}

function dot(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  n: number,
): number {
  let s = 0.0;
  for (let i = 0; i < n; i++) s += a[ao + i] * b[bo + i];
  return s;
}

/** clip(x @ x.T, 0, 1), n x n row-major. */
function selfSimilarity(x: Mat): Float64Array {
  const n = x.rows;
  const s = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      s[i * n + j] = Math.min(
        Math.max(dot(x.data, i * x.cols, x.data, j * x.cols, x.cols), 0.0),
        1.0,
      );
  return s;
}

/** Checkerboard on block-averaged features at k and 2k, the minimum taken. */
export function blockNovelty(
  x: Mat,
  loud: ArrayLike<number> | null,
  kernelBars: number,
  chromaWeight: number,
  loudnessWeight: number,
): Float64Array {
  const n = x.rows;
  const d = x.cols;
  const wc = Math.max(0.0, chromaWeight);
  const wl = loud !== null ? Math.max(0.0, loudnessWeight) : 0.0;
  if (wc + wl === 0) return new Float64Array(n);
  const k1 = Math.max(2, Math.trunc(kernelBars));
  const out = new Float64Array(n).fill(Infinity);
  const a = new Float64Array(d);
  const b = new Float64Array(d);
  for (const kMax of [k1, 2 * k1]) {
    const nov = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const k = Math.min(kMax, i, n - i);
      if (k < k1) continue;
      let v = 0.0;
      if (wc > 0) {
        // x[i-k:i].mean(axis=0): rows added in order
        a.fill(0);
        b.fill(0);
        for (let r = i - k; r < i; r++)
          for (let c = 0; c < d; c++) a[c] += x.data[r * d + c];
        for (let r = i; r < i + k; r++)
          for (let c = 0; c < d; c++) b[c] += x.data[r * d + c];
        for (let c = 0; c < d; c++) {
          a[c] /= k;
          b[c] /= k;
        }
        const den =
          Math.sqrt(dot(a, 0, a, 0, d)) * Math.sqrt(dot(b, 0, b, 0, d));
        v += wc * (1.0 - (den > 1e-12 ? dot(a, 0, b, 0, d) / den : 1.0));
      }
      if (wl > 0 && loud !== null) {
        const dd = Math.abs(
          meanPairwise(loud, i - k, k) - meanPairwise(loud, i, k),
        );
        v += wl * (1.0 - Math.exp(-dd / LOUDNESS_SCALE_DB));
      }
      nov[i] = v;
    }
    for (let i = 0; i < n; i++) out[i] = Math.min(out[i], nov[i]);
  }
  return out;
}

/** 0..1 'bar i repeats bar j' map: contrast-normalized, smoothed along diagonals (n x n). */
export function stripeStrength(s: Float64Array, n: number): Float64Array {
  const off: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (i !== j) off.push(s[i * n + j]);
  const base = off.length ? median(off) : 0.0;
  const scale = Math.max(1.0 - base, 1e-6);
  const q = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++)
    q[i] = Math.min(Math.max((s[i] - base) / scale, 0.0), 1.0);
  const acc = q.slice();
  const cnt = new Float64Array(n * n).fill(1);
  for (let i = 1; i < n; i++)
    for (let j = 1; j < n; j++) {
      acc[i * n + j] += q[(i - 1) * n + j - 1];
      cnt[i * n + j] += 1;
    }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < n - 1; j++) {
      acc[i * n + j] += q[(i + 1) * n + j + 1];
      cnt[i * n + j] += 1;
    }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++)
    out[i] = Math.min(
      Math.max((acc[i] / cnt[i] - STRIPE_ON) / (STRIPE_FULL - STRIPE_ON), 0.0),
      1.0,
    );
  return out;
}

function runs(mask: ArrayLike<boolean>): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const v = i < mask.length ? mask[i] : false;
    if (v && start < 0) start = i;
    else if (!v && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

/** Votes (0..1) at the ends of long repeated blocks (lag and length >= 2 * minLen). */
export function repetitionNovelty(
  s: Float64Array,
  n: number,
  minLen: number,
): Float64Array {
  const p = stripeStrength(s, n);
  const longLen = 2 * minLen;
  const on = (i: number, j: number) => p[i * n + j] >= 0.5;
  const votes = new Float64Array(n + 1);
  for (let lag = longLen; lag <= n - longLen; lag++) {
    const rows: boolean[] = [];
    for (let i = 0; i < n - lag; i++) rows.push(on(i, i + lag));
    const divisors: number[] = [];
    for (let d = 1; d < lag; d++) if (lag % d === 0) divisors.push(d);
    for (const [i0, i1] of runs(rows)) {
      if (i1 - i0 < longLen) continue;
      let explained = false;
      for (const d of divisors) {
        let c = 0;
        for (let i = i0; i < i1; i++) if (on(i, i + d)) c++;
        if (c / (i1 - i0) >= DIVISOR_COVERAGE) {
          explained = true;
          break;
        }
      }
      if (explained) continue;
      for (const b of [i0, i1, i0 + lag, i1 + lag]) {
        if (0 < b && b < n) {
          votes[b] += 1.0;
          votes[b - 1] += 0.25;
          votes[b + 1] += 0.25;
        }
      }
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(votes[i], 1.0);
  return out;
}

/** |mean dB of bars [i-k, i) - mean dB of bars [i, i+k)| (truncated at the edges). */
export function loudnessStep(loud: ArrayLike<number>, k: number): Float64Array {
  const n = loud.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const kk = Math.min(k, i, n - i);
    out[i] = Math.abs(
      meanPairwise(loud, i - kk, kk) - meanPairwise(loud, i, kk),
    );
  }
  return out;
}

interface Picked {
  thr: number;
  nov: Float64Array;
  /** local maxima, strongest first (ties: lower bar) */
  peaks: number[];
}

/** Python slice [a:b] bounds clamped like a list slice (non-negative a, b). */
function pyslice(len: number, a: number, b: number): [number, number] {
  const lo = Math.min(Math.max(a, 0), len);
  const hi = Math.min(Math.max(b, 0), len);
  return [lo, Math.max(lo, hi)];
}

function candidatesOf(
  homog: Float64Array,
  rep: Float64Array,
  sc: SectionsConfig,
  valid: [number, number],
): Picked {
  const n = homog.length;
  const nov = new Float64Array(n);
  for (let i = 0; i < n; i++) nov[i] = homog[i] + sc.repetition_weight * rep[i];
  let [v0, v1] = pyslice(n, valid[0], valid[1]);
  if (v1 - v0 === 0) [v0, v1] = pyslice(n, 1, n);
  const m = v1 - v0;
  const inner = (j: number) => homog[v0 + j];
  const valleys: number[] = [];
  for (let j = 0; j < m; j++) {
    if (
      (j === 0 || inner(j) <= inner(j - 1)) &&
      (j + 1 === m || inner(j) <= inner(j + 1))
    )
      valleys.push(inner(j));
  }
  const floor = valleys.length ? median(valleys) : 0.0;
  let hmax = -Infinity;
  for (const v of homog) if (v > hmax) hmax = v;
  const thr = Math.max(
    sc.min_novelty,
    sc.peak_threshold * hmax,
    sc.noise_factor * floor,
  );
  const peaks: number[] = [];
  for (let i = 1; i < n; i++)
    if (
      nov[i] > 0 &&
      nov[i] >= nov[i - 1] &&
      (i + 1 >= n || nov[i] >= nov[i + 1])
    )
      peaks.push(i);
  peaks.sort((a, b) => (nov[a] !== nov[b] ? nov[b] - nov[a] : a - b));
  return { thr, nov, peaks };
}

function qualifies(
  i: number,
  homog: Float64Array,
  rep: Float64Array,
  sc: SectionsConfig,
  need: number,
): boolean {
  return homog[i] >= need || (sc.repetition_weight > 0 && rep[i] >= 0.5);
}

/** The origin whose grid (o + multiples of snap_bars) holds the most candidate strength (ties: first). */
export function gridOrigin(
  cands: readonly number[],
  nov: ArrayLike<number>,
  sc: SectionsConfig,
  origins: readonly number[],
): number {
  const size = sc.snap_bars;
  if (origins.length === 1 || size <= 0) return origins[0];
  let best = 0;
  let bestScore = -Infinity;
  origins.forEach((o, j) => {
    let sum = 0;
    for (const i of cands)
      if ((((i - o) % size) + size) % size === 0) sum += nov[i];
    if (sum > bestScore) {
      bestScore = sum;
      best = j;
    }
  });
  return origins[best];
}

/** pick_boundaries(..., origin_only=True). */
function gridOriginOf(
  homog: Float64Array,
  rep: Float64Array,
  sc: SectionsConfig,
  valid: [number, number],
  origins: readonly number[],
): number {
  const { thr, nov, peaks } = candidatesOf(homog, rep, sc, valid);
  return gridOrigin(
    peaks.filter((i) => qualifies(i, homog, rep, sc, thr)),
    nov,
    sc,
    origins,
  );
}

/** Bars (in the analyzed range) where a new section starts, ascending. */
export function pickBoundaries(
  homog: Float64Array,
  rep: Float64Array,
  step: Float64Array | null,
  sc: SectionsConfig,
  minLen: number,
  valid: [number, number],
  origins: readonly number[] = [0],
): number[] {
  const n = homog.length;
  const { thr, nov, peaks } = candidatesOf(homog, rep, sc, valid);
  const k2 = 2 * Math.max(2, sc.kernel_bars);
  const origin = gridOrigin(
    peaks.filter((i) => qualifies(i, homog, rep, sc, thr)),
    nov,
    sc,
    origins,
  );
  const chosen: number[] = [];
  for (const i of peaks) {
    const b = snap(i, step, sc, origin);
    const need = Math.min(b, n - b) < k2 ? thr * EDGE_FACTOR : thr;
    if (!qualifies(i, homog, rep, sc, need)) continue;
    if (b < minLen || n - b < minLen) continue;
    if (chosen.some((c) => Math.abs(b - c) < minLen)) continue;
    chosen.push(b);
  }
  return chosen.sort((a, b) => a - b);
}

/** Move i onto origin + a multiple of snap_bars when <= snap_bars // 4 (>= 1) bars away, unless a loudness step pins it. */
export function snap(
  i: number,
  step: ArrayLike<number> | null,
  sc: SectionsConfig,
  origin = 0,
): number {
  const size = sc.snap_bars;
  if (size <= 0) return i;
  const g = roundHalfEven((i - origin) / size) * size + origin;
  const lim = step !== null ? step.length : g + 1;
  if (g === i || !(0 < g && g < lim)) return i;
  if (Math.abs(g - i) > Math.max(1, Math.floor(size / 4))) return i;
  if (
    step !== null &&
    step[i] >= LOUDNESS_PIN_DB &&
    step[g] < sc.snap_min_ratio * step[i]
  )
    return i;
  return g;
}

/** Best mean bar-by-bar similarity of two spans over alignments (length difference, +-1 bar). */
export function sectionSimilarity(
  s: Float64Array,
  n: number,
  a: [number, number],
  b: [number, number],
): number {
  const [a0, a1] = a;
  const [b0, b1] = b;
  const la = a1 - a0;
  const lb = b1 - b0;
  if (la <= 0 || lb <= 0) return 0.0;
  let best = 0.0;
  const vals = new Float64Array(lb);
  for (
    let shift = Math.min(0, la - lb) - 1;
    shift < Math.max(0, la - lb) + 2;
    shift++
  ) {
    let m = 0;
    for (let t = 0; t < lb; t++)
      if (0 <= shift + t && shift + t < la)
        vals[m++] = s[(a0 + shift + t) * n + b0 + t];
    if (m < Math.max(1, Math.min(la, lb) - 1)) continue;
    const v = pairwiseSum(vals, 0, m) / m;
    best = Math.max(best, v);
  }
  return best;
}

export function labelSections(
  s: Float64Array,
  n: number,
  spans: readonly [number, number][],
  same: number,
): string[] {
  const labels: string[] = [];
  let letters = 0;
  spans.forEach((span, k) => {
    let best = -1.0;
    let bestK = -1;
    for (let j = 0; j < k; j++) {
      const v = sectionSimilarity(s, n, spans[j], span);
      if (v > best) {
        best = v;
        bestK = j;
      }
    }
    if (bestK >= 0 && best >= same) labels.push(labels[bestK]);
    else labels.push(letter(letters++));
  });
  return labels;
}

function letter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`;
}
