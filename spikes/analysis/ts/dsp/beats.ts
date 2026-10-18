// Follows librosa 0.11.0 (ISC, (c) 2013--2023 librosa development team); see ts/THIRD_PARTY.md.
/**
 * librosa parts ported line by line: feature.tempo / feature.tempogram / beat.beat_track (Ellis DP).
 *
 * Beat tracking (port of py/dsp/beats.py + the tempo-octave rule of py/dsp/tempo.py, DEFAULT path only:
 * method 'ellis', start_bpm 120, tightness 100, trim False, tempo_octave 'rule', tempo_hint 0).
 *
 *   estimateTempo(env)            librosa.feature.tempo (autocorrelation tempogram + log-normal prior)
 *   beatTrackFrames(env, bpm)     librosa.beat.beat_track's DP (frames, before _refine)
 *   refine(times, yPerc)          beats.py _refine (snap to the steepest attack nearby)
 *   chooseOctave(times, events)   tempo.py choose_octave with tempo_octave 'rule' (T / 2T / T/2 candidates)
 *   trackBeats(input)             beats.py track_beats (all of the above)
 *
 * The rule's events (tempo.event_times: onset peaks + STFT-chroma changes) are T9's job; trackBeats
 * takes them as a lazy callback so the STFT is only computed when the rule runs (>= 2 beats).
 *
 * Numerics follow docs/audio-spike3-librosa-notes.md section 6: np.round is half-to-even, the onset
 * normalisation is float32 (numpy pairwise sums emulated), localscore / DP are float64, localmax never
 * peaks at index 0, trim=False still drops leading / trailing frames with localscore <= 0. The
 * tempogram autocorrelation is computed directly (not by FFT; same values to ~1e-16) and the frame
 * mean is a compensated sum (numpy uses pairwise; same to ~1e-16).
 */

import { MemTracker } from './core/mem';
import { pairwiseSum, roundHalfEven } from './core/npmath';

export const SR = 22050;
export const HOP = 512;
export const START_BPM = 120.0;
export const TIGHTNESS = 100.0;
const STD_BPM = 1.0;
const AC_SIZE = 8.0; // seconds
const MAX_TEMPO = 320.0;
const TINY_F32 = 1.1754943508222875e-38; // np.finfo(np.float32).tiny
const TINY_F64 = 2.2250738585072014e-308;

// tempo.py constants
export const PREF_LO = 70.0;
export const PREF_HI = 150.0;
const PRIOR_K = 2.0;
const TOL = 0.06;
const MARGIN_IN = 1.5;

/** float32 `x.std(ddof=1)` exactly as numpy computes it. */
export function stdDdof1F32(x: Float32Array): number {
  const f = Math.fround;
  const n = x.length;
  const mean = f(pairwiseSum(x, 0, n, f) / n);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = f(x[i] - mean);
    sq[i] = f(d * d);
  }
  return f(Math.sqrt(f(pairwiseSum(sq, 0, n, f) / (n - 1))));
}

