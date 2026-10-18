/**
 * Spike 4 T5: note segmentation and per-note pitch (docs/audio-spike4-plan.md section 2 "segmentation",
 * "pitch and candidates", "octave fix"; section 7 T5).
 *
 * Input (nothing from ground truth):
 *   track    FrameF0Track on the analyzer grid (t0 + i * hopSec); a frame is voiced when voiced[i] >= 0.5 and hz > 0.
 *   levelDb  frame loudness in dB on the SAME grid, one value per frame; use frameLevelDb(audio, sr, track) (a short
 *            window centred on each frame, 2 f0 periods, 10..32 ms). f0.ts F0Result.levelDb also fits the type but its
 *            31 ms window starting half a frame early flattens 40-60 ms dips (repeats were missed with it on H1).
 *            Silent frames <= -100. Only relative values matter.
 *   info     HumInfo (bpm and ts[1] give the 16th length for the minimum note length and the octave fix).
 *
 * Rules, in order (frames in semitones: p = 69 + 12 log2(hz / 440)):
 *   0. Octave glitches (pitch.octaveFix): inside a voiced run, a frame whose pitch is 12 (+-OCT_GLITCH_TOL)
 *      semitones from the running median of +-OCT_GLITCH_HALF frames is moved by that octave.
 *   1. Voiced runs: maximal runs of voiced frames (f0.ts already bridged short gaps). 1b: runs separated by an
 *      unvoiced gap <= JOIN_GAP_MS whose level does not dip (by segment.dipDb / 2) are joined, the gap pitch linear
 *      (the f0 tracker lost a fast glide; joinDropouts).
 *   2. Smoothing: median of segment.medianFrames frames inside each run (the window shrinks at run edges).
 *      Slope = central difference of the smoothed pitch; a frame is "stable" when |slope| <
 *      segment.glideSemitonesPerSec (glide / scoop / vibrato flanks are not stable).
 *   3. Pitch splits: once the pitch has settled (SETTLE_FRAMES stable frames), the reference is the median of the
 *      last REF_FRAMES smoothed frames of the current note since then.
 *      When the smoothed pitch stays >= segment.moveSemitones away from it, on one side, for >= segment.minMoveMs,
 *      a new note starts. The boundary goes back from the first deviating frame along the monotone movement (the
 *      glide start), at most MAX_BACK_MS and not past a frame within BACK_NEAR of the old reference. The next
 *      note's reference waits until the pitch settles again (so the rest of a glide does not split twice). Vibrato
 *      (+-20..60 cents) never stays that far for that long from a median over ~2 vibrato periods, and a scoop at a
 *      phrase start is over before the pitch settles, so neither splits.
 *      3b (spike 4 step 2, scoops / drift; segment.plateauFrames > 0): a split also needs a stable pitch on BOTH
 *      sides: plateauFrames consecutive smoothed frames (at most segment.plateauMaxSixteenths of a 16th, >= 3) whose
 *      range is <= segment.plateauSemitones. The new side must
 *      reach one while it still deviates; if the pitch comes back first (overshoot-and-return, a short excursion) the
 *      deviation is dropped, and if it has not plateaued after segment.plateauWaitMs the split is made anyway (a real
 *      note with heavy vibrato). If the OLD side has no plateau since its start (it was a scoop / ramp that the
 *      slope test called stable; a side lasting plateauWaitMs counts as stable (vibrato), and so does one more than
 *      segment.scoopMaxSemitones from the new pitch (a jump, not an approach)), no boundary is made: the reference is reset and settles on the new pitch, so the
 *      ramp belongs to the note it leads into.
 *   4. Dip snap: a pitch boundary moves to the deepest level minimum within +-SNAP_MS when that dip is at least
 *      segment.dipDb / 2 deep (singers dip at note changes too; the dip marks the onset better than the glide).
 *   5. Dip splits (segment.splitOnDips; same-pitch repeats "la la"): inside a note, a local minimum of the
 *      level that is >= segment.dipDb below the maxima on both sides within +-DIP_WINDOW_MS splits it
 *      at the minimum, deepest first, both parts at least the minimum note length. Not where the pitch oscillates
 *      in the VIB_WINDOW_MS after the dip (vibratoAround): vibrato makes level dips through the formants.
 *   6. Short notes (< segment.minNoteSixteenths 16ths): merged into the touching neighbour with the closer median
 *      pitch (shortest first), except that a piece whose pitch lies between both neighbours (the rest of a glide)
 *      joins the NEXT note; a short note touching nothing is dropped. Then touching notes split by pitch whose
 *      medians are < MERGE_SEMITONES apart are merged again (left-overs of scoops).
 *      6b (segment.fragmentMs > 0; note-level smoothing): a note shorter than fragmentMs that touches a neighbour
 *      (unvoiced gap <= segment.fragmentGapMs; boundary from a pitch split or a voiced-run end, never a level dip)
 *      whose median pitch is <= segment.fragmentSemitones away, and that neighbour is longer, is merged into it
 *      (the closer pitch first, shortest fragment first). The merged note's pitch is taken from the longer part only
 *      (Segment.pa / pb), so a scoop or a drifted tail does not move it. Same-pitch pieces left over are merged by the
 *      MERGE_SEMITONES rule of 6.
 *   7. Pitch: median of the raw pitch of the stable frames after trimming pitch.trimFraction of them at each end
 *      (all frames if fewer than 3 are stable).
 *   8. Octave fix (pitch.octaveFix): a note of <= pitch.octaveFixMaxSixteenths whose pitch is >= OCT_FAR semitones
 *      from BOTH neighbours (previous and next note, each within OCT_NEIGHBOUR_SEC; the first and last notes are
 *      never moved) and gets within OCT_NEAR of both when moved by 12 is moved; the original reading stays as a
 *      candidate (octaveFixed).
 *   9. Tuning (pitch.tuning): the recording-wide offset = duration-weighted median of the notes' deviation from the
 *      nearest semitone, iterated twice so offsets near +-50 cents do not wrap. Subtracted before rounding; `cents`
 *      is what is left (HumNote.cents). Absolute sung pitch = midi + (cents + tuningCents) / 100.
 *  10. Candidates and confidence (design decision 6): p(k) ~ exp(-(q - k)^2 / (2 sigma^2)) over the chosen
 *      semitone and its two neighbours, sigma = PITCH_SIGMA_CENTS combined with the spread of the stable frames.
 *      The nearer neighbour is a candidate when |cents| >= 50 - pitch.boundaryCents; an octave alternative is
 *      added when the note was octave-fixed (the original) or lies >= OCT_FAR from its neighbours (toward them).
 *      confidence = p(best) - p(second best) over the pitch readings.
 *
 * T10 switches (default off; docs/audio-spike4-plan.md section 7 T10):
 *   3h. Note HMM (segment.noteHmm), instead of rules 3 / 3b: per voiced run, a Viterbi path over semitone states
 *      k (centre k + the frame tuning offset, estimateTuning over the stable smoothed frames) with the frame cost
 *      min((s - centre)^2 / (2 sigma^2), hmmOutlierCost) on stable frames and 0 on glide frames (they do not count,
 *      as in rule 3; nor are frames on a slow ramp: slope over +-RAMP_HALF frames >= segment.hmmRampSemitonesPerSec),
 *      and hmmSplitCost (nats, the stay/split prior) for every change of state. A change of state is a
 *      pitch boundary, moved back over the glide frames before it (the glide / scoop belongs to the new note). Rules
 *      4-6b then run unchanged (dip snap, dip splits for repeats, short notes, fragments).
 *   9b. Per-section tuning (pitch.localTuning): see config.ts; drift of the singer's pitch over the take is followed
 *      instead of one recording-wide offset (HumNote.cents is relative to the note's own offset; tuningCents in the
 *      result stays the global one).
 *  10b. Key prior (pitch.keyPrior, needs info.key; decision 6): the key's scale (major; minor = natural minor plus the
 *      raised 7th) only acts near a semitone boundary. (i) A note whose reading is out of the key, within
 *      keyPriorCents of the boundary (|cents| >= 50 - keyPriorCents), and whose nearer neighbour is in the key takes
 *      the neighbour; the original reading becomes the first candidate (confidence then 0: it is ambiguous). (ii)
 *      Candidates are ordered by confidence times 1 (in key) or KEY_OUT_FACTOR (out of key); their confidences are
 *      not changed. Notes farther from the boundary, and notes whose both readings are in (or out of) the key, keep
 *      their pitch.
 */
