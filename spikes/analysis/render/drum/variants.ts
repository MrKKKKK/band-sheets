// Spike 5 T2: synthetic drum variants = style x level D0..D3 x seed x kit (docs/audio-spike5-plan.md section 4).
//
// Splits by seed (plan section 4 分け方):
//   tuning   seeds 1-3, kit A; seeds 11-13, kits D (MuldjordKit) and H (kit A drums + kit D cymbals) (T10b: hi-hat /
//            cymbal sounds other than kit A's inside the tuning split). D and H are refused for any other split.
//   dev      seeds 4-5, kits A and B
//   heldOut  seeds 6-7, kit C and the held-out room (room.ts fdnRoom), `heldOut: true`; their random streams are
//            salted differently, so no draw is shared with a tuning / dev variant. Kit C and the held-out room are
//            refused for any other split (synthParams throws), so tuning / dev never use them.
// The seed fixes the groove, tempo and lead-in (the `score` stream, no kit or level in its key), so the levels of a
// seed, and kits A and B of a dev seed, play the same groove (kit B lacks T2: fills use the toms the kit has).
// Levels:
//   D0  close mic, dry, no timing jitter, fixed velocity per piece, no ghosts / accents, swing exactly 2:1,
//       first round robin only.
//   D1  + timing jitter (sigma 5-10 ms), velocity spread, ghosts and accents, swing 2:1 or 3:2, round robins.
//   D2  + overhead mic, room (A: Schroeder reverb, B: its room mic, C: held-out FDN room), pink noise 30 dB SNR,
//       fills every 4 or 8 bars; jitter sigma 8-15 ms.
//   D3  + phone-like mic (one distant mic, band-limited), more room, noise 20 dB, dense cymbals, other tuning
//       (A and H: the Power kit, program 16; B/C/D: drums shifted 100-250 cents); jitter sigma 12-20 ms.
// Rooms at D2 / D3: A, H Schroeder reverb; B, D their room mics; C the held-out FDN room.
// The `ext` style (S-拡張 pieces) is rendered at D1 and D2 only.

import { prng } from '../prng';
import { hashSeed } from '../hum/variants';
import { TUNING_ONLY_KITS, type KitId } from './kits';
import { STYLE_IDS, STYLES, type StyleId } from './patterns';

export type DrumLevel = 0 | 1 | 2 | 3;
export type DrumSplit = 'tuning' | 'dev' | 'heldOut';

export const DRUM_LEVELS: DrumLevel[] = [0, 1, 2, 3];
/** The variant sets: split, seeds, kits (in this order; the order of the variants list). */
export const DRUM_SETS: { split: DrumSplit; seeds: number[]; kits: KitId[] }[] = [
  { split: 'tuning', seeds: [1, 2, 3], kits: ['A'] },
  { split: 'tuning', seeds: [11, 12, 13], kits: ['D', 'H'] },
  { split: 'dev', seeds: [4, 5], kits: ['A', 'B'] },
  { split: 'heldOut', seeds: [6, 7], kits: ['C'] },
];
export const DRUM_SEEDS = DRUM_SETS.flatMap((s) => s.seeds).sort((a, b) => a - b);
export const EXT_LEVELS: DrumLevel[] = [1, 2];
/** Silence after the last bar (cymbal and room tails). */
export const TAIL_SEC = 2.5;

/** Seeds and kits per split (union of DRUM_SETS; the manifest records both). */
export const SPLITS: Record<DrumSplit, { seeds: number[]; kits: KitId[] }> = {
  tuning: { seeds: [1, 2, 3, 11, 12, 13], kits: ['A', 'D', 'H'] },
  dev: { seeds: [4, 5], kits: ['A', 'B'] },
  heldOut: { seeds: [6, 7], kits: ['C'] },
};

export function splitOf(seed: number): DrumSplit {
  const set = DRUM_SETS.find((s) => s.seeds.includes(seed));
  if (!set) throw new Error(`seed ${seed} is in no drum set`);
  return set.split;
}

export interface DrumVariant {
  name: string;
  style: StyleId;
  level: DrumLevel;
  seed: number;
  kit: KitId;
  split: DrumSplit;
  heldOut: boolean;
  /** The S-拡張 style. */
  ext: boolean;
}

export function drumVariantName(style: StyleId, level: DrumLevel, kit: KitId, seed: number): string {
  return `syn-d${level}-${style}-k${kit}-s${seed}`;
}

export function allDrumVariants(): DrumVariant[] {
  const out: DrumVariant[] = [];
  for (const level of DRUM_LEVELS)
    for (const style of STYLE_IDS) {
      if (style === 'ext' && !EXT_LEVELS.includes(level)) continue;
      for (const { split, seeds, kits } of DRUM_SETS)
        for (const seed of seeds)
          for (const kit of kits)
            out.push({ name: drumVariantName(style, level, kit, seed), style, level, seed, kit, split, heldOut: split === 'heldOut', ext: style === 'ext' });
    }
  return out;
}