/** np.median (mean of the two middle values for an even count). */
export function median(a: ArrayLike<number>): number {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function diff(a: ArrayLike<number>): Float64Array {
  const d = new Float64Array(Math.max(a.length - 1, 0));
  for (let i = 0; i < d.length; i++) d[i] = a[i + 1] - a[i];
  return d;
}

/** librosa.util.localmax along a 1-D array (index 0 never; the last index when > its left neighbour). */
export function localmax(x: ArrayLike<number>): Uint8Array {
  const n = x.length;
  const m = new Uint8Array(n);
  for (let i = 1; i < n; i++) m[i] = x[i] > x[i - 1] && (i === n - 1 || x[i] >= x[i + 1]) ? 1 : 0;
  return m;
}

/** librosa.frames_to_time: (f * hop) / sr. */
export function framesToTime(frames: ArrayLike<number>, sr = SR, hop = HOP): Float64Array {
  const t = new Float64Array(frames.length);
  for (let i = 0; i < t.length; i++) t[i] = (frames[i] * hop) / sr;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Tempo (librosa.feature.tempo with default arguments)

export interface TempoEstimate {
  /** argmax bin k of log1p(1e6 tg) + logprior (k = frames per beat). */
  bin: number;
  /** bpms[bin] = 60 sr / (hop k). */
  bpm: number;
  /** log1p(1e6 tg) + logprior, length win_length (344). */
  score: Float64Array;
}

/** librosa.tempo_frequencies(n, hop, sr): bpms[0] = inf. */
export function tempoFrequencies(nBins: number, sr = SR, hop = HOP): Float64Array {
  const b = new Float64Array(nBins);
  b[0] = Infinity;
  for (let k = 1; k < nBins; k++) b[k] = (60.0 * sr) / (hop * k);
  return b;
}

/** scipy get_window('hann', M, fftbins=True) (periodic): general_cosine over linspace(-pi, pi, M + 1). */
function periodicHann(M: number): Float64Array {
  const w = new Float64Array(M);
  const step = (2 * Math.PI) / M;
  for (let n = 0; n < M; n++) w[n] = 0.5 + 0.5 * Math.cos(-Math.PI + n * step);
  return w;
}

/**
 * Mean over frames of the max-normalised autocorrelation tempogram (librosa.feature.tempogram,
 * center=True, linear_ramp padding to 0, hann window, norm=inf), length winLength.
 */
export function meanTempogram(env: Float32Array, winLength: number): Float64Array {
  const n = env.length;
  const half = Math.floor(winLength / 2);
  // np.pad(mode='linear_ramp', end_values=0) on float32: linspace(0, edge, half, endpoint=False) cast to f32
  const padded = new Float64Array(n + 2 * half);
  const e0 = env[0];
  const e1 = env[n - 1];
  for (let i = 0; i < half; i++) {
    padded[i] = Math.fround(i * (e0 / half));
    padded[n + 2 * half - 1 - i] = Math.fround(i * (e1 / half));
  }
  for (let i = 0; i < n; i++) padded[half + i] = env[i];
  const win = periodicHann(winLength);
  const x = new Float64Array(winLength);
  const r = new Float64Array(winLength);
  // compensated (Neumaier) running sums per lag
  const sum = new Float64Array(winLength);
  const comp = new Float64Array(winLength);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < winLength; i++) x[i] = padded[t + i] * win[i];
    let peak = 0;
    for (let k = 0; k < winLength; k++) {
      let s = 0;
      for (let i = 0; i + k < winLength; i++) s += x[i] * x[i + k];
      r[k] = s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const scale = peak < TINY_F64 ? 1 : peak;
    for (let k = 0; k < winLength; k++) {
      const v = r[k] / scale;
      const s = sum[k] + v;
      comp[k] += Math.abs(sum[k]) >= Math.abs(v) ? sum[k] - s + v : v - s + sum[k];
      sum[k] = s;
    }
  }
  const tg = new Float64Array(winLength);
  for (let k = 0; k < winLength; k++) tg[k] = (sum[k] + comp[k]) / n;
  return tg;
}

/** librosa.feature.tempo(onset_envelope=env, sr, hop_length, start_bpm=120) (aggregate=np.mean). */
export function estimateTempo(env: Float32Array, sr = SR, hop = HOP, startBpm = START_BPM): TempoEstimate {
  const winLength = Math.floor(Math.trunc(AC_SIZE * sr) / hop); // time_to_frames(8.0) = 344
  const tg = meanTempogram(env, winLength);
  const bpms = tempoFrequencies(winLength, sr, hop);
  let maxIdx = 0; // int(np.argmax(bpms < max_tempo))
  while (maxIdx < winLength && !(bpms[maxIdx] < MAX_TEMPO)) maxIdx++;
  if (maxIdx === winLength) maxIdx = 0;
  const score = new Float64Array(winLength);
  let bin = 0;
  for (let k = 0; k < winLength; k++) {
    const lp = k < maxIdx ? -Infinity : -0.5 * ((Math.log2(bpms[k]) - Math.log2(startBpm)) / STD_BPM) ** 2;
    score[k] = Math.log1p(1e6 * tg[k]) + lp;
    if (score[k] > score[bin]) bin = k;
  }
  return { bin, bpm: bpms[bin], score };
}

// ---------------------------------------------------------------------------------------------
// Ellis DP (librosa.beat.__beat_tracker with a static tempo)

/** Beat frames (ascending) of librosa.beat.beat_track(onset_envelope=env, bpm=bpm, trim=False). */
export function beatTrackFrames(
  env: Float32Array,
  bpm: number,
  sr = SR,
  hop = HOP,
  tightness = TIGHTNESS,
): Int32Array {
  const N = env.length;
  if (N === 0 || !env.some((v) => v !== 0)) return new Int32Array(0);
  const frameRate = sr / hop;
  const fpb = roundHalfEven((frameRate * 60.0) / bpm);

  // __normalize_onsets (float32)
  const norm = Math.fround(stdDdof1F32(env) + TINY_F32);
  const onset = new Float64Array(N);
  for (let i = 0; i < N; i++) onset[i] = Math.fround(env[i] / norm);

  // __beat_local_score (float64; the upper bound i + K//2 means onset[0] is never used)
  const K = 2 * fpb + 1;
  const window = new Float64Array(K);
  for (let j = 0; j < K; j++) window[j] = Math.exp(-0.5 * ((((j - fpb) * 32.0) / fpb) ** 2));
  const half = Math.floor(K / 2);
  const localscore = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const hiK = Math.min(i + half, K);
    for (let k = Math.max(0, i + half - N + 1); k < hiK; k++) s += window[k] * onset[i + half - k];
    localscore[i] = s;
  }

  // __beat_track_dp
  let lsMax = -Infinity;
  for (let i = 0; i < N; i++) if (localscore[i] > lsMax) lsMax = localscore[i];
  const scoreThresh = 0.01 * lsMax;
  const backlink = new Int32Array(N);
  const cumscore = new Float64Array(N);
  const logFpb = Math.log(fpb);
  const near = roundHalfEven(fpb / 2);
  let firstBeat = true;
  for (let i = 0; i < N; i++) {
    let best = -Infinity;
    let loc = -1;
    for (let l = i - near; l > i - 2 * fpb - 1; l--) {
      if (l < 0) break;
      const d = Math.log(i - l) - logFpb;
      const score = cumscore[l] - tightness * d ** 2;
      if (score > best) {
        best = score;
        loc = l;
      }
    }
    cumscore[i] = loc >= 0 ? localscore[i] + best : localscore[i];
    if (firstBeat && localscore[i] < scoreThresh) backlink[i] = -1;
    else {
      backlink[i] = loc;
      firstBeat = false;
    }
  }

  // __last_beat: last local max of cumscore >= half the median of the local maxima
  const lm = localmax(cumscore);
  const peaks: number[] = [];
  for (let i = 0; i < N; i++) if (lm[i]) peaks.push(cumscore[i]);
  let tail = N - 1;
  if (peaks.length > 0) {
    const threshold = 0.5 * median(peaks);
    for (let n = N - 1; n >= 0; n--) {
      if (lm[n] && cumscore[n] >= threshold) {
        tail = n;
        break;
      }
    }
  }

  // __dp_backtrack
  const beats = new Uint8Array(N);
  for (let n = tail; n >= 0; n = backlink[n]) beats[n] = 1;

  // __trim_beats with trim=False: threshold 0 still drops the leading / trailing localscore <= 0 frames
  for (let n = 0; n < N && localscore[n] <= 0; n++) beats[n] = 0;
  for (let n = N - 1; n >= 0 && localscore[n] <= 0; n--) beats[n] = 0;

  const out: number[] = [];
  for (let i = 0; i < N; i++) if (beats[i]) out.push(i);
  return Int32Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// beats.py _refine

/** np.hanning(M) (symmetric): 0.5 + 0.5 cos(pi n / (M - 1)), n = 1 - M, 3 - M, ..., M - 1. */
export function hanningSym(M: number): Float64Array {
  const w = new Float64Array(M);
  if (M === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < M; i++) w[i] = 0.5 + 0.5 * Math.cos((Math.PI * (1 - M + 2 * i)) / (M - 1));
  return w;
}

/** np.convolve(a, k, mode='same') for an odd-length kernel shorter than a. */
export function convolveSame(a: ArrayLike<number>, k: ArrayLike<number>): Float64Array {
  const n = a.length;
  const m = k.length;
  const out = new Float64Array(Math.max(n, m));
  const left = Math.floor((m - 1) / 2);
  for (let i = 0; i < out.length; i++) {
    // full index f = i + left; out = sum_j a[j] k[f - j]
    const f = i + left;
    const jLo = Math.max(0, f - m + 1);
    const jHi = Math.min(n - 1, f);
    let s = 0;
    for (let j = jLo; j <= jHi; j++) s += a[j] * k[f - j];
    out[i] = s;
  }
  return out;
}

/**
 * Snap frame-resolution beats to the steepest rise of the ~3 ms smoothed rectified y_perc within
 * +-max(2 hops, 20 % of the median interval); beats without a rise >= 5 % of the global steepest keep
 * their time, leading / trailing ones of that kind are dropped, then beats closer than 0.25 IBI to
 * the previous one are dropped. Same formulas as py/dsp/beats.py _refine.
 *
 * Streamed (T19): py builds |y|, the smoothed envelope and the rise as three signal-length arrays (5 min:
 * 3 x 53 MB float64). Here one pass computes env[i] (the same sum in the same order as convolveSame, so
 * bit-identical), keeps the last w + 1 env values in a ring, and updates the global rise max and the
 * running argmax of every beat window that contains i (first maximum, like np.argmax). Scratch memory
 * is O(beats). `times` must be ascending (beat tracker output).
 */
export function refine(times: Float64Array, yPerc: Float32Array, sr = SR, hop = HOP, mem?: MemTracker): Float64Array {
  const nb = times.length;
  if (nb === 0) return times;
  const w = Math.max(Math.trunc(0.003 * sr), 1);
  const han = hanningSym(2 * w + 1);
  const hs = pairwiseSum(han);
  const kern = han.map((v) => v / hs);
  const n = yPerc.length;
  const m = kern.length;
  const len = Math.max(n, m); // np.convolve(mode='same') length = len(rise)
  const left = Math.floor((m - 1) / 2);

  const ibi = nb >= 2 ? median(diff(times)) : 0.0;
  const half = Math.max(2 * hop, Math.trunc(0.2 * ibi * sr));
  const alloc = mem ?? new MemTracker();
  const lo = alloc.f64(nb);
  const hi = alloc.f64(nb);
  const bestJ = alloc.f64(nb);
  const bestV = alloc.f64(nb);
  for (let k = 0; k < nb; k++) {
    if (k > 0 && times[k] < times[k - 1]) throw new Error('refine: beat times must be ascending');
    const c = roundHalfEven(times[k] * sr);
    lo[k] = Math.max(c - half, 0);
    hi[k] = Math.min(c + half + 1, len);
  }

  const ringN = w + 1;
  const ring = new Float64Array(ringN); // env[i - w .. i]
  let riseMax = -Infinity;
  let kFirst = 0; // first window with hi > i (lo / hi are non-decreasing in k)
  for (let i = 0; i < len; i++) {
    // env[i] exactly as convolveSame(|y|, kern)[i]
    const f = i + left;
    const jLo = Math.max(0, f - m + 1);
    const jHi = Math.min(n - 1, f);
    let s = 0;
    for (let j = jLo; j <= jHi; j++) s += Math.abs(yPerc[j]) * kern[f - j];
    const rise = i >= w ? s - ring[(i - w) % ringN] : 0;
    ring[i % ringN] = s;
    if (rise > riseMax) riseMax = rise;
    while (kFirst < nb && hi[kFirst] <= i) kFirst++;
    for (let k = kFirst; k < nb && lo[k] <= i; k++) {
      if (i === lo[k] || rise > bestV[k]) {
        bestV[k] = rise;
        bestJ[k] = i;
      }
    }
  }

  const floor = 0.05 * riseMax;
  const out = Float64Array.from(times);
  const has = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) {
    if (hi[k] <= lo[k]) continue;
    if (bestV[k] >= floor) {
      out[k] = (bestJ[k] - w / 2) / sr;
      has[k] = 1;
    }
  }
  alloc.release(lo, hi, bestJ, bestV);
  const first = has.indexOf(1);
  if (first < 0) return out;
  const last = has.lastIndexOf(1);
  const span = out.subarray(first, last + 1);
  const kept: number[] = [span[0]];
  for (let i = 1; i < span.length; i++) if (!(ibi > 0) || span[i] - span[i - 1] > 0.25 * ibi) kept.push(span[i]);
  return Float64Array.from(kept);
}