import { DEFAULT_HUM_CONFIG, type HumConfig } from './config';
import type { FrameF0Track, HumInfo, HumNote, PitchCandidate } from './types';

/* ------------------------------------------------------------------ rule constants
 * REF_FRAMES, SETTLE_FRAMES, JOIN_GAP_MS, VIB_WINDOW_MS, VIB_HYST are the defaults of cfg.segment.refFrames,
 * settleFrames, joinGapMs, vibratoWindowMs, vibratoSwingSemitones (T9); segmentFrames reads the config. */

/** Frames (~0.42 s, >= 2 vibrato periods) of the running note reference (rule 3). */
export const REF_FRAMES = 36;
/** Consecutive stable frames before a note has a reference pitch (rule 3). */
export const SETTLE_FRAMES = 3;
/** Max distance the pitch boundary moves back along the movement (rule 3), ms. */
export const MAX_BACK_MS = 70;
/** A frame-to-frame step smaller than this (semitones) ends the backtracking (rule 3). */
export const BACK_STEP = 0.02;
/** Backtracking also stops at a frame within this many semitones of the old reference (rule 3). */
export const BACK_NEAR = 0.2;
/** Unvoiced gaps up to this long without a level dip are f0 dropouts and joined (rule 1b), ms. */
export const JOIN_GAP_MS = 80;
/** Frames on each side of a gap whose loudest level is the edge level (rule 1b). */
export const EDGE_FRAMES = 3;
/** Vibrato test after a dip (rule 5): window (ms), swing size (semitones), number of alternating swings. */
export const VIB_WINDOW_MS = 200;
export const VIB_HYST = 0.15;
export const VIB_MIN_SWINGS = 2;
/** Dip snap search radius (rule 4), ms. */
export const SNAP_MS = 50;
/** Window for the maxima around a dip (rules 4, 5), ms. */
export const DIP_WINDOW_MS = 150;
/** Touching pitch-split notes closer than this (semitones) are merged (rule 6). */
export const MERGE_SEMITONES = 0.5;
/** Octave glitch: half window (frames) and tolerance (semitones) (rule 0). */
export const OCT_GLITCH_HALF = 8;
export const OCT_GLITCH_TOL = 1.5;
/** Octave fix (rule 8): far / near thresholds (semitones) and neighbour reach (s). */
export const OCT_FAR = 8;
export const OCT_NEAR = 5;
export const OCT_NEIGHBOUR_SEC = 1.5;
/** Base pitch uncertainty for the candidate probabilities (rule 10), cents. */
export const PITCH_SIGMA_CENTS = 20;
/** Confidence of an octave alternative candidate (rule 10). */
export const OCTAVE_FIXED_CONF = 0.3;
export const OCTAVE_ALT_CONF = 0.1;
/** Key prior (rule 10b): ordering weight of an out-of-key candidate. */
export const KEY_OUT_FACTOR = 0.5;

/* ------------------------------------------------------------------ helpers */

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function weightedMedian(xs: readonly number[], ws: readonly number[]): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const total = ws.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return median(xs);
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= total / 2) return xs[i];
  }
  return xs[idx[idx.length - 1]];
}

/** Seconds of a 16th note (beat = 64 / ts[1] ticks, a 16th = 4 ticks; quantize.ts beatGrid). */
export function sixteenthSec(info: Pick<HumInfo, 'bpm' | 'ts'>): number {
  const beatTicks = 64 / info.ts[1];
  return (4 * 60) / (info.bpm * beatTicks);
}

