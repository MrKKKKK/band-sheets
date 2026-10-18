// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
// Ported: feature.chroma_cqt, filters.cq_to_chroma, core.convert.time_to_frames; and py/dsp/chroma.py.
/**
 * Per-beat chroma (py/dsp/chroma.py, default config): CQT chroma of y_harm over 6 octaves from
 * 32.7 Hz (full) and 3 octaves (bass), 36 bins per octave, norm=None, x _SCALE; columns are the
 * per-beat (and, for chords.resolution 'eighth', per-half-beat) medians of the frames.
 *
 * Layout: chroma matrices are row-major [12, n] (like the Python dumps).
 */
import { cqtMagnitudeStream, cqtPlan, estimateTuning } from '../core/cqt';
import { MemTracker } from '../core/mem';
import { roundHalfEven } from '../core/npmath';
import { DecimationChain, type HalfBand } from '../core/resample';

/** Empirical: librosa CQT chroma (norm=None) of a unit-amplitude sine sums to ~80. */
export const SCALE = 1.0 / 80.0;

export interface ChromaConfig {
  n_octaves: number;
  fmin_hz: number;
  bins_per_octave: number;
  bass_fmin_hz: number;
  bass_octaves: number;
  aggregate: 'median' | 'mean';
}

export const DEFAULT_CHROMA_CONFIG: ChromaConfig = {
  n_octaves: 6,
  fmin_hz: 32.7,
  bins_per_octave: 36,
  bass_fmin_hz: 32.7,
  bass_octaves: 3,
  aggregate: 'median',
};

/**
 * filters.cq_to_chroma(n_input, bins_per_octave, 12, fmin) as a pitch class per CQT bin: the 3-bin
 * blocks rolled left by one (pitch class c = bins {3c - 1, 3c, 3c + 1} mod bpo) and then rolled by
 * round(hz_to_midi(fmin) mod 12) rows (0 for 32.7 Hz, which rounds to 12).
 */
export function cqToChromaMap(
  nInput: number,
  bpo: number,
  fmin: number,
): Int8Array {
  const nMerge = bpo / 12;
  if (!Number.isInteger(nMerge))
    throw new Error('bins_per_octave must be a multiple of 12');
  const midi0 =
    (((12 * (Math.log2(fmin) - Math.log2(440.0)) + 69) % 12) + 12) % 12;
  const roll = roundHalfEven(midi0);
  const out = new Int8Array(nInput);
  const shift = Math.floor(nMerge / 2);
  for (let b = 0; b < nInput; b++) {
    const col = ((((b % bpo) + shift) % bpo) + bpo) % bpo; // column of the unrolled eye-repeat
    const c = Math.floor(col / nMerge);
    out[b] = (((c + roll) % 12) + 12) % 12;
  }
  return out;
}

export interface ChromaCqtOptions {
  sr: number;
  hop: number;
  fmin: number;
  nOctaves: number;
  bpo: number;
  /** Tuning in bins; estimated from y when omitted (librosa's tuning=None). */
  tuning?: number;
  halfBand?: HalfBand;
  chain?: DecimationChain;
}

/**
 * chroma_cqt(y, sr, hop_length, fmin, n_octaves, bins_per_octave, norm=None) as float32 [12, cols]
 * (librosa's dtype), without materialising the [n_bins, cols] CQT.
 */
export function chromaCqt(
  y: Float32Array,
  opts: ChromaCqtOptions,
  mem: MemTracker = new MemTracker(),
): { chroma: Float32Array; cols: number; tuning: number } {
  const tuning =
    opts.tuning ?? estimateTuning(y, { sr: opts.sr, bpo: opts.bpo }, mem);
  const nBins = opts.nOctaves * opts.bpo;
  const map = cqToChromaMap(nBins, opts.bpo, opts.fmin);
  const cqtOpts = {
    sr: opts.sr,
    hop: opts.hop,
    fmin: opts.fmin,
    nBins,
    bpo: opts.bpo,
    tuning,
    halfBand: opts.halfBand,
    chain: opts.chain,
  };
  const cols = cqtPlan(y.length, cqtOpts).cols;
  const acc = mem.f64(12 * cols);
  cqtMagnitudeStream(
    y,
    cqtOpts,
    (lo, nb, c, block) => {
      for (let r = 0; r < nb; r++) {
        const src = r * c;
        const dst = map[lo + r] * c;
        for (let t = 0; t < c; t++) acc[dst + t] += block[src + t];
      }
    },
    mem,
  );
  const chroma = mem.f32(12 * cols);
  for (let i = 0; i < chroma.length; i++) chroma[i] = Math.max(acc[i], 0); // threshold 0.0
  mem.release(acc);
  return { chroma, cols, tuning };
}