// ---------------------------------------------------------------------------------------------
// tempo.py choose_octave (tempo_octave 'rule', no hint)

export type CandidateName = 'T' | '2T' | 'T/2a' | 'T/2b';

/** 60 / median inter-beat interval (0 for < 2 beats). */
export function gridBpm(times: ArrayLike<number>): number {
  return times.length >= 2 ? 60.0 / median(diff(times)) : 0.0;
}

export function prior(bpm: number): number {
  if (bpm <= 0) return 0.0;
  let octs = 0.0;
  if (bpm < PREF_LO) octs = Math.log2(PREF_LO / bpm);
  else if (bpm > PREF_HI) octs = Math.log2(bpm / PREF_HI);
  return Math.exp(-PRIOR_K * octs);
}

/** For each a[i]: is there a b[j] within tol? (b sorted; np.searchsorted side='left'). */
function near(a: ArrayLike<number>, b: ArrayLike<number>, tol: number): number {
  let count = 0;
  if (b.length === 0) return 0;
  for (let i = 0; i < a.length; i++) {
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid] < a[i]) lo = mid + 1;
      else hi = mid;
    }
    const bl = b[Math.min(Math.max(lo - 1, 0), b.length - 1)];
    const bh = b[Math.min(lo, b.length - 1)];
    if (Math.min(Math.abs(a[i] - bl), Math.abs(a[i] - bh)) <= tol) count++;
  }
  return count;
}