/** Maximal runs [a, b) of voiced frames. */
export function voicedRuns(track: FrameF0Track): [number, number][] {
  const out: [number, number][] = [];
  const n = track.hz.length;
  let i = 0;
  while (i < n) {
    if (!(track.voiced[i] >= 0.5 && track.hz[i] > 0)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && track.voiced[j] >= 0.5 && track.hz[j] > 0) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** Median filter of x over [a, b) with an odd width; the window shrinks symmetrically at the edges. */
export function medianSmooth(x: ArrayLike<number>, a: number, b: number, width: number, out: Float64Array): void {
  const h = Math.max(0, Math.floor(width / 2));
  for (let i = a; i < b; i++) {
    const r = Math.min(h, i - a, b - 1 - i);
    const w: number[] = [];
    for (let j = i - r; j <= i + r; j++) w.push(x[j]);
    out[i] = median(w);
  }
}

/** Rule 0: move octave glitches inside [a, b) of p (in place). Returns the number of frames moved. */
export function fixOctaveGlitches(p: Float64Array, a: number, b: number, half = OCT_GLITCH_HALF, tol = OCT_GLITCH_TOL): number {
  const orig = p.slice(a, b);
  let moved = 0;
  for (let i = a; i < b; i++) {
    const lo = Math.max(a, i - half);
    const hi = Math.min(b, i + half + 1);
    const w: number[] = [];
    for (let j = lo; j < hi; j++) w.push(orig[j - a]);
    const med = median(w);
    const d = orig[i - a] - med;
    const k = Math.round(d / 12);
    if (k !== 0 && Math.abs(d - 12 * k) <= tol) {
      p[i] = orig[i - a] - 12 * k;
      moved++;
    }
  }
  return moved;
}

/** Depth (dB) of the level minimum at m relative to the maxima on both sides within [lo, hi) and +-w frames. */
export function dipDepth(L: ArrayLike<number>, m: number, lo: number, hi: number, w: number): number {
  let left = -Infinity;
  let right = -Infinity;
  for (let j = Math.max(lo, m - w); j <= m; j++) left = Math.max(left, L[j]);
  for (let j = m; j < Math.min(hi, m + w + 1); j++) right = Math.max(right, L[j]);
  return Math.min(left, right) - L[m];
}

/* ------------------------------------------------------------------ level envelope */

/** Shortest / longest level window (s) and the number of f0 periods it spans (frameLevelDb). */
export const LEVEL_WIN_MIN_SEC = 0.01;
export const LEVEL_WIN_MAX_SEC = 0.032;
export const LEVEL_WIN_PERIODS = 2;

/**
 * The level envelope the dip rules use: mean square (dB, floor -100) of the audio y (any rate sr) over a window
 * CENTRED on each frame time t0 + i * hopSec, LEVEL_WIN_PERIODS periods of the frame's f0 long (so the pitch
 * ripple of a low voice averages out) clamped to [LEVEL_WIN_MIN_SEC, LEVEL_WIN_MAX_SEC]; unvoiced frames use the
 * minimum, so a short silent gap between notes shows as a dip. Shorter than f0.ts's levelDb (31 ms, starting half a YIN frame early), so 40-100 ms dips keep their depth.
 */
export function frameLevelDb(y: ArrayLike<number>, sr: number, track: FrameF0Track): number[] {
  const n = track.hz.length;
  const c = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) c[i + 1] = c[i] + y[i] * y[i];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const f = track.voiced[i] >= 0.5 ? track.hz[i] : 0;
    const w = f > 0 ? Math.min(LEVEL_WIN_MAX_SEC, Math.max(LEVEL_WIN_MIN_SEC, LEVEL_WIN_PERIODS / f)) : LEVEL_WIN_MIN_SEC;
    const centre = (track.t0 + i * track.hopSec) * sr;
    const lo = Math.max(0, Math.round(centre - (w * sr) / 2));
    const hi = Math.min(y.length, Math.round(centre + (w * sr) / 2));
    const ms = hi > lo ? (c[hi] - c[lo]) / (hi - lo) : 0;
    out[i] = ms > 1e-10 ? 10 * Math.log10(ms) : -100;
  }
  return out;
}

/**
 * True when the smoothed pitch right AFTER frame m (frames m .. m + w, inside [lo, hi)) oscillates: at least
 * VIB_MIN_SWINGS alternating up / down moves of >= VIB_HYST semitones each (a step between two notes is one swing).
 * Only the side after the dip: a new note starts without vibrato (the synth and singers start it >= 0.15 s in),
 * while the previous note may well have had vibrato. A dip less than w frames before the end of the note is tested
 * on the side before it instead (too little is left after it to see the vibrato). A loudness dip there is the amplitude
 * modulation that vibrato makes through the vowel's formants, not a new note (rule 5).
 */
export function vibratoAround(s: ArrayLike<number>, m: number, lo: number, hi: number, w: number, hyst: number = VIB_HYST): boolean {
  // After the dip; when the note ends before the window does, the window before the dip instead.
  const after = hi - m > w;
  const a = after ? m : Math.max(lo, m - w);
  const b = after ? m + w + 1 : m + 1;
  // Count swings: monotone moves of >= VIB_HYST, alternating in direction (hysteresis on the running extreme).
  let swings = 0;
  let dir = 0;
  let hiX = s[a];
  let loX = s[a];
  for (let i = a + 1; i < b; i++) {
    const x = s[i];
    hiX = Math.max(hiX, x);
    loX = Math.min(loX, x);
    if (dir <= 0 && x - loX >= hyst) {
      swings++;
      dir = 1;
      hiX = x;
    } else if (dir >= 0 && hiX - x >= hyst) {
      swings++;
      dir = -1;
      loX = x;
    }
  }
  return swings >= VIB_MIN_SWINGS;
}

/* ------------------------------------------------------------------ rule 1 */

/**
 * Rule 1b: voiced runs separated by an unvoiced gap of <= maxGap frames in which the level does NOT dip (it stays
 * within maxDipDb of the lower edge level) are one run: the f0 tracker lost a fast glide, the singer did not stop.
 * The gap gets a linear pitch (in semitones) between the edge frames of p (in place). A gap with a dip ("ta"
 * closure, breath) keeps the runs apart.
 */
export function joinDropouts(runs: [number, number][], p: Float64Array, L: ArrayLike<number>, maxGap: number, maxDipDb: number): [number, number][] {
  const out: [number, number][] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] <= maxGap) {
      const b1 = last[1];
      const a2 = r[0];
      // Edge levels: the loudest of the EDGE_FRAMES frames on each side (an edge frame can already be in the gap).
      let e1 = -Infinity;
      let e2 = -Infinity;
      for (let i = Math.max(last[0], b1 - EDGE_FRAMES); i < b1; i++) e1 = Math.max(e1, L[i]);
      for (let i = a2; i < Math.min(r[1], a2 + EDGE_FRAMES); i++) e2 = Math.max(e2, L[i]);
      const edge = Math.min(e1, e2);
      let low = Infinity;
      for (let i = b1; i < a2; i++) low = Math.min(low, L[i]);
      if (low >= edge - maxDipDb) {
        const x0 = p[b1 - 1];
        const x1 = p[a2];
        for (let i = b1; i < a2; i++) p[i] = x0 + ((x1 - x0) * (i - b1 + 1)) / (a2 - b1 + 1);
        last[1] = r[1];
        continue;
      }
    }
    out.push([r[0], r[1]]);
  }
  return out;
}

