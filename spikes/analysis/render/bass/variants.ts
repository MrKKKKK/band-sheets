// Spike 6 T2: synthetic bass variants = style x level B0..B3 x seed x timbre (docs/audio-spike6-plan.md section 4).
//
// Splits by seed (plan section 4 分け方):
//   tuning   seeds 1-3, timbre A
//   dev      seeds 4-5, timbres A and B
//   heldOut  seeds 6-7, timbre C and the held-out room (render/drum/room.ts fdnRoom), `heldOut: true`; their random
//            streams are salted differently, so no draw is shared with a tuning / dev variant. Timbre C and the
//            held-out room are refused for any other split (synthParams throws), and held-out uses timbre C only.
// The seed and style fix the song (progression, key, bass line), tempo, lead-in, accompaniment shape and whether the
// piano plays the root under a `/X` (the `score` streams, no level or timbre in their key), so the levels and timbres
// of a seed play the same notes. Levels:
//   B0  bass only, dry, no timing jitter, fixed velocity per role, first round robin only.
//   B1  + piano chords (block / whole / arpeggio; half the songs with the piano's left hand on the ROOT while the bass
//       plays the `/X`), timing jitter of the bass (sigma 5-10 ms), velocity spread, round robins.
//   B2  B1 + drums and a melody, tempo drift (+-6 %), room (A / B Schroeder, C the held-out FDN room), pink noise
//       30 dB SNR, ghost and muted bass notes; jitter sigma 8-15 ms.
//   B3  B2 + one phone mic (bass weakened below PHONE_HP_HZ, band-limited), noise 20 dB, more room, and the piano's left
//       hand doubled an octave lower so it collides with the bass; jitter sigma 12-20 ms.

import { prng } from '../prng';
import { hashSeed } from '../hum/variants';
import { BASS_STYLES, type BassStyle } from './patterns';
import type { TimbreId } from './timbres';

export type BassLevel = 0 | 1 | 2 | 3;
export type BassSplit = 'tuning' | 'dev' | 'heldOut';
export const BASS_LEVELS: BassLevel[] = [0, 1, 2, 3];

export const BASS_SETS: { split: BassSplit; seeds: number[]; timbres: TimbreId[] }[] = [
  { split: 'tuning', seeds: [1, 2, 3], timbres: ['A'] },
  { split: 'dev', seeds: [4, 5], timbres: ['A', 'B'] },
  { split: 'heldOut', seeds: [6, 7], timbres: ['C'] },
];
export const SPLITS: Record<BassSplit, { seeds: number[]; timbres: TimbreId[] }> = Object.fromEntries(
  BASS_SETS.map((s) => [s.split, { seeds: s.seeds, timbres: s.timbres }]),
) as Record<BassSplit, { seeds: number[]; timbres: TimbreId[] }>;
/** Silence rendered after the last bar (release and room tails). */
export const TAIL_SEC = 2;
export const PHONE_HP_HZ = 100;
export const PHONE_LP_HZ = 6000;

export interface BassVariant {
  name: string;
  style: BassStyle;
  level: BassLevel;
  seed: number;
  timbre: TimbreId;
  split: BassSplit;
  heldOut: boolean;
}

export const bassVariantName = (style: BassStyle, level: BassLevel, timbre: TimbreId, seed: number): string =>
  `syn-b${level}-${style}-t${timbre}-s${seed}`;
export const levelLabel = (v: Pick<BassVariant, 'level'>): string => `B${v.level}`;

export function allBassVariants(): BassVariant[] {
  const out: BassVariant[] = [];
  for (const level of BASS_LEVELS)
    for (const style of BASS_STYLES)
      for (const set of BASS_SETS)
        for (const seed of set.seeds)
          for (const timbre of set.timbres)
            out.push({ name: bassVariantName(style, level, timbre, seed), style, level, seed, timbre, split: set.split, heldOut: set.split === 'heldOut' });
  return out;
}