/** F-measure of events vs grid beats (tempo.py _fit). */
export function fit(times: ArrayLike<number>, events: ArrayLike<number>): number {
  if (times.length < 2 || events.length === 0) return 0.0;
  const tol = Math.min(TOL, 0.25 * median(diff(times)));
  const lo = times[0] - tol;
  const hi = times[times.length - 1] + tol;
  const ev: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i] >= lo && events[i] <= hi) ev.push(events[i]);
  if (ev.length === 0) return 0.0;
  const r = near(ev, times, tol) / ev.length;
  const p = near(times, ev, tol) / times.length;
  return r + p === 0 ? 0.0 : (2 * r * p) / (r + p);
}

/** tempo.py candidates: T, 2T (midpoints inserted), T/2 both phases. */
export function candidates(times: Float64Array): [CandidateName, Float64Array][] {
  const out: [CandidateName, Float64Array][] = [['T', times]];
  if (times.length >= 2) {
    const dbl = new Float64Array(2 * times.length - 1);
    for (let i = 0; i < times.length; i++) dbl[2 * i] = times[i];
    for (let i = 0; i + 1 < times.length; i++) dbl[2 * i + 1] = (times[i] + times[i + 1]) / 2;
    out.push(['2T', dbl.sort()]);
  }
  if (times.length >= 4) {
    out.push(['T/2a', times.filter((_, i) => i % 2 === 0)]);
    out.push(['T/2b', times.filter((_, i) => i % 2 === 1)]);
  }
  return out;
}