/* ------------------------------------------------------------------ rule 3 */

export interface PitchSplitParams {
  moveSemitones: number;
  minMoveFrames: number;
  refFrames: number;
  maxBackFrames: number;
  /** Consecutive stable frames before a reference exists (default SETTLE_FRAMES). */
  settleFrames?: number;
  /** Rule 3b: plateau length (frames, 0 = off), its max range (semitones) and the wait before splitting anyway (frames). */
  plateauFrames?: number;
  plateauSemitones?: number;
  plateauWaitFrames?: number;
  /** Rule 3b: only an old side within this many semitones of the new pitch can be a ramp (scoop / portamento). */
  scoopMaxSemitones?: number;
}

/** True when s has plateau frames in a row within [lo, hi) whose range (max - min) is <= range (rule 3b). */
export function hasPlateau(s: ArrayLike<number>, lo: number, hi: number, frames: number, range: number): boolean {
  if (frames <= 1) return hi - lo >= 1;
  for (let a = lo; a + frames <= hi; a++) {
    let mn = Infinity;
    let mx = -Infinity;
    let ok = true;
    for (let j = a; j < a + frames; j++) {
      mn = Math.min(mn, s[j]);
      mx = Math.max(mx, s[j]);
      if (mx - mn > range) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Pitch boundaries (frame indices in (a, b)) inside one voiced run of the smoothed pitch s. The reference of a
 * note only exists once the pitch has settled: SETTLE_FRAMES consecutive stable frames (from the run start, or
 * from the frame that triggered the previous split). The median of the last refFrames frames from there is the
 * reference (all frames, so a vibrato around it averages out). Until then nothing can split, which keeps a scoop
 * at a phrase start and the rest of a glide from splitting again.
 */
export function pitchSplits(s: ArrayLike<number>, stable: ArrayLike<boolean>, a: number, b: number, P: PitchSplitParams): number[] {
  const out: number[] = [];
  let seg = a;
  let from = a;
  let refStart = -1;
  let k = -1;
  let sign = 0;
  let ref = NaN;
  const settle = P.settleFrames ?? SETTLE_FRAMES;
  const plat = P.plateauFrames ?? 0;
  const platR = P.plateauSemitones ?? 0.3;
  const platWait = P.plateauWaitFrames ?? Infinity;
  const scoopMax = P.scoopMaxSemitones ?? Infinity;
  let iNow = a;
  const refOf = (lo: number, hi: number): number => {
    const w: number[] = [];
    for (let j = hi - 1; j >= lo && w.length < P.refFrames; j--) w.push(s[j]);
    return w.length ? median(w) : NaN;
  };
  for (let i = a; i < b; i++) {
    iNow = i;
    if (refStart < 0) {
      let ok = i - settle + 1 >= from;
      for (let j = i - settle + 1; ok && j <= i; j++) ok = stable[j];
      if (ok) refStart = i - settle + 1;
      continue;
    }
    if (k < 0) ref = refOf(refStart, i);
    const d = s[i] - ref;
    if (Math.abs(d) >= P.moveSemitones) {
      const sg = Math.sign(d);
      if (plat > 0 && k >= 0 && sg !== sign && i - k >= P.minMoveFrames && oldStable()) {
        // rule 3b: a deviation still waiting for its plateau jumps to the other side (the next note came before the
        // plateau, or an f0 glitch): it was a note
        // the waited part is the new note: it is the reference, and this frame starts a deviation from it
        const k0 = k;
        split();
        refStart = k0;
        ref = refOf(k0, i);
        k = i;
        sign = sg;
        continue;
      }
      if (k < 0 || sg !== sign) {
        k = i;
        sign = sg;
      }
      if (i - k + 1 >= P.minMoveFrames) {
        if (plat > 0) {
          // rule 3b: the new side must plateau while it deviates (or deviate for platWait frames) ...
          if (!hasPlateau(s, k, i + 1, plat, platR) && i - k + 1 < platWait) continue;
          // ... and the old side must have had a stable pitch since this note's start; else it was a ramp into this one
          if (!oldStable()) {
            from = k;
            refStart = -1;
            k = -1;
            continue;
          }
        }
        split();
      }
    } else {
      k = -1;
    }
  }
  // rule 3b: a deviation still waiting for its plateau when the run ends (a short last note) splits if the old side
  // had a stable pitch; a short drifted note end split off this way is merged back by rule 6b
  if (plat > 0 && k >= 0 && b - k >= P.minMoveFrames && oldStable()) split();
  return out;

  /** The note before the deviation was a note, not a ramp: it has a plateau, lasted platWait frames (vibrato), or
   *  lies more than scoopMax semitones from the pitch now (a scoop / portamento is a small approach). */
  function oldStable(): boolean {
    if (k - seg >= platWait || hasPlateau(s, seg, k, plat, platR)) return true;
    const w: number[] = [];
    for (let j = seg; j < k; j++) if (Number.isFinite(s[j])) w.push(s[j]);
    return w.length > 0 && Math.abs(s[Math.min(b - 1, Math.max(k, iNow))] - median(w)) > scoopMax;
  }

  function split(): void {
    let j = k;
    while (j - 1 > seg && k - (j - 1) <= P.maxBackFrames && sign * (s[j] - s[j - 1]) > BACK_STEP && sign * (s[j - 1] - ref) > BACK_NEAR) j--;
    const boundary = Math.max(seg + 1, j);
    out.push(boundary);
    seg = boundary;
    from = k;
    // rule 3b waited for the new pitch to be stable: it is the new reference at once (with plateauFrames = 0 the
    // reference waits for SETTLE_FRAMES stable frames, as before)
    refStart = plat > 0 && iNow - k + 1 >= plat ? k : -1;
    k = -1;
  }
}

/* ------------------------------------------------------------------ rule 3h (note HMM switch) */

export interface HmmParams {
  splitCost: number;
  sigma: number;
  outlierCost: number;
  /** Tuning offset of the state centres, semitones (state k sits at k + offset). */
  offset: number;
}

/**
 * Rule 3h: pitch boundaries (frame indices in (a, b)) of one voiced run by a Viterbi path over semitone states.
 * Stable frames cost min((s - centre)^2 / (2 sigma^2), outlierCost), glide frames 0, a change of state splitCost.
 * Each change of state becomes a boundary moved back over the glide frames right before it.
 */
export function hmmSplits(s: ArrayLike<number>, stable: ArrayLike<boolean>, a: number, b: number, H: HmmParams): number[] {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = a; i < b; i++) if (Number.isFinite(s[i])) {
    mn = Math.min(mn, s[i]);
    mx = Math.max(mx, s[i]);
  }
  if (!(mx >= mn) || b - a < 2) return [];
  const lo = Math.floor(mn - H.offset) - 1;
  const K = Math.ceil(mx - H.offset) + 1 - lo + 1;
  const n = b - a;
  const back = new Int32Array(n * K); // predecessor state per frame and state
  let D = new Float64Array(K);
  let E = new Float64Array(K);
  const inv = 1 / (2 * H.sigma * H.sigma);
  const cost = (i: number, k: number) => {
    if (!stable[i] || !Number.isFinite(s[i])) return 0;
    const d = s[i] - (lo + k + H.offset);
    return Math.min(d * d * inv, H.outlierCost);
  };
  for (let k = 0; k < K; k++) D[k] = cost(a, k);
  for (let t = 1; t < n; t++) {
    let best = 0;
    for (let k = 1; k < K; k++) if (D[k] < D[best]) best = k;
    const sw = D[best] + H.splitCost;
    for (let k = 0; k < K; k++) {
      const stay = D[k];
      // ties stay
      if (stay <= sw) {
        E[k] = stay;
        back[t * K + k] = k;
      } else {
        E[k] = sw;
        back[t * K + k] = best;
      }
      E[k] += cost(a + t, k);
    }
    [D, E] = [E, D];
  }
  let k = 0;
  for (let j = 1; j < K; j++) if (D[j] < D[k]) k = j;
  const path = new Int32Array(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = k;
    if (t > 0) k = back[t * K + k];
  }
  const out: number[] = [];
  let segStart = a;
  for (let t = 1; t < n; t++) {
    if (path[t] === path[t - 1]) continue;
    let j = a + t;
    while (j - 1 > segStart && !stable[j - 1]) j--;
    const bd = Math.max(segStart + 1, j);
    if (bd < b && (out.length === 0 || bd > out[out.length - 1])) {
      out.push(bd);
      segStart = bd;
    }
  }
  return out;
}

/** Rule 3h: stable frames whose slope over +-RAMP_HALF frames (inside the run) is below maxStep per frame (0 = all). */
export const RAMP_HALF = 3;
function rampFree(s: ArrayLike<number>, stable: boolean[], runs: [number, number][], maxStep: number): boolean[] {
  if (!(maxStep > 0)) return stable;
  const out = stable.slice();
  for (const [a, b] of runs) {
    for (let i = a; i < b; i++) {
      if (!out[i]) continue;
      const lo = Math.max(a, i - RAMP_HALF);
      const hi = Math.min(b - 1, i + RAMP_HALF);
      if (hi > lo && Math.abs(s[hi] - s[lo]) / (hi - lo) >= maxStep) out[i] = false;
    }
  }
  return out;
}

/** Frame tuning offset (semitones, in [-0.5, 0.5)) of the stable smoothed frames, for the HMM state centres. */
function frameTuning(s: ArrayLike<number>, stable: ArrayLike<boolean>): number {
  const xs: number[] = [];
  for (let i = 0; i < s.length; i++) if (stable[i] && Number.isFinite(s[i])) xs.push(s[i]);
  return estimateTuning(xs) / 100;
}

/* ------------------------------------------------------------------ segmentation */

export type BoundaryCause = 'run' | 'pitch' | 'dip';

export interface Segment {
  /** Frames [a, b). */
  a: number;
  b: number;
  /** What made the boundary at `a`. */
  cause: BoundaryCause;
  /** Frames [pa, pb) the pitch is taken from when a fragment was merged in (rule 6b); default [a, b). */
  pa?: number;
  pb?: number;
}

export interface SegmentDebug {
  segments: Segment[];
  /** Raw pitch per frame after rule 0 (NaN unvoiced) and the smoothed one. */
  pitch: Float64Array;
  smooth: Float64Array;
  stable: boolean[];
  octaveGlitchFrames: number;
}

/** Rules 0-6: note segments (frames) of a track. */
export function segmentFrames(track: FrameF0Track, levelDb: ArrayLike<number>, info: Pick<HumInfo, 'bpm' | 'ts'>, cfg: HumConfig = DEFAULT_HUM_CONFIG): SegmentDebug {
  const n = track.hz.length;
  if (levelDb.length !== n) throw new RangeError(`levelDb has ${levelDb.length} frames, track ${n}`);
  const hop = track.hopSec;
  const sc = cfg.segment;
  const runs0 = voicedRuns(track);
  const p = new Float64Array(n).fill(NaN);
  for (const [a, b] of runs0) for (let i = a; i < b; i++) p[i] = hzToMidi(track.hz[i]);
  let octaveGlitchFrames = 0;
  if (cfg.pitch.octaveFix) for (const [a, b] of runs0) octaveGlitchFrames += fixOctaveGlitches(p, a, b);
  const L = Float64Array.from(levelDb);
  const runs = joinDropouts(runs0, p, L, Math.round(sc.joinGapMs / 1000 / hop), sc.dipDb / 2);
  const s = new Float64Array(n).fill(NaN);
  for (const [a, b] of runs) medianSmooth(p, a, b, sc.medianFrames, s);
  const stable = new Array<boolean>(n).fill(false);
  const maxStep = sc.glideSemitonesPerSec * hop;
  for (const [a, b] of runs) {
    for (let i = a; i < b; i++) {
      const lo = Math.max(a, i - 1);
      const hi = Math.min(b - 1, i + 1);
      const slope = hi > lo ? (s[hi] - s[lo]) / (hi - lo) : 0;
      stable[i] = Math.abs(slope) < maxStep;
    }
  }
  const minF = Math.max(1, (sc.minNoteSixteenths * sixteenthSec(info)) / hop);
  const P: PitchSplitParams = {
    moveSemitones: sc.moveSemitones,
    minMoveFrames: Math.max(1, Math.round(sc.minMoveMs / 1000 / hop)),
    refFrames: sc.refFrames,
    maxBackFrames: Math.round(MAX_BACK_MS / 1000 / hop),
    settleFrames: sc.settleFrames,
    // capped at plateauMaxSixteenths of a 16th so a real fast 16th can still be a note
    plateauFrames: sc.plateauFrames > 0 ? Math.min(sc.plateauFrames, Math.max(3, Math.round((sc.plateauMaxSixteenths * sixteenthSec(info)) / hop))) : 0,
    plateauSemitones: sc.plateauSemitones,
    plateauWaitFrames: Math.max(1, Math.round(sc.plateauWaitMs / 1000 / hop)),
    scoopMaxSemitones: sc.scoopMaxSemitones,
  };
  const H: HmmParams | null = sc.noteHmm ? { splitCost: sc.hmmSplitCost, sigma: sc.hmmSigmaSemitones, outlierCost: sc.hmmOutlierCost, offset: frameTuning(s, stable) } : null;
  // rule 3h: frames on a slow ramp (scoop, portamento slower than the glide threshold) are not informative either
  const inform = H ? rampFree(s, stable, runs, sc.hmmRampSemitonesPerSec * hop) : stable;
  const snapF = Math.round(SNAP_MS / 1000 / hop);
  const dipW = Math.round(DIP_WINDOW_MS / 1000 / hop);
  const vibW = Math.round(sc.vibratoWindowMs / 1000 / hop);

  let segs: Segment[] = [];
  for (const [a, b] of runs) {
    // rule 3 + 4
    const cuts: { at: number; cause: BoundaryCause }[] = [];
    let prev = a;
    const ps = H ? hmmSplits(s, inform, a, b, H) : pitchSplits(s, stable, a, b, P);
    ps.forEach((m, idx) => {
      const next = idx + 1 < ps.length ? ps[idx + 1] : b;
      let best = m;
      let bestL = Infinity;
      for (let j = Math.max(prev + 1, m - snapF); j <= Math.min(next - 1, m + snapF); j++) {
        if (L[j] < bestL && L[j] <= L[j - 1] && L[j] <= L[j + 1]) {
          bestL = L[j];
          best = j;
        }
      }
      if (best !== m && dipDepth(L, best, a, b, dipW) < sc.dipDb / 2) best = m;
      cuts.push({ at: best, cause: 'pitch' });
      prev = best;
    });
    // rule 5
    const bounds = [a, ...cuts.map((c) => c.at), b];
    const causes: BoundaryCause[] = ['run', ...cuts.map((c) => c.cause)];
    const runSegs: Segment[] = [];
    for (let q = 0; q + 1 < bounds.length; q++) {
      const sa = bounds[q];
      const sb = bounds[q + 1];
      const dips: number[] = [];
      if (sc.splitOnDips && sb - sa >= 2 * minF) {
        const cand: { m: number; depth: number }[] = [];
        for (let m = Math.ceil(sa + minF); m <= Math.floor(sb - minF); m++) {
          if (!(L[m] <= L[m - 1] && L[m] < L[m + 1])) continue;
          const depth = dipDepth(L, m, sa, sb, dipW);
          if (depth >= sc.dipDb && !vibratoAround(s, m, sa, sb, vibW, sc.vibratoSwingSemitones)) cand.push({ m, depth });
        }
        cand.sort((x, y) => y.depth - x.depth);
        for (const c of cand) if ([sa, sb, ...dips].every((d) => Math.abs(d - c.m) >= minF)) dips.push(c.m);
        dips.sort((x, y) => x - y);
      }
      const pts = [sa, ...dips, sb];
      for (let r = 0; r + 1 < pts.length; r++) runSegs.push({ a: pts[r], b: pts[r + 1], cause: r === 0 ? causes[q] : 'dip' });
    }
    segs.push(...runSegs);
  }

  // rule 6
  const med = (g: Segment) => {
    const lo = g.pa ?? g.a;
    const hi = g.pb ?? g.b;
    const w: number[] = [];
    for (let i = lo; i < hi; i++) if (stable[i] && Number.isFinite(s[i])) w.push(s[i]);
    if (w.length === 0) for (let i = lo; i < hi; i++) if (Number.isFinite(s[i])) w.push(s[i]);
    return median(w);
  };
  for (;;) {
    let idx = -1;
    for (let q = 0; q < segs.length; q++) if (segs[q].b - segs[q].a < minF && (idx < 0 || segs[q].b - segs[q].a < segs[idx].b - segs[idx].a)) idx = q;
    if (idx < 0) break;
    const g = segs[idx];
    const pv = idx > 0 && segs[idx - 1].b === g.a ? segs[idx - 1] : null;
    const nx = idx + 1 < segs.length && segs[idx + 1].a === g.b ? segs[idx + 1] : null;
    if (!pv && !nx) {
      segs.splice(idx, 1);
      continue;
    }
    const mg = med(g);
    // A short piece between two notes whose pitch lies between theirs is the glide into the next note: it
    // belongs to the next note's onset. Otherwise it joins the neighbour with the closer pitch.
    const between = pv && nx && (med(pv) - mg) * (mg - med(nx)) > 0;
    const usePrev = pv && !between && (!nx || Math.abs(med(pv) - mg) <= Math.abs(med(nx) - mg));
    if (usePrev) {
      pv!.b = g.b;
      segs.splice(idx, 1);
    } else {
      nx!.a = g.a;
      nx!.cause = g.cause;
      segs.splice(idx, 1);
    }
  }
  // rule 6b
  if (sc.fragmentMs > 0) segs = mergeFragments(segs, med, Math.round(sc.fragmentMs / 1000 / hop), Math.round(sc.fragmentGapMs / 1000 / hop), sc.fragmentSemitones);
  const merged: Segment[] = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && last.b === g.a && g.cause === 'pitch' && Math.abs(med(last) - med(g)) < MERGE_SEMITONES) {
      // keep a pitch range from 6b on the longer part
      if (last.pa !== undefined || g.pa !== undefined) {
        const lr = (last.pb ?? last.b) - (last.pa ?? last.a);
        const gr = (g.pb ?? g.b) - (g.pa ?? g.a);
        const src = lr >= gr ? last : g;
        [last.pa, last.pb] = [src.pa ?? src.a, src.pb ?? src.b];
      }
      last.b = g.b;
    } else merged.push({ ...g });
  }
  segs = merged;
  return { segments: segs, pitch: p, smooth: s, stable, octaveGlitchFrames };
}