export interface FrameChroma {
  /** [12, frames] float64, x SCALE (py _frame_chroma). */
  full: Float64Array;
  bass: Float64Array;
  /** Frames of the full chroma (decides the column bounds downstream, as in Python). */
  frames: number;
  /**
   * Frames of the bass chroma. librosa trims each CQT to the minimum frame count over ITS octaves,
   * so the 3-octave bass can have one frame more than the 6-octave full (e.g. exactly 60 s: 2584
   * vs 2585); Python keeps both as they are (bass >= full always).
   */
  bassFrames: number;
  tuningFull: number;
  tuningBass: number;
}

export interface FrameChromaOptions {
  /** Inject tunings (parity tests use Python's); otherwise estimated once from y_harm. */
  tuningFull?: number;
  tuningBass?: number;
  sr?: number;
  hop?: number;
  /** Decimation filter override (default resample.ts cqtDecimator). */
  halfBand?: HalfBand;
}

function scaled(c: Float32Array, mem: MemTracker): Float64Array {
  const out = mem.f64(c.length);
  for (let i = 0; i < c.length; i++) out[i] = c[i] * SCALE;
  return out;
}

/**
 * py chroma._frame_chroma for the full and the bass range (kind 'cqt', top_voice_discount 0).
 * librosa estimates the tuning inside each chroma_cqt call; both see the same y_harm, so it is
 * estimated once here unless injected.
 */
export function frameChroma(
  yHarm: Float32Array,
  cfg: ChromaConfig = DEFAULT_CHROMA_CONFIG,
  opts: FrameChromaOptions = {},
  mem: MemTracker = new MemTracker(),
): FrameChroma {
  const sr = opts.sr ?? 22050;
  const hop = opts.hop ?? 512;
  let tFull = opts.tuningFull;
  let tBass = opts.tuningBass;
  if (tFull === undefined || tBass === undefined) {
    const est = estimateTuning(yHarm, { sr, bpo: cfg.bins_per_octave }, mem);
    tFull ??= est;
    tBass ??= est;
  }
  // One decimation chain for both CQTs (same input, same 2:1 stages); the bass needs the levels
  // from its early-downsample count on again after the full CQT has walked past them.
  const bassPlan = cqtPlan(yHarm.length, {
    sr,
    hop,
    fmin: cfg.bass_fmin_hz,
    nBins: cfg.bass_octaves * cfg.bins_per_octave,
    bpo: cfg.bins_per_octave,
    tuning: tBass,
  });
  const chain = new DecimationChain(yHarm, bassPlan.early, mem, opts.halfBand);
  const base = {
    sr,
    hop,
    bpo: cfg.bins_per_octave,
    halfBand: opts.halfBand,
    chain,
  };
  const f = chromaCqt(
    yHarm,
    { ...base, fmin: cfg.fmin_hz, nOctaves: cfg.n_octaves, tuning: tFull },
    mem,
  );
  const full = scaled(f.chroma, mem);
  mem.release(f.chroma);
  const b = chromaCqt(
    yHarm,
    {
      ...base,
      fmin: cfg.bass_fmin_hz,
      nOctaves: cfg.bass_octaves,
      tuning: tBass,
    },
    mem,
  );
  const bass = scaled(b.chroma, mem);
  mem.release(b.chroma);
  chain.release();
  return {
    full,
    bass,
    frames: f.cols,
    bassFrames: b.cols,
    tuningFull: tFull,
    tuningBass: tBass,
  };
}

// ---------------------------------------------------------------------------------------------
// Columns (py/dsp/chroma.py _columns / column_times / last_beat_end / _aggregate)

/** librosa.time_to_frames: floor(int(t * sr) / hop) (int truncates toward 0). */
export function timeToFrames(t: number, sr = 22050, hop = 512): number {
  return Math.floor(Math.trunc(t * sr) / hop);
}

function npMedian(a: ArrayLike<number>): number {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** last_beat_end: last beat + median beat interval, capped at the audio end (R8). */
export function lastBeatEnd(
  times: ArrayLike<number>,
  duration: number,
): number {
  const n = times.length;
  if (n === 0) return duration;
  const last = times[n - 1];
  if (n < 2) return Math.max(duration, last);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = times[i + 1] - times[i];
  const end = last + npMedian(d);
  return Math.min(Math.max(end, last), Math.max(duration, last));
}

/** column_times: start time of every column (half-beat midpoints for perBeat 2). */
export function columnTimes(
  times: ArrayLike<number>,
  duration: number,
  perBeat = 1,
): Float64Array {
  const n = times.length;
  if (perBeat === 1 || n === 0) return Float64Array.from(times);
  const out = new Float64Array(n * perBeat);
  const lastEnd = lastBeatEnd(times, duration);
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? times[i + 1] : lastEnd;
    for (let k = 0; k < perBeat; k++)
      out[i * perBeat + k] = times[i] + (k / perBeat) * (end - times[i]);
  }
  return out;
}