export interface OctaveChoice {
  times: Float64Array;
  tempo: number;
  chosen: CandidateName;
}

/** tempo.py choose_octave with tempo_octave 'rule' and tempo_hint 0; `events` = tempo.event_times. */
export function chooseOctave(times: Float64Array, tempo: number, events: ArrayLike<number>): OctaveChoice {
  const keep: OctaveChoice = { times, tempo, chosen: 'T' };
  if (times.length < 2) return keep;
  const score = (t: Float64Array) => fit(t, events) * prior(gridBpm(t));
  const pool = candidates(times);
  let best = pool[0];
  let bestS = score(best[1]);
  for (const c of pool.slice(1)) {
    const s = score(c[1]);
    if (s > bestS + 1e-12) {
      best = c;
      bestS = s;
    }
  }
  const t0 = gridBpm(times);
  if (best[0] !== 'T' && PREF_LO <= t0 && t0 <= PREF_HI && bestS <= MARGIN_IN * score(times)) return keep;
  if (best[0] === 'T') return keep;
  return { times: best[1], tempo: gridBpm(best[1]), chosen: best[0] };
}

// ---------------------------------------------------------------------------------------------
// beats.py track_beats

export interface BeatInput {
  /** onset_strength of y_perc (float32, one value per hop). */
  onsetEnv: Float32Array;
  /** percussive signal (or y when HPSS is off) at sr, float32. */
  yPerc: Float32Array;
  sr?: number;
  hop?: number;
  /** counts refine's scratch (optional) */
  mem?: MemTracker;
}

export interface BeatGrid {
  times: Float64Array;
  tempo: number;
  method: 'ellis';
}

export interface BeatDebug {
  tempo?: TempoEstimate;
  framesRaw?: Int32Array;
  /** after _refine, before the tempo rule */
  tracked?: Float64Array;
  chosen?: CandidateName;
}

/**
 * Beat times (s, ascending) and tempo = 60 / median IBI. `events` is called (once) only when the
 * tempo rule runs; it must return tempo.event_times (sorted seconds).
 */
export function trackBeats(
  input: BeatInput,
  events: () => ArrayLike<number>,
  debug: BeatDebug = {},
): BeatGrid {
  const sr = input.sr ?? SR;
  const hop = input.hop ?? HOP;
  const env = input.onsetEnv;
  if (env.length === 0 || !env.some((v) => v > 0)) return { times: new Float64Array(0), tempo: 0.0, method: 'ellis' };
  const est = estimateTempo(env, sr, hop);
  const frames = beatTrackFrames(env, est.bpm, sr, hop);
  const times = refine(framesToTime(frames, sr, hop), input.yPerc, sr, hop, input.mem);
  const tempo = gridBpm(times);
  debug.tempo = est;
  debug.framesRaw = frames;
  debug.tracked = times;
  if (times.length < 2) return { times, tempo, method: 'ellis' };
  const c = chooseOctave(times, tempo, events());
  debug.chosen = c.chosen;
  return { times: c.times, tempo: c.tempo, method: 'ellis' };
}