/**
 * Rule 6b: merge short fragments (< maxF frames) into a longer neighbour that is (almost) touching (gap <= maxGap
 * frames, boundary not from a level dip) and <= maxSemitones away in median pitch. The merged note keeps the pitch
 * range of the longer part. Shortest fragment first, the closer-pitched neighbour first. Returns a new array.
 */
export function mergeFragments(segs0: readonly Segment[], med: (g: Segment) => number, maxF: number, maxGap: number, maxSemitones: number): Segment[] {
  const segs = segs0.map((g) => ({ ...g }));
  const len = (g: Segment) => g.b - g.a;
  const prange = (g: Segment): [number, number] => [g.pa ?? g.a, g.pb ?? g.b];
  const blocked = new Set<Segment>();
  for (;;) {
    let idx = -1;
    for (let q = 0; q < segs.length; q++) if (!blocked.has(segs[q]) && len(segs[q]) < maxF && (idx < 0 || len(segs[q]) < len(segs[idx]))) idx = q;
    if (idx < 0) break;
    const g = segs[idx];
    const mg = med(g);
    const opts: { nb: Segment; side: -1 | 1; d: number }[] = [];
    const pv = idx > 0 ? segs[idx - 1] : null;
    const nx = idx + 1 < segs.length ? segs[idx + 1] : null;
    if (pv && g.a - pv.b <= maxGap && g.cause !== 'dip' && len(pv) > len(g)) opts.push({ nb: pv, side: -1, d: Math.abs(med(pv) - mg) });
    if (nx && nx.a - g.b <= maxGap && nx.cause !== 'dip' && len(nx) > len(g)) opts.push({ nb: nx, side: 1, d: Math.abs(med(nx) - mg) });
    const ok = opts.filter((o) => o.d <= maxSemitones).sort((x, y) => x.d - y.d);
    if (ok.length === 0) {
      blocked.add(g);
      continue;
    }
    const { nb, side } = ok[0];
    const [pa, pb] = prange(nb);
    if (side === -1) nb.b = g.b;
    else {
      nb.a = g.a;
      nb.cause = g.cause;
    }
    nb.pa = pa;
    nb.pb = pb;
    segs.splice(idx, 1);
  }
  return segs;
}