/** _aggregate: per column median (or mean) of frames[:, a:b], at least one frame. */
export function aggregate(
  frames: ArrayLike<number>,
  nFrames: number,
  bounds: ArrayLike<number>,
  how: 'median' | 'mean' = 'median',
): Float64Array {
  const nc = bounds.length - 1;
  const out = new Float64Array(12 * Math.max(nc, 0));
  const seg: number[] = [];
  for (let i = 0; i < nc; i++) {
    const a = Math.min(bounds[i], nFrames - 1);
    let b = Math.min(bounds[i + 1], nFrames);
    if (b <= a) b = a + 1;
    for (let r = 0; r < 12; r++) {
      seg.length = 0;
      for (let t = a; t < b; t++) seg.push(frames[r * nFrames + t]);
      let v: number;
      if (how === 'median') v = npMedian(seg);
      else {
        let s = 0;
        for (const x of seg) s += x;
        v = s / seg.length;
      }
      out[r * nc + i] = v;
    }
  }
  return out;
}

export interface Columns {
  /** Beat columns [12, nb]. */
  chroma: Float64Array;
  bass: Float64Array;
  /** Beat column frame bounds, length nb + 1. */
  bounds: Int32Array;
  /** Chord-stage columns [12, nc] (nc = nb * perBeat) and their bounds (nc + 1). */
  cChroma: Float64Array;
  cBounds: Int32Array;
  perBeat: number;
}

/**
 * chroma._columns from frame chroma (full [12, nFrames], bass [12, nFramesBass]) and the beat
 * times. Bounds are clipped to the FULL chroma's frame count; each matrix is aggregated over its
 * own frame count (py _aggregate reads frames.shape[1]).
 */
export function columns(
  full: ArrayLike<number>,
  bass: ArrayLike<number>,
  nFrames: number,
  times: ArrayLike<number>,
  duration: number,
  perBeat = 2,
  how: 'median' | 'mean' = 'median',
  sr = 22050,
  hop = 512,
  nFramesBass = nFrames,
): Columns {
  const n = times.length;
  if (n === 0) {
    const z = new Float64Array(0);
    const b0 = new Int32Array(1);
    return { chroma: z, bass: z, bounds: b0, cChroma: z, cBounds: b0, perBeat };
  }
  const bounds = new Int32Array(n + 1);
  for (let i = 0; i < n; i++)
    bounds[i] = Math.min(Math.max(timeToFrames(times[i], sr, hop), 0), nFrames);
  const endFrame = timeToFrames(lastBeatEnd(times, duration), sr, hop);
  bounds[n] = Math.min(Math.max(endFrame, 0), nFrames);
  const chroma = aggregate(full, nFrames, bounds, how);
  const bchroma = aggregate(bass, nFramesBass, bounds, how);
  if (perBeat === 1)
    return {
      chroma,
      bass: bchroma,
      bounds,
      cChroma: chroma,
      cBounds: bounds,
      perBeat: 1,
    };
  const ct = columnTimes(times, duration, perBeat);
  const cBounds = new Int32Array(ct.length + 1);
  for (let i = 0; i < ct.length; i++)
    cBounds[i] = Math.min(Math.max(timeToFrames(ct[i], sr, hop), 0), nFrames);
  for (let i = 0; i < n; i++) cBounds[i * perBeat] = bounds[i]; // on-beat columns start where the beats do
  cBounds[ct.length] = bounds[n];
  return {
    chroma,
    bass: bchroma,
    bounds,
    cChroma: aggregate(full, nFrames, cBounds, how),
    cBounds,
    perBeat,
  };
}

export interface ChordColumns extends Columns {
  frames: FrameChroma;
}

/** chroma.chord_columns(feat, grid, cfg) for the default config (resolution 'eighth' -> perBeat 2). */
export function chordColumns(
  yHarm: Float32Array,
  beatTimes: ArrayLike<number>,
  duration: number,
  opts: FrameChromaOptions & { perBeat?: number; cfg?: ChromaConfig } = {},
  mem: MemTracker = new MemTracker(),
): ChordColumns {
  const cfg = opts.cfg ?? DEFAULT_CHROMA_CONFIG;
  const perBeat = opts.perBeat ?? 2;
  if (beatTimes.length === 0) {
    const z = new Float64Array(0);
    const b0 = new Int32Array(1);
    const frames: FrameChroma = {
      full: z,
      bass: z,
      frames: 0,
      bassFrames: 0,
      tuningFull: NaN,
      tuningBass: NaN,
    };
    return {
      chroma: z,
      bass: z,
      bounds: b0,
      cChroma: z,
      cBounds: b0,
      perBeat,
      frames,
    };
  }
  const fc = frameChroma(yHarm, cfg, opts, mem);
  const cols = columns(
    fc.full,
    fc.bass,
    fc.frames,
    beatTimes,
    duration,
    perBeat,
    cfg.aggregate,
    opts.sr,
    opts.hop,
    fc.bassFrames,
  );
  return { ...cols, frames: fc };
}
