// Spike 4 T1/T1b: humming variants = melody x level H0..H4 x seed 1..7 (docs/audio-spike4-plan.md section 4).
//
// Splits by seed: tuning 1-3, dev 4-5, held-out 6-7 (`heldOut: true`; their synthesis streams are also
// salted differently, so no draw is shared with a tuning/dev variant). The seed fixes the melody (rand),
// the register, transposition, tempo and lead-in; these are the SAME for all four levels of one seed so
// levels compare like for like. Everything a level adds is drawn from a level-specific stream.
//
// Levels (what each adds):
//   H0  sine (plus a weak 2nd harmonic), exact pitch and timing, every note separated by a short gap.
//   H1  voice-like source (harmonics + formant peaks, vowel "a"), articulation "la" or "ta", glides between
//       legato notes, scoops at phrase starts, vibrato on long notes. Pitch/timing still exact.
//   H2  H1 + per-note pitch offset (sigma 15-25 c), recording-wide tuning offset, slow drift, micro jitter,
//       onset jitter (sigma 20-40 ms) + a late/early bias, early note ends before rests, breath noise
//       between phrases, pink noise 30 dB SNR.
//   H3  H2 with larger offsets (sigma 25-40 c, onset sigma 40-60 ms), closed-mouth "n" hum (soft onsets,
//       repeated same-pitch notes joined by shallow loudness dips only), weak fundamental (-15..-25 dB),
//       louder breath, pink noise 20 dB, room reverb (RT60 0.3-0.7 s), click bleed from the headphones.
//   H4  "realistic" (T1b, from the look-point-1 diagnosis of the dev recordings): H3's degradations, sung either
//       as the closed-mouth "n" (tuning biased flat, -50..-15 c) or an open "la" (tuning -40..+40 c), plus
//       (see RealismParams) a scoop on EVERY note that does not start with a portamento (100-300 c below,
//       100-250 ms; same-pitch repeats inside a phrase scoop too), portamento between different pitches
//       (80-200 ms), an occasional overshoot after the scoop/portamento, slow intra-note pitch wander
//       (+-30-60 c, period 200-500 ms), vibrato +-25-50 c (50-100 c peak to peak) with an irregular rate and
//       depth, per-note pitch sigma 40-60 c (clipped at +-100 c) and, sometimes, phrase-final notes cut short
//       (breath). H0..H3 are bit-identical to T1 (H4 draws only from its own streams; the new code paths
//       run only when `realism` is set).

import type { MelodyEvent } from '../../../../src/lib/melody';
import { prng } from '../prng';
import { fixedMelody, MELODY_IDS, randomMelody, toRegister, type MelodyId, type Register } from './melodies';

export type HumLevel = 0 | 1 | 2 | 3 | 4;
export type HumSplit = 'tuning' | 'dev' | 'heldOut';
export type Articulation = 'gap' | 'la' | 'ta' | 'n';
export type Vowel = 'a' | 'n';

export const HUM_LEVELS: HumLevel[] = [0, 1, 2, 3, 4];
export const HUM_SEEDS = [1, 2, 3, 4, 5, 6, 7];
export const SAMPLE_RATE = 44100;
/** Silence after the last bar line (release + reverb tail). */
export const TAIL_SEC = 1.0;

export function splitOf(seed: number): HumSplit {
  if (seed <= 3) return 'tuning';
  if (seed <= 5) return 'dev';
  return 'heldOut';
}

export interface HumVariant {
  name: string;
  melody: MelodyId;
  level: HumLevel;
  seed: number;
  split: HumSplit;
  heldOut: boolean;
}

export function humVariantName(melody: MelodyId, level: HumLevel, seed: number): string {
  return `syn-h${level}-${melody}-s${seed}`;
}

export function allHumVariants(): HumVariant[] {
  const out: HumVariant[] = [];
  for (const level of HUM_LEVELS)
    for (const melody of MELODY_IDS)
      for (const seed of HUM_SEEDS) {
        const split = splitOf(seed);
        out.push({ name: humVariantName(melody, level, seed), melody, level, seed, split, heldOut: split === 'heldOut' });
      }
  return out;
}

/** FNV-1a 32-bit of a string: stable seeds for named random streams. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The named random stream of a variant; held-out variants use a different salt. */
export function streamOf(v: Pick<HumVariant, 'melody' | 'seed' | 'heldOut'>, tag: string): () => number {
  return prng(hashSeed(`${v.heldOut ? 'hum-heldout' : 'hum'}:${v.melody}:s${v.seed}:${tag}`));
}

const uni = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();

const TEMPO: Record<MelodyId, [number, number]> = {
  saints: [96, 132],
  kirakira: [80, 120],
  etude: [72, 100],
  rand: [72, 126],
};