/* ------------------------------------------------------------------ pitch */

/** Rule 7: note pitch (semitones) and the spread (semitones, MAD-based) of the frames used. */
export function notePitch(p: ArrayLike<number>, stable: ArrayLike<boolean>, a: number, b: number, trimFraction: number): { pitch: number; spread: number } {
  let w: number[] = [];
  for (let i = a; i < b; i++) if (stable[i] && Number.isFinite(p[i])) w.push(p[i]);
  if (w.length < 3) {
    w = [];
    for (let i = a; i < b; i++) if (Number.isFinite(p[i])) w.push(p[i]);
  }
  const t = Math.floor(w.length * trimFraction);
  const core = w.length - 2 * t >= 1 ? w.slice(t, w.length - t) : w;
  const m = median(core);
  const mad = median(core.map((x) => Math.abs(x - m)));
  return { pitch: m, spread: 1.4826 * mad };
}

/** Rule 9: recording-wide tuning offset in cents, in [-50, 50). */
export function estimateTuning(pitches: readonly number[], weights?: readonly number[]): number {
  if (pitches.length === 0) return 0;
  const ws = weights ?? pitches.map(() => 1);
  let t = 0;
  for (let it = 0; it < 3; it++) {
    const dev = pitches.map((q) => {
      const x = q - t / 100;
      return (x - Math.round(x)) * 100;
    });
    t += weightedMedian(dev, ws);
  }
  t = ((((t + 50) % 100) + 100) % 100) - 50;
  return t;
}