/** Named random stream. `perTimbre` / `perLevel` add the timbre / level to the key. */
export function streamOf(v: BassVariant, tag: string, o: { perTimbre?: boolean; perLevel?: boolean } = {}): () => number {
  const salt = v.heldOut ? 'bass-heldout' : 'bass';
  return prng(hashSeed(`${salt}:${v.style}:s${v.seed}${o.perTimbre ? `:t${v.timbre}` : ''}${o.perLevel ? `:b${v.level}` : ''}:${tag}`));
}

const uni = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export type Room = { kind: 'none' } | { kind: 'schroeder'; rt60: number; wet: number } | { kind: 'fdn'; rt60: number; wet: number };
export type PianoComp = 'block4' | 'whole' | 'arp8';

export interface BassSynthParams {
  bpm: number;
  /** Silence before bar 0 (a whole number of 10 ms). */
  leadSec: number;
  /** Piano accompaniment (B1+), null at B0. */
  comp: PianoComp | null;
  /** The piano's left hand plays the root where the chart (and the bass) has a `/X` (B1+). */
  pianoRoot: boolean;
  /** The piano's left hand doubles its bass an octave lower (B3). */
  lhOctave: boolean;
  drumsAndMelody: boolean;
  drift: boolean;
  jitterSigmaSec: number;
  velocitySigma: number;
  roundRobin: boolean;
  marks: boolean;
  room: Room;
  phone: boolean;
  noiseSnrDb: number | null;
}

export function synthParams(v: BassVariant): BassSynthParams {
  if ((v.timbre === 'C') !== v.heldOut || v.heldOut !== (v.split === 'heldOut')) {
    throw new Error(`${v.name}: timbre C is held-out only, and held-out uses timbre C only`);
  }
  const set = BASS_SETS.find((s) => s.split === v.split)!;
  if (!set.seeds.includes(v.seed) || !set.timbres.includes(v.timbre)) throw new Error(`${v.name}: seed / timbre not in the ${v.split} split`);
  const score = streamOf(v, 'tempo');
  const bpm = Math.round(uni(score, 76, 132));
  const leadSec = Math.round(uni(score, 50, 120)) / 100;
  const comps: PianoComp[] = ['block4', 'whole', 'arp8'];
  const comp = comps[Math.floor(score() * comps.length)];
  const pianoRoot = score() < 0.5;
  const L = v.level;
  const lv = streamOf(v, 'level', { perLevel: true, perTimbre: true });
  const jitter: Record<BassLevel, [number, number]> = { 0: [0, 0], 1: [0.005, 0.01], 2: [0.008, 0.015], 3: [0.012, 0.02] };
  const jitterSigmaSec = L === 0 ? 0 : r3(uni(lv, ...jitter[L]) * 1000) / 1000;
  let room: Room = { kind: 'none' };
  if (L >= 2) {
    const wetHi = L === 3 ? 0.4 : 0.25;
    const r = { rt60: r3(uni(lv, 0.3, 0.7)), wet: r3(uni(lv, wetHi - 0.1, wetHi)) };
    room = v.heldOut ? { kind: 'fdn', ...r } : { kind: 'schroeder', ...r };
  }
  if (room.kind === 'fdn' && !v.heldOut) throw new Error(`${v.name}: the held-out room is for held-out variants only`);
  return {
    bpm,
    leadSec,
    comp: L >= 1 ? comp : null,
    pianoRoot: L >= 1 && pianoRoot,
    lhOctave: L === 3,
    drumsAndMelody: L >= 2,
    drift: L >= 2,
    jitterSigmaSec,
    velocitySigma: L === 0 ? 0 : 8,
    roundRobin: L > 0,
    marks: L >= 2,
    room,
    phone: L === 3,
    noiseSnrDb: L === 2 ? 30 : L === 3 ? 20 : null,
  };
}