/** What the seed fixes for all levels: the score, register, tempo and lead-in. */
export interface HumScore {
  events: MelodyEvent[];
  register: Register;
  /** Transposition applied to the fixed melody (0 for rand). */
  semitones: number;
  key?: string;
  bpm: number;
  /** Silence before the (silent) 1-bar count-in. */
  leadSec: number;
}

export function humScore(v: HumVariant): HumScore {
  const rnd = streamOf(v, 'score');
  const register: Register = rnd() < 0.5 ? 'low' : 'high';
  const [lo, hi] = TEMPO[v.melody];
  const bpm = Math.round(uni(rnd, lo, hi));
  const leadSec = Math.round(uni(rnd, 0.3, 1.0) * 1000) / 1000;
  if (v.melody === 'rand') {
    const r = randomMelody(hashSeed(`${v.heldOut ? 'ho' : ''}rand${v.seed}`), register);
    return { events: r.events, register, semitones: 0, key: r.key, bpm, leadSec };
  }
  const t = toRegister(fixedMelody(v.melody), register);
  return { events: t.events, register, semitones: t.semitones, bpm, leadSec };
}

/** Synthesis parameters of one variant (all drawn here, so the truth can echo them). */
export interface SynthParams {
  source: 'sine' | 'voice';
  articulation: Articulation;
  vowel: Vowel;
  /** Spectral tilt exponent: harmonic k has amplitude k^-tilt (before formants). */
  tilt: number;
  /** Fundamental (harmonic 1) gain in dB; < 0 = weak fundamental. */
  fundamentalDb: number;
  glide: boolean;
  /** Glide length range (s) between legato notes. */
  glideSec: [number, number];
  /** Probability of a scoop at a phrase start, its depth (cents below) and length (s). */
  scoopProb: number;
  scoopCents: [number, number];
  scoopSec: [number, number];
  vibrato: boolean;
  vibRateHz: number;
  vibDepthCents: number;
  /** Notes at least this long (s) get vibrato. */
  vibMinSec: number;
  /** Per-note pitch offset sigma (cents), clipped to +-PITCH_CLIP_CENTS. */
  pitchSigmaCents: number;
  /** Recording-wide tuning offset (cents). */
  tuningCents: number;
  /** Slow drift amplitude (cents) and its two periods (s) / phases. */
  driftCents: number;
  driftPeriods: [number, number];
  driftPhases: [number, number];
  /** Micro jitter (smoothed noise) sigma in cents. */
  jitterCents: number;
  /** Onset jitter sigma (s), clipped to +-2.5 sigma, and the constant bias (s, positive = late). */
  onsetSigmaSec: number;
  onsetBiasSec: number;
  /** Before a rest, the note ends this fraction of its length early (uniform range). */
  endEarly: [number, number];
  /** Phrase attack/release (s). */
  attackSec: number;
  releaseSec: number;
  /** Loudness dip at a note boundary inside a phrase: depth (dB) for a pitch change / same pitch, width (s). */
  dipDb: number;
  repeatDipDb: number;
  dipSec: number;
  /** 'ta': closure gap before each note (s). */
  closureSec: number;
  /** Breath noise level re the voice peak (dB), or null for none. */
  breathDb: number | null;
  noiseSnrDb: number | null;
  reverbRt60: number | null;
  /** Click bleed level re the voice peak (dB), or null for none. */
  clickDb: number | null;
  /** H4 only (absent below, so the H0..H3 truths are unchanged): the "realistic" singer. */
  realism?: RealismParams;
}

/**
 * H4 traits on top of the base parameters (in H4 the base also has scoopProb 1, scoopCents 100-300,
 * scoopSec 0.1-0.25, glideSec 0.08-0.2 = portamento, vibDepthCents 25-50).
 */
export interface RealismParams {
  /** 'n' = closed-mouth hum (H3 sound, flat tuning), 'la' = open vowel. */
  hum: 'n' | 'la';
  /** Per-note pitch offset clip (cents), instead of PITCH_CLIP_CENTS. */
  pitchClipCents: number;
  /** The onset transition (scoop or portamento) takes at most this fraction of the note. */
  transitionMaxFrac: number;
  /** Probability of an overshoot after the transition, its size (cents) and length (s). */
  overshootProb: number;
  overshootCents: [number, number];
  overshootSec: [number, number];
  /** Slow intra-note wander: amplitude (cents) and period (s) ranges, drawn per note. */
  wanderCents: [number, number];
  wanderSec: [number, number];
  /** Vibrato irregularity: per-note depth factor 1 +- depthDev, rate modulated by +- rateDev with a period in rateModSec. */
  vibDepthDev: number;
  vibRateDev: number;
  vibRateModSec: [number, number];
  /** A phrase-final note is cut short (breath) with this probability, by this fraction of its length. */
  breathShortProb: number;
  breathShort: [number, number];
}

export const PITCH_CLIP_CENTS = 45;

