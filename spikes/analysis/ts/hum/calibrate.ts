/**
 * Spike 4 look point 2: per-user CALIBRATION trial (docs/audio-spike4-plan.md, 「見る時点 ① の後の決定」: the user's idea).
 *
 * The user hums ONE short known phrase once (here: one dev take with its known melody). From the analyzer's frame f0
 * and the known notes we measure a few traits of the VOICE (not of the song) and map them, by a fixed rule written
 * below, to config overrides of the humming analyzer. No model is trained; nothing is fitted to evaluation takes.
 *
 *   measureVoiceTraits(track, known, grid)  -> VoiceTraits (cents / ms / fractions; no pitch, no note sequence)
 *   calibrationOverrides(traits)            -> partial HumConfig overrides (resolveHumConfig input)
 *
 * Alignment (the known score vs. the voice): the given bar-1 head is approximate (like the user's 開始) and the singer
 * may sing in another key / octave, so one constant time shift tau (+-ALIGN_RANGE_BEATS beats, 10 ms steps) and one
 * whole-semitone transposition d are searched jointly: the pair that puts the most voiced frames of the notes' middles
 * (MID_FROM..MID_TO of each note) on round(p - midi) = d wins (ties: smaller |tau|). The tuning offset is then the
 * median of (p - midi - d) over those frames. d is used internally only and never returned (privacy: the
 * transposition of a recording is not reported).
 *
 * Traits (per known note k, target q_k = midi_k + d + tuning; aligned onset on_k, length dur_k):
 *   tuningCents        median offset from the equal-tempered target (what pitch.tuning removes anyway; info only)
 *   intraSpreadCents   robust sigma (1.4826 MAD) of the middle frames around each note's own median (vibrato + wander)
 *   wobbleCents        median over notes >= LONG_NOTE_SEC of the half range (P90 - P10) / 2 of the middle frames
 *   noteSigmaCents     robust sigma of the per-note medians around their targets (how exactly notes are hit)
 *   scoopDepthSemitones P90 over the notes that start a voiced run (an unvoiced frame right before the approach,
 *                      inside the window from on_k - PRE_SEC) of the approach depth: from the first frame within
 *                      ARRIVE_SEMITONES of the note's median (the arrival) back over the contiguous voiced frames before
 *                      it, the maximum of (median - p) (0 = no approach from below). These are the onset scoops that
 *                      rule 3b (segment.scoopMaxSemitones) has to recognise; legato portamenti are not counted.
 *   scoopMs            P75 of the approach durations of those notes with depth >= 0.3 semitone
 *   scoopRate          fraction of those notes with depth >= 0.5 semitone (info only)
 *                      (the three scoop traits are NaN with fewer than MIN_SCOOPS voiced-run starts)
 *   onsetBiasMs        median of (approach start - grid onset), the grid moved by tau rounded to whole 16ths; info only:
 *                      with an approximate start (開始) it mixes the start error into the voice, so it is not mapped
 *   onsetScatterMs     1.4826 MAD of the same deviations (info only)
 *
 * Mapping rule (fixed; the reference voice REF_TRAITS = medians of these traits on the synthetic H4 TUNING split with
 * hum-v3 (out/hum/r3/syn-traits.json), the roughest voice the defaults were tuned for, so REF maps to the defaults).
 * The segmentation keys only move AWAY from the defaults toward a rougher voice (never below them): on the synthetic
 * tuning split, lowering them for steadier voices (H3) cost J -0.02 (moveSemitones 0.4), so the floor is the default.
 *   segment.scoopMaxSemitones = clamp(1.5 + (scoopDepth - REF.scoopDepth), 1.5, 3.0)
 *   segment.fragmentMs        = clamp(130 + (scoopMs - REF.scoopMs), 130, 250)
 *   segment.moveSemitones     = clamp(0.5 + (wobble - REF.wobble) / 100, 0.5, 0.8)
 *   pitch.boundaryCents       = clamp(20 + 0.5 (noteSigma - REF.noteSigma), 10, 40)   (candidates only)
 * Values are rounded (0.05 semitone, 10 ms, 1 cent) so tiny trait noise does not change the config.
 * A calibration with too few usable notes (< MIN_NOTES) returns no overrides.
 *
 * Privacy: VoiceTraits holds only voice measures (cents / ms / fractions / counts); callers must not print the
 * known notes. No network, no DOM.
 */
import { WHOLE_TICKS, type FrameF0Track } from './types';

export interface KnownNote {
  startTick: number;
  ticks: number;
  midi: number;
}

/** What the user / the calibration phrase gives: tempo, time signature and the (approximate) bar-1 head. */
export interface CalibrationGrid {
  bpm: number;
  ts: [number, number];
  startSec: number;
}

export interface VoiceTraits {
  /** Known notes with enough middle frames, and the fraction of all middle frames on the aligned target. */
  nNotes: number;
  coverage: number;
  tuningCents: number;
  intraSpreadCents: number;
  wobbleCents: number;
  noteSigmaCents: number;
  scoopDepthSemitones: number;
  scoopMs: number;
  scoopRate: number;
  onsetBiasMs: number;
  onsetScatterMs: number;
}