/** Named random stream of a variant. `perKit` / `perLevel` add the kit / level to the key. */
export function streamOf(v: DrumVariant, tag: string, o: { perKit?: boolean; perLevel?: boolean } = {}): () => number {
  const salt = v.heldOut ? 'drum-heldout' : 'drum';
  return prng(hashSeed(`${salt}:${v.style}:s${v.seed}${o.perKit ? `:k${v.kit}` : ''}${o.perLevel ? `:d${v.level}` : ''}:${tag}`));
}

const uni = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export type MicPreset = 'close' | 'oh' | 'phone';
export type Room =
  | { kind: 'none' }
  | { kind: 'schroeder'; rt60: number; wet: number }
  | { kind: 'mic'; level: number }
  | { kind: 'fdn'; rt60: number; wet: number };

export interface DrumSynthParams {
  bpm: number;
  /** Silence before the silent count-in bar. */
  leadSec: number;
  /** Bar 1 head = leadSec + one bar (the count-in the drummer hears in the headphones). */
  startSec: number;
  swingRatio: number;
  jitterSigmaSec: number;
  /** Velocity spread (sigma, MIDI units) around the per-piece nominal; 0 = fixed. */
  velocitySigma: number;
  roundRobin: boolean;
  mic: MicPreset;
  room: Room;
  noiseSnrDb: number | null;
  /** Kit A program (0 Standard, 16 Power). */
  program: number;
  /** B/C pitch shift of the drums (cents). */
  cents: number;
  fills: boolean;
  denseCymbals: boolean;
  marks: boolean;
}

export function synthParams(v: DrumVariant): DrumSynthParams {
  if ((v.kit === 'C') !== v.heldOut || v.heldOut !== (v.split === 'heldOut')) {
    throw new Error(`${v.name}: kit C is held-out only, and held-out uses kit C only`);
  }
  if (TUNING_ONLY_KITS.has(v.kit) && v.split !== 'tuning') throw new Error(`${v.name}: kit ${v.kit} is tuning only`);
  if (TUNING_ONLY_KITS.has(v.kit) && !DRUM_SETS.some((s) => s.split === 'tuning' && s.kits.includes(v.kit) && s.seeds.includes(v.seed))) {
    throw new Error(`${v.name}: kit ${v.kit} plays its own tuning seeds only`);
  }
  const score = streamOf(v, 'tempo');
  const info = STYLES[v.style];
  const bpm = Math.round(uni(score, info.bpm[0], info.bpm[1]));
  const leadSec = r3(uni(score, 0.5, 1.2));
  const barSec = (60 / bpm) * info.ts[0]; // bpm counts the denominator's beat
  const lv = streamOf(v, 'level', { perLevel: true, perKit: true });
  const L = v.level;
  const jitter: Record<DrumLevel, [number, number]> = { 0: [0, 0], 1: [0.005, 0.01], 2: [0.008, 0.015], 3: [0.012, 0.02] };
  const jitterSigmaSec = L === 0 ? 0 : r3(uni(lv, ...jitter[L]) * 1000) / 1000;
  const swingRatio = L === 0 ? 2 / 3 : lv() < 0.5 ? 2 / 3 : 0.6;
  let room: Room = { kind: 'none' };
  if (L >= 2) {
    const wetHi = L === 3 ? 0.45 : 0.3;
    if (v.kit === 'A' || v.kit === 'H') room = { kind: 'schroeder', rt60: r3(uni(lv, 0.3, 0.7)), wet: r3(uni(lv, wetHi - 0.1, wetHi)) };
    else if (v.kit === 'B' || v.kit === 'D') room = { kind: 'mic', level: r3(uni(lv, 0.3, 0.6)) };
    else room = { kind: 'fdn', rt60: r3(uni(lv, 0.4, 0.9)), wet: r3(uni(lv, wetHi - 0.1, wetHi)) };
  }
  if (room.kind === 'fdn' && !v.heldOut) throw new Error(`${v.name}: the held-out room is for held-out variants only`);
  const powerKit = v.kit === 'A' || v.kit === 'H';
  const cents = L === 3 && !powerKit ? Math.round((lv() < 0.5 ? -1 : 1) * uni(lv, 100, 250)) : 0;
  return {
    bpm,
    leadSec,
    startSec: leadSec + barSec,
    swingRatio,
    jitterSigmaSec,
    velocitySigma: L === 0 ? 0 : 8,
    roundRobin: L > 0,
    mic: L <= 1 ? 'close' : L === 2 ? 'oh' : 'phone',
    room,
    noiseSnrDb: L === 2 ? 30 : L === 3 ? 20 : null,
    program: L === 3 && powerKit ? 16 : 0,
    cents,
    fills: L >= 2,
    denseCymbals: L === 3,
    marks: L >= 1,
  };
}