export function synthParams(v: HumVariant): SynthParams {
  const r = streamOf(v, `synth-h${v.level}`);
  const base: SynthParams = {
    source: 'sine',
    articulation: 'gap',
    vowel: 'a',
    tilt: 1.2,
    fundamentalDb: 0,
    glide: false,
    glideSec: [0.03, 0.12],
    scoopProb: 0,
    scoopCents: [50, 100],
    scoopSec: [0.06, 0.1],
    vibrato: false,
    vibRateHz: 5.5,
    vibDepthCents: 0,
    vibMinSec: 0.45,
    pitchSigmaCents: 0,
    tuningCents: 0,
    driftCents: 0,
    driftPeriods: [20, 7],
    driftPhases: [0, 0],
    jitterCents: 0,
    onsetSigmaSec: 0,
    onsetBiasSec: 0,
    endEarly: [0, 0],
    attackSec: 0.005,
    releaseSec: 0.005,
    dipDb: 0,
    repeatDipDb: 0,
    dipSec: 0.05,
    closureSec: 0,
    breathDb: null,
    noiseSnrDb: null,
    reverbRt60: null,
    clickDb: null,
  };
  if (v.level === 0) return base;
  const h1: SynthParams = {
    ...base,
    source: 'voice',
    articulation: r() < 0.5 ? 'la' : 'ta',
    tilt: uni(r, 1.0, 1.4),
    glide: true,
    scoopProb: 0.6,
    vibrato: true,
    vibRateHz: uni(r, 5, 6),
    vibDepthCents: uni(r, 20, 60),
    attackSec: uni(r, 0.02, 0.04),
    releaseSec: uni(r, 0.02, 0.04),
    dipDb: uni(r, 8, 14),
    repeatDipDb: uni(r, 14, 18),
    dipSec: uni(r, 0.04, 0.06),
    closureSec: uni(r, 0.03, 0.05),
  };
  if (v.level === 1) return h1;
  const hard = v.level >= 3;
  const h2: SynthParams = {
    ...h1,
    pitchSigmaCents: hard ? uni(r, 25, 40) : uni(r, 15, 25),
    tuningCents: uni(r, -30, 30),
    driftCents: hard ? uni(r, 10, 25) : uni(r, 5, 20),
    driftPeriods: [uni(r, 15, 30), uni(r, 5, 9)],
    driftPhases: [uni(r, 0, 2 * Math.PI), uni(r, 0, 2 * Math.PI)],
    jitterCents: 3,
    onsetSigmaSec: hard ? uni(r, 0.04, 0.06) : uni(r, 0.02, 0.04),
    onsetBiasSec: hard ? uni(r, -0.02, 0.06) : uni(r, 0, 0.04),
    endEarly: [0, 0.25],
    breathDb: hard ? -18 : -26,
    noiseSnrDb: hard ? 20 : 30,
  };
  if (!hard) return h2;
  const h3: SynthParams = {
    ...h2,
    articulation: 'n',
    vowel: 'n',
    fundamentalDb: uni(r, -25, -15),
    attackSec: uni(r, 0.06, 0.12),
    releaseSec: uni(r, 0.04, 0.08),
    dipDb: uni(r, 2, 4),
    repeatDipDb: uni(r, 4, 8),
    dipSec: uni(r, 0.06, 0.1),
    reverbRt60: uni(r, 0.3, 0.7),
    clickDb: uni(r, -32, -24),
  };
  if (v.level === 3) return h3;
  // ---- H4 (more draws from the same synth-h4 stream; H3 never reaches this) ----
  const hum: 'n' | 'la' = r() < 0.5 ? 'n' : 'la';
  const open: Partial<SynthParams> =
    hum === 'n'
      ? {}
      : { articulation: 'la', vowel: 'a', attackSec: uni(r, 0.03, 0.06), releaseSec: uni(r, 0.03, 0.06), dipDb: uni(r, 6, 12), repeatDipDb: uni(r, 10, 16), dipSec: uni(r, 0.05, 0.08) };
  return {
    ...h3,
    ...open,
    pitchSigmaCents: uni(r, 40, 60),
    tuningCents: hum === 'n' ? uni(r, -50, -15) : uni(r, -40, 40),
    glideSec: [0.08, 0.2],
    scoopProb: 1,
    scoopCents: [100, 300],
    scoopSec: [0.1, 0.25],
    vibRateHz: uni(r, 4.5, 6.5),
    vibDepthCents: uni(r, 25, 50),
    vibMinSec: 0.35,
    realism: {
      hum,
      pitchClipCents: 100,
      transitionMaxFrac: 0.6,
      overshootProb: 0.3,
      overshootCents: [20, 60],
      overshootSec: [0.08, 0.16],
      wanderCents: [30, 60],
      wanderSec: [0.2, 0.5],
      vibDepthDev: 0.3,
      vibRateDev: 0.15,
      vibRateModSec: [0.5, 1.2],
      breathShortProb: 0.35,
      breathShort: [0.2, 0.45],
    },
  };
}