/** Rule 10: probabilities of the semitones k-1, k, k+1 for a pitch q (tuning removed) and sigma (cents). */
export function semitoneProbs(q: number, sigmaCents: number): { midi: number; p: number }[] {
  const k = Math.round(q);
  const s = sigmaCents / 100;
  const raw = [k - 1, k, k + 1].map((m) => ({ midi: m, p: Math.exp(-((q - m) ** 2) / (2 * s * s)) }));
  const tot = raw.reduce((a, r) => a + r.p, 0);
  return raw.map((r) => ({ midi: r.midi, p: r.p / tot })).sort((x, y) => y.p - x.p);
}

/** Rule 10b: pitch classes of a key ('C', 'F#', 'Bb', 'Am', 'C#m', 'Ebmin'; minor = natural minor + raised 7th), or
 *  null when the key cannot be read. */
export function keyPitchClasses(key: string | undefined): Set<number> | null {
  if (!key) return null;
  const m = /^\s*([A-Ga-g])([#♯b♭]?)\s*(m|min|minor|maj|major|)\s*$/.exec(key.normalize('NFKC'));
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const tonic = (base + acc + 12) % 12;
  const minor = m[3] === 'm' || m[3] === 'min' || m[3] === 'minor';
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(steps.map((d) => (tonic + d) % 12));
}

/** Rule 9b: per-note tuning offsets (cents) from the other notes within +-windowSec / 2 (see config.ts localTuning). */
export function localTunings(pitches: readonly number[], centres: readonly number[], weights: readonly number[], globalCents: number, windowSec: number, minNotes: number): number[] {
  return pitches.map((_, i) => {
    const idx: number[] = [];
    for (let j = 0; j < pitches.length; j++) if (j !== i && Math.abs(centres[j] - centres[i]) <= windowSec / 2) idx.push(j);
    if (idx.length < minNotes) return globalCents;
    let t = globalCents;
    for (let it = 0; it < 2; it++) {
      const dev = idx.map((j) => {
        const x = pitches[j] - t / 100;
        return (x - Math.round(x)) * 100;
      });
      t += weightedMedian(dev, idx.map((j) => weights[j]));
    }
    return t;
  });
}

/* ------------------------------------------------------------------ top level */

export interface NotesResult {
  notes: HumNote[];
  /** Recording-wide tuning offset removed (cents). */
  tuningCents: number;
  warnings: string[];
  /** Frames moved by the octave glitch rule, notes moved by the octave fix. */
  stats: { octaveGlitchFrames: number; octaveFixedNotes: number; segments: number };
}

/** Rules 0-10: notes of a frame f0 track (see the header). */
export function extractNotes(track: FrameF0Track, levelDb: ArrayLike<number>, info: Pick<HumInfo, 'bpm' | 'ts' | 'key'>, cfg: HumConfig = DEFAULT_HUM_CONFIG): NotesResult {
  const warnings: string[] = [];
  const scale = cfg.pitch.keyPrior ? keyPitchClasses(info.key) : null;
  if (cfg.pitch.keyPrior && !scale) warnings.push(info.key ? 'pitch.keyPrior: the key could not be read; candidates not reordered' : 'pitch.keyPrior: no key given; candidates not reordered');
  const seg = segmentFrames(track, levelDb, info, cfg);
  const hop = track.hopSec;
  const t = (i: number) => track.t0 + i * hop;
  const pc = cfg.pitch;
  const raw = seg.segments.map((g) => ({ g, ...notePitch(seg.pitch, seg.stable, g.pa ?? g.a, g.pb ?? g.b, pc.trimFraction) }));
  if (raw.length === 0) warnings.push('no voiced frames');

  // rule 8
  const six = sixteenthSec(info);
  const fixed: (number | null)[] = raw.map(() => null);
  const pitches = raw.map((r) => r.pitch);
  if (pc.octaveFix) {
    raw.forEach((r, i) => {
      const dur = (r.g.b - r.g.a) * hop;
      if (dur > pc.octaveFixMaxSixteenths * six + 1e-9) return;
      const nbs: number[] = [];
      if (i > 0 && (r.g.a - raw[i - 1].g.b) * hop <= OCT_NEIGHBOUR_SEC) nbs.push(raw[i - 1].pitch);
      if (i + 1 < raw.length && (raw[i + 1].g.a - r.g.b) * hop <= OCT_NEIGHBOUR_SEC) nbs.push(raw[i + 1].pitch);
      if (nbs.length < 2) return;
      for (const sh of [12, -12]) {
        const alt = r.pitch + sh;
        if (nbs.every((x) => Math.abs(r.pitch - x) >= OCT_FAR && Math.abs(alt - x) <= OCT_NEAR)) {
          fixed[i] = r.pitch;
          pitches[i] = alt;
          break;
        }
      }
    });
  }

  // rule 9
  const tuningCents = pc.tuning ? estimateTuning(pitches, raw.map((r) => r.g.b - r.g.a)) : 0;
  // rule 9b
  const noteTuning =
    pc.tuning && pc.localTuning
      ? localTunings(pitches, raw.map((r) => t((r.g.a + r.g.b - 1) / 2)), raw.map((r) => r.g.b - r.g.a), tuningCents, pc.localTuningSec, pc.localTuningMinNotes)
      : raw.map(() => tuningCents);
  const inKey = (m: number) => !scale || scale.has(((m % 12) + 12) % 12);

  // rule 10
  const notes: HumNote[] = raw.map((r, i) => {
    const tc = noteTuning[i];
    const q = pitches[i] - tc / 100;
    const sigma = Math.min(50, Math.hypot(PITCH_SIGMA_CENTS, 100 * r.spread / Math.sqrt(Math.max(1, (r.g.b - r.g.a) / 4))));
    const probs = semitoneProbs(q, sigma);
    const near = Math.round(q);
    const nearCents = (q - near) * 100;
    // rule 10b (i): an out-of-key reading next to the boundary takes the in-key neighbour
    const other = near + (q >= near ? 1 : -1);
    const swapped = !!scale && Math.abs(nearCents) >= 50 - pc.keyPriorCents && !inKey(near) && inKey(other);
    const midi = swapped ? other : near;
    const cents = Math.round((q - midi) * 1000) / 10;
    const cands: PitchCandidate[] = [];
    const nearer = probs.find((x) => x.midi === (swapped ? near : other))!;
    if (swapped || Math.abs(nearCents) >= 50 - pc.boundaryCents) cands.push({ midi: nearer.midi, confidence: round3(nearer.p) });
    if (fixed[i] !== null) {
      cands.push({ midi: Math.round(fixed[i]! - tc / 100), confidence: OCTAVE_FIXED_CONF, octaveFixed: true });
    } else {
      const nbs: number[] = [];
      if (i > 0) nbs.push(pitches[i - 1]);
      if (i + 1 < raw.length) nbs.push(pitches[i + 1]);
      if (nbs.length && nbs.every((x) => Math.abs(pitches[i] - x) >= OCT_FAR)) {
        const ctx = median(nbs);
        cands.push({ midi: midi + (ctx > pitches[i] ? 12 : -12), confidence: OCTAVE_ALT_CONF });
      }
    }
    // rule 10b (ii): out-of-key candidates sort after in-key ones (ordering weight only)
    const ord = (c: PitchCandidate) => c.confidence * (inKey(c.midi) ? 1 : KEY_OUT_FACTOR);
    cands.sort((x, y) => ord(y) - ord(x) || y.confidence - x.confidence);
    const best = probs.find((x) => x.midi === midi)!.p;
    const second = Math.max(0, ...cands.map((c) => c.confidence), probs.filter((x) => x.midi !== midi)[0].p);
    return {
      start: r4(t(r.g.a) - hop / 2),
      end: r4(t(r.g.b - 1) + hop / 2),
      midi,
      cents,
      confidence: round3(Math.max(0, Math.min(1, best - second))),
      candidates: cands.slice(0, pc.candidatesMax),
    };
  });
  return {
    notes,
    tuningCents: Math.round(tuningCents * 10) / 10,
    warnings,
    stats: { octaveGlitchFrames: seg.octaveGlitchFrames, octaveFixedNotes: fixed.filter((x) => x !== null).length, segments: seg.segments.length },
  };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
