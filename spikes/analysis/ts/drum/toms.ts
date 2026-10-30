/**
 * Spike 5 T11: S-9 toms - T1 / T2 / FT (docs/audio-spike5-plan.md section 2, S-9; docs/audio-spike5-t11.md).
 *
 * classify.ts finds the tom onsets (tom template share); this file names them by RELATIVE pitch within the take
 * (the plan: the number and tuning of the toms differ between kits):
 *  - tomPitch: frequency (Hz) of the largest magnitude peak in [pitchMinHz, pitchMaxHz] of a Hann window of winSec
 *    starting delaySec after the onset (zero-padded to the next power of two x2, parabolic interpolation); a local peak
 *    at about half that frequency with >= subRatio of its magnitude wins (the fundamental under a louder overtone).
 *  - groupPitches: sort by log2 pitch; split at the largest gaps that are >= minGapOct, at most `groups` groups.
 *  - groupNames: 3 groups -> T1 (highest), T2, FT. Fewer groups keep the pitch order and take the names whose kit
 *    template index (T1 0, T2 1, FT 2) is nearest to the groups' mean template vote (for a known kit the vote is
 *    right; for 1 or 2 toms in a take the pitch alone cannot tell T1 from T2).
 */
import { RealFft } from '../dsp/core/fft';
import type { DrumConfig } from './config';

export const TOMS = ['T1', 'T2', 'FT'] as const;
export type TomInst = (typeof TOMS)[number];
export type TomCfg = DrumConfig['toms'];

const ffts = new Map<number, RealFft>();

type PitchCfg = Pick<TomCfg, 'delaySec' | 'winSec' | 'pitchMinHz' | 'pitchMaxHz' | 'subRatio'>;

/** |X| of the tom window (see the file comment) and its FFT size. */
function windowMag(y: Float32Array, sr: number, t: number, cfg: Pick<TomCfg, 'delaySec' | 'winSec'>): { mag: Float64Array; size: number } {
  const n = Math.max(2, Math.round(cfg.winSec * sr));
  let size = 2;
  while (size < 2 * n) size *= 2;
  let fft = ffts.get(size);
  if (!fft) ffts.set(size, (fft = new RealFft(size)));
  const x = new Float64Array(size);
  const s0 = Math.round((t + cfg.delaySec) * sr);
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j >= 0 && j < y.length) x[i] = y[j] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  }
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  fft.rfft(x, re, im);
  return { mag: Float64Array.from(re, (r, k) => Math.hypot(r, im[k])), size };
}

function pitchOf(mag: Float64Array, size: number, sr: number, cfg: PitchCfg): number {
  const k0 = Math.max(1, Math.ceil((cfg.pitchMinHz * size) / sr));
  const k1 = Math.min(mag.length - 2, Math.floor((cfg.pitchMaxHz * size) / sr));
  let best = -1;
  for (let k = k0; k <= k1; k++) if (best < 0 || mag[k] > mag[best]) best = k;
  if (best < 0 || !(mag[best] > 0)) return NaN;
  // an overtone can be the largest peak: take the largest peak near half its frequency when it has >= subRatio of it
  const half = best / 2;
  let sub = -1;
  for (let k = Math.max(k0, Math.floor(half * 0.94)); k <= Math.ceil(half * 1.06); k++) if (k < best && (sub < 0 || mag[k] > mag[sub])) sub = k;
  if (sub > k0 && sub < k1 && mag[sub] >= cfg.subRatio * mag[best] && mag[sub] >= mag[sub - 1] && mag[sub] >= mag[sub + 1]) best = sub;
  const a = Math.log(mag[best - 1] + 1e-30);
  const b = Math.log(mag[best] + 1e-30);
  const c = Math.log(mag[best + 1] + 1e-30);
  const den = a - 2 * b + c;
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return ((best + off) * sr) / size;
}

export function tomPitch(y: Float32Array, sr: number, t: number, cfg: PitchCfg): number {
  const { mag, size } = windowMag(y, sr, t, cfg);
  return pitchOf(mag, size, sr, cfg);
}

/** Kit-independent tom evidence of one onset (T11b), from the tom window's power spectrum. */
export interface TomFeatures {
  /** tomPitch (Hz). */
  pitch: number;
  /** Share of the 20 Hz .. adaptLowTopHz power below adaptSubHz (a bass drum's sub). */
  sub: number;
  /** Share of the 20 Hz .. 10 kHz power at or above adaptLowTopHz (stick noise, snare wires, cymbals). */
  high: number;
  /** Share of the 20 Hz .. adaptLowTopHz power in adaptSubHz .. pitchMaxHz (a drum body; a cowbell has ~.01). */
  body: number;
}