export const ALIGN_RANGE_BEATS = 1.5;
export const ALIGN_STEP_SEC = 0.01;
export const MID_FROM = 0.3;
export const MID_TO = 0.8;
export const LONG_NOTE_SEC = 0.35;
export const MIN_MID_FRAMES = 4;
export const ARRIVE_SEMITONES = 0.3;
export const PRE_SEC = 0.15;
export const MIN_NOTES = 6;
/** Scoop statistics need at least this many voiced-run starts (else NaN: that key keeps its default). */
export const MIN_SCOOPS = 3;

/** Reference voice (medians on synthetic H4 tuning, hum-v3; out/hum/r3/syn-traits.json). */
export const REF_TRAITS = {
  scoopDepthSemitones: 2.0,
  scoopMs: 110,
  wobbleCents: 53,
  noteSigmaCents: 55,
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const roundTo = (x: number, q: number) => Math.round(x / q) * q;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function quantile(v: number[], q: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (v: number[]) => quantile(v, 0.5);
export const robustSigma = (v: number[]) => {
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
};

/** Frame pitch in semitones (NaN when unvoiced). */
export function framePitch(track: FrameF0Track): number[] {
  return track.hz.map((hz, i) => (hz > 0 && track.voiced[i] >= 0.5 ? 69 + 12 * Math.log2(hz / 440) : NaN));
}

interface Placed {
  on: number;
  off: number;
  midi: number;
}

function placeNotes(known: KnownNote[], grid: CalibrationGrid): { notes: Placed[]; tickSec: number } {
  const tickSec = 60 / (grid.bpm * (WHOLE_TICKS / grid.ts[1]));
  const notes = [...known]
    .filter((n) => n.ticks > 0)
    .sort((a, b) => a.startTick - b.startTick)
    .map((n) => ({ on: grid.startSec + n.startTick * tickSec, off: grid.startSec + (n.startTick + n.ticks) * tickSec, midi: n.midi }));
  return { notes, tickSec };
}

/** Frame index range [a, b) of times in [t0, t1). */
function frameRange(track: FrameF0Track, n: number, t0: number, t1: number): [number, number] {
  const a = Math.max(0, Math.ceil((t0 - track.t0) / track.hopSec));
  const b = Math.min(n, Math.ceil((t1 - track.t0) / track.hopSec));
  return [a, Math.max(a, b)];
}

/** Joint search of the constant time shift tau and the whole-semitone transposition d (see the header). */
export function alignKnown(p: number[], track: FrameF0Track, notes: Placed[], beatSec: number): { tau: number; d: number; hits: number; total: number } {
  const R = ALIGN_RANGE_BEATS * beatSec;
  let best = { tau: 0, d: 0, hits: -1, total: 0 };
  for (let k = -Math.round(R / ALIGN_STEP_SEC); k <= Math.round(R / ALIGN_STEP_SEC); k++) {
    const tau = k * ALIGN_STEP_SEC;
    const hist = new Map<number, number>();
    let total = 0;
    for (const nt of notes) {
      const dur = nt.off - nt.on;
      const [a, b] = frameRange(track, p.length, nt.on + tau + MID_FROM * dur, nt.on + tau + MID_TO * dur);
      for (let i = a; i < b; i++) {
        if (Number.isNaN(p[i])) continue;
        total++;
        const d = Math.round(p[i] - nt.midi);
        hist.set(d, (hist.get(d) ?? 0) + 1);
      }
    }
    for (const [d, h] of hist) {
      const better = h > best.hits || (h === best.hits && (Math.abs(tau) < Math.abs(best.tau) || (Math.abs(tau) === Math.abs(best.tau) && Math.abs(d) < Math.abs(best.d))));
      if (better) best = { tau, d, hits: h, total };
    }
  }
  return best;
}

/** Traits of the voice from one calibration take (frame f0 of the analyzer + its known melody). */
export function measureVoiceTraits(track: FrameF0Track, known: KnownNote[], grid: CalibrationGrid): VoiceTraits {
  const p = framePitch(track);
  const { notes, tickSec } = placeNotes(known, grid);
  const beatSec = 60 / grid.bpm;
  const stepSec = (WHOLE_TICKS / 16) * tickSec;
  const al = alignKnown(p, track, notes, beatSec);
  const tau = al.tau;
  // tuning: median deviation of the middle frames near the aligned target
  const devs: number[] = [];
  for (const nt of notes) {
    const dur = nt.off - nt.on;
    const [a, b] = frameRange(track, p.length, nt.on + tau + MID_FROM * dur, nt.on + tau + MID_TO * dur);
    for (let i = a; i < b; i++) if (!Number.isNaN(p[i]) && Math.abs(p[i] - nt.midi - al.d) < 1) devs.push(p[i] - nt.midi - al.d);
  }
  const tuning = devs.length ? median(devs) : 0;

  const intra: number[] = [];
  const wobble: number[] = [];
  const offsets: number[] = [];
  const med: number[] = notes.map(() => NaN);
  notes.forEach((nt, k) => {
    const q = nt.midi + al.d + tuning;
    const dur = nt.off - nt.on;
    const [a, b] = frameRange(track, p.length, nt.on + tau + MID_FROM * dur, nt.on + tau + MID_TO * dur);
    const fr: number[] = [];
    for (let i = a; i < b; i++) if (!Number.isNaN(p[i]) && Math.abs(p[i] - q) < 1.5) fr.push(p[i]);
    if (fr.length < MIN_MID_FRAMES) return;
    const m = median(fr);
    med[k] = m;
    offsets.push(100 * (m - q));
    for (const x of fr) intra.push(100 * (x - m));
    if (dur >= LONG_NOTE_SEC && fr.length >= 10) wobble.push((100 * (quantile(fr, 0.9) - quantile(fr, 0.1))) / 2);
  });

  // approaches (scoops) and onsets
  const depths: number[] = [];
  const scoopDur: number[] = [];
  const onDev: number[] = [];
  const tauGrid = Math.round(tau / stepSec) * stepSec;
  notes.forEach((nt, k) => {
    const m = med[k];
    if (Number.isNaN(m)) return;
    const dur = nt.off - nt.on;
    const [w0, w1] = frameRange(track, p.length, nt.on + tau - PRE_SEC, nt.on + tau + Math.min(0.3, 0.6 * dur));
    let a = -1;
    for (let i = w0; i < w1; i++) if (!Number.isNaN(p[i]) && Math.abs(p[i] - m) <= ARRIVE_SEMITONES) { a = i; break; }
    if (a < 0) return;
    const prevM = k > 0 ? med[k - 1] : NaN;
    const prevDiffers = !Number.isNaN(prevM) && Math.abs(prevM - m) >= 0.5;
    let b = a;
    while (b - 1 >= w0 && !Number.isNaN(p[b - 1]) && !(prevDiffers && Math.abs(p[b - 1] - prevM) <= ARRIVE_SEMITONES)) b--;
    const tb = track.t0 + b * track.hopSec;
    onDev.push(1000 * (tb - (nt.on + tauGrid)));
    // scoops: only approaches that start a voiced run (an unvoiced frame right before, inside the window)
    if (!(b - 1 >= w0 && Number.isNaN(p[b - 1]))) return;
    let depth = 0;
    for (let i = b; i < a; i++) depth = Math.max(depth, m - p[i]);
    depths.push(depth);
    if (depth >= 0.3) scoopDur.push(1000 * (a - b) * track.hopSec);
  });

  return {
    nNotes: offsets.length,
    coverage: al.total ? r3(al.hits / al.total) : 0,
    tuningCents: r3(100 * tuning),
    intraSpreadCents: intra.length ? r3(robustSigma(intra)) : NaN,
    wobbleCents: wobble.length ? r3(median(wobble)) : NaN,
    noteSigmaCents: offsets.length ? r3(robustSigma(offsets)) : NaN,
    scoopDepthSemitones: depths.length >= MIN_SCOOPS ? r3(quantile(depths, 0.9)) : NaN,
    scoopMs: scoopDur.length >= MIN_SCOOPS ? r3(quantile(scoopDur, 0.75)) : NaN,
    scoopRate: depths.length >= MIN_SCOOPS ? r3(depths.filter((x) => x >= 0.5).length / depths.length) : NaN,
    onsetBiasMs: onDev.length ? r3(median(onDev)) : NaN,
    onsetScatterMs: onDev.length ? r3(robustSigma(onDev)) : NaN,
  };
}

export type CalibrationOverrides = {
  segment?: { scoopMaxSemitones?: number; fragmentMs?: number; moveSemitones?: number };
  pitch?: { boundaryCents?: number };
};

/** The fixed mapping rule (see the header). Traits that could not be measured (NaN) leave their key at the default. */
export function calibrationOverrides(t: VoiceTraits, ref: { scoopDepthSemitones: number; scoopMs: number; wobbleCents: number; noteSigmaCents: number } = REF_TRAITS): CalibrationOverrides {
  if (!(t.nNotes >= MIN_NOTES)) return {};
  const ok = Number.isFinite;
  const segment: NonNullable<CalibrationOverrides['segment']> = {};
  if (ok(t.scoopDepthSemitones)) segment.scoopMaxSemitones = r3(roundTo(clamp(1.5 + (t.scoopDepthSemitones - ref.scoopDepthSemitones), 1.5, 3.0), 0.05));
  if (ok(t.scoopMs)) segment.fragmentMs = Math.round(roundTo(clamp(130 + (t.scoopMs - ref.scoopMs), 130, 250), 10));
  if (ok(t.wobbleCents)) segment.moveSemitones = r3(roundTo(clamp(0.5 + (t.wobbleCents - ref.wobbleCents) / 100, 0.5, 0.8), 0.05));
  const out: CalibrationOverrides = {};
  if (Object.keys(segment).length) out.segment = segment;
  if (ok(t.noteSigmaCents)) out.pitch = { boundaryCents: Math.round(clamp(20 + 0.5 * (t.noteSigmaCents - ref.noteSigmaCents), 10, 40)) };
  return out;
}