export function tomFeatures(y: Float32Array, sr: number, t: number, cfg: TomCfg): TomFeatures {
  const { mag, size } = windowMag(y, sr, t, cfg);
  const bin = (hz: number) => Math.min(mag.length, Math.round((hz * size) / sr));
  const pw = (a: number, b: number) => {
    let s = 0;
    for (let k = bin(a); k < bin(b); k++) s += mag[k] * mag[k];
    return s;
  };
  const low = pw(20, cfg.adaptLowTopHz);
  const all = pw(20, 10000);
  return {
    pitch: pitchOf(mag, size, sr, cfg),
    sub: low > 0 ? pw(20, cfg.adaptSubHz) / low : NaN,
    high: all > 0 ? pw(cfg.adaptLowTopHz, 10000) / all : NaN,
    body: low > 0 ? pw(cfg.adaptSubHz, cfg.pitchMaxHz) / low : NaN,
  };
}

/** What tomSeeds reads of an onset's S-3 decision: BD / SD / HH present, BD share. */
export interface SeedCls {
  present: readonly boolean[];
  share: readonly number[];
}

/**
 * T11b seeds of the per-take tom templates: onsets that look like a tom whatever the kit - not an S-3 hi-hat alone,
 * little sub (< adaptSubMax: not a bass drum), little high (< adaptHighMax: not a snare / cymbal), a body (>=
 * adaptBodyMin: not a cowbell), pitched below
 * adaptPitchRatio x the take's snare pitch (median tomPitch of the S-3 SD-only onsets; fewer than adaptMinHits of them:
 * no seeds), and not a confident S-3 BD (present with share >= adaptBdMax). All false when fewer than adaptMinHits pass.
 * Also returns the snare pitch (NaN without it).
 */
export function tomSeeds(f: readonly TomFeatures[], cls: readonly SeedCls[], cfg: TomCfg): { seeds: boolean[]; sdPitch: number } {
  const none = f.map(() => false);
  const sdPitch = f.filter((e, i) => cls[i].present[1] && !cls[i].present[0] && !cls[i].present[2] && Number.isFinite(e.pitch)).map((e) => e.pitch);
  if (sdPitch.length < cfg.adaptMinHits) return { seeds: none, sdPitch: NaN };
  sdPitch.sort((a, b) => a - b);
  const ref = sdPitch[Math.floor(sdPitch.length / 2)];
  const seeds = f.map((e, i) => {
    const o = cls[i];
    const hhOnly = o.present[2] && !o.present[0] && !o.present[1];
    return !hhOnly && e.sub < cfg.adaptSubMax && e.high < cfg.adaptHighMax && e.body >= cfg.adaptBodyMin && e.pitch < cfg.adaptPitchRatio * ref && !(o.present[0] && o.share[0] >= cfg.adaptBdMax);
  });
  return { seeds: seeds.filter(Boolean).length >= cfg.adaptMinHits ? seeds : none, sdPitch: ref };
}

/** Group index per pitch (0 = highest group); NaN pitches join the group of the median pitch. */
export function groupPitches(pitches: readonly number[], groups: number, minGapOct: number): { group: number[]; count: number } {
  const ok = pitches.map((p, i) => ({ i, l: Math.log2(p) })).filter((e) => Number.isFinite(e.l));
  if (!ok.length) return { group: pitches.map(() => 0), count: pitches.length ? 1 : 0 };
  ok.sort((a, b) => b.l - a.l);
  const gaps = ok
    .slice(1)
    .map((e, k) => ({ k: k + 1, g: ok[k].l - e.l }))
    .filter((e) => e.g >= minGapOct)
    .sort((a, b) => b.g - a.g)
    .slice(0, Math.max(0, groups - 1))
    .map((e) => e.k)
    .sort((a, b) => a - b);
  const group = new Array<number>(pitches.length).fill(-1);
  ok.forEach((e, rank) => (group[e.i] = gaps.filter((k) => k <= rank).length));
  const mid = group[ok[Math.floor(ok.length / 2)].i];
  return { group: group.map((g) => (g < 0 ? mid : g)), count: gaps.length + 1 };
}

/**
 * T11b vote (tom index, for groupNames) of a pitch group from its pitch re the take's snare pitch: the nearest (log2)
 * of nameSdRatios [T1, T2, FT]; NaN when either pitch is unknown.
 */
export function ratioVote(pitch: number, sdPitch: number, ratios: readonly number[]): number {
  if (!(pitch > 0) || !(sdPitch > 0)) return NaN;
  const l = Math.log2(pitch / sdPitch);
  let best = 0;
  ratios.forEach((r, k) => Math.abs(Math.log2(r) - l) < Math.abs(Math.log2(ratios[best]) - l) && (best = k));
  return best;
}

/** Names of `count` pitch groups (0 = highest), from their mean template vote (0 = T1 .. 2 = FT; NaN = no vote). */
export function groupNames(count: number, votes: readonly number[]): TomInst[] {
  if (count >= 3) return [...TOMS];
  const choices: number[][] = count === 2 ? [[0, 1], [0, 2], [1, 2]] : [[0], [1], [2]];
  const fallback = count === 2 ? [0, 2] : [0];
  const cost = (c: number[]) => c.reduce((s, idx, g) => s + (Number.isFinite(votes[g]) ? Math.abs(votes[g] - idx) : 0), 0);
  const known = votes.slice(0, count).some((v) => Number.isFinite(v));
  const best = known ? choices.reduce((a, b) => (cost(b) < cost(a) ? b : a)) : fallback;
  return best.map((i) => TOMS[i]);
}
