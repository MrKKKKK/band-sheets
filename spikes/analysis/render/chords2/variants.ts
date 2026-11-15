// Spike 7 T5: the synthetic chords2 variants = set x variation x seed (docs/audio-spike7-plan.md section 3.1).
//
// Splits by seed (the guard of plan section 4 reads them from the manifest, or from the name: splitOfName):
//   tuning   seeds 1-3, piano P1, bass timbre A                     name c2-t-...
//   dev      seeds 4-5, piano P1, bass timbre A (seed 4) / B (seed 5) name c2-d-...
//   heldOut  seeds 8-9, piano P2 (held-out only), bass timbre C (held-out only), the held-out room (fdn), salted
//            random streams                                          name c2-h-...
// P2, bass C and the fdn room are refused for any other split (synthParams throws), and held-out uses only them.
// The seed and set fix the chart (key / transposition, song), tempo, lead-in, accompaniment, bass pattern and the
// right hand's centre (the "score" streams have no variation in their key), so the variations of a seed play the same
// chords. Variations (plan section 3.1 変化, spike 6 carry-over 5):
//   clean  piano (left hand = bass) + bass instrument, dry, on the grid, fixed velocities (tuning only for `pair`)
//   human  + timing spread (each struck chord off the grid by N(0, (J/2.5)^2) clipped at +-J, every note a further
//          U(0, J/2) later; the bass its own N(0, (J/2.5)^2); J = 20-30 ms per variant), velocity spread, room, noise
//   piano  human without a bass instrument: the left hand is the only bass (single or octave)
//   lh15   piano with the left hand playing root + 5th wherever the bass is the root (the 5th must not become `/5`)
//   peaky  human, played softly with one fortissimo staccato chord at every section start: the peak cap keeps the
//          loudness normalisation (main's inputLevel.ts: -22 dBFS RMS, peak at most -1 dBFS) from reaching -22
//          (the manifest records crestDb; plan section 3.1 "ピークの上限で -22 dBFS まで上がらない音")
// Sets B, V1, V2, V3 get all five variations; the truth-table phrases (pair) get human and piano (+ clean in tuning).

import { prng } from '../prng';
import { hashSeed } from '../hum/variants';
import type { Room } from '../bass/variants';
import type { TimbreId } from '../bass/timbres';
import { PHRASES, type ChordSet } from './material';
import type { PianoId } from './pianos';
import type { LhStyle } from './voicing';

export type C2Split = 'tuning' | 'dev' | 'heldOut';
export const VARIATIONS = ['clean', 'human', 'piano', 'lh15', 'peaky'] as const;
export type Variation = (typeof VARIATIONS)[number];
export type Comp = 'whole' | 'block4' | 'arp8';
export type BassPattern = 'whole' | 'half' | 'eighths';

export const C2_SETS: { split: C2Split; letter: string; seeds: number[]; piano: PianoId; bass: (seed: number) => TimbreId }[] = [
  { split: 'tuning', letter: 't', seeds: [1, 2, 3], piano: 'P1', bass: () => 'A' },
  { split: 'dev', letter: 'd', seeds: [4, 5], piano: 'P1', bass: (s) => (s === 4 ? 'A' : 'B') },
  { split: 'heldOut', letter: 'h', seeds: [8, 9], piano: 'P2', bass: () => 'C' },
];
/** Silence rendered after the last bar (release and room tails). */
export const TAIL_SEC = 2;

export interface C2Variant {
  name: string;
  set: ChordSet;
  /** pair only: the phrase id (material.ts PHRASES). */
  phrase?: string;
  variation: Variation;
  seed: number;
  split: C2Split;
  heldOut: boolean;
  piano: PianoId;
  /** Bass instrument timbre, null = piano only. */
  bass: TimbreId | null;
}

const setTag = (set: ChordSet, phrase?: string) => (set === 'pair' ? `pair-${phrase!.toLowerCase()}` : set.toLowerCase());

export function allC2Variants(): C2Variant[] {
  const out: C2Variant[] = [];
  const units: { set: ChordSet; phrase?: string }[] = [
    ...(['B', 'V1', 'V2', 'V3'] as const).map((set) => ({ set })),
    ...PHRASES.map((p) => ({ set: 'pair' as const, phrase: p.id })),
  ];
  for (const u of units)
    for (const s of C2_SETS)
      for (const seed of s.seeds)
        for (const variation of VARIATIONS) {
          if (u.set === 'pair' && (variation === 'lh15' || variation === 'peaky' || (variation === 'clean' && s.split !== 'tuning'))) continue;
          const withBass = variation === 'clean' || variation === 'human' || variation === 'peaky';
          out.push({
            name: `c2-${s.letter}-${setTag(u.set, u.phrase)}-${variation}-s${seed}`,
            ...u,
            variation,
            seed,
            split: s.split,
            heldOut: s.split === 'heldOut',
            piano: s.piano,
            bass: withBass ? s.bass(seed) : null,
          });
        }
  return out;
}

/** The split of a chords2 synthetic file from its name (c2-t / c2-d / c2-h), null when it is not one. */
export function splitOfName(name: string): C2Split | null {
  const m = /^c2-([tdh])-/.exec(name.replace(/^.*\//, ''));
  return m ? (C2_SETS.find((s) => s.letter === m[1])?.split ?? null) : null;
}

/** Named random stream. `perVariation` adds the variation to the key. */
export function streamOf(v: C2Variant, tag: string, o: { perVariation?: boolean } = {}): () => number {
  const salt = v.heldOut ? 'chords2-heldout' : 'chords2';
  return prng(hashSeed(`${salt}:${setTag(v.set, v.phrase)}:s${v.seed}${o.perVariation ? `:${v.variation}` : ''}:${tag}`));
}

const uni = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface C2SynthParams {
  bpm: number;
  /** Silence before bar 0 (a whole number of 10 ms). */
  leadSec: number;
  /** pair: the phrase's transposition (0 for the first tuning seed: the row's own key). */
  transpose: number;
  comp: Comp;
  bassPattern: BassPattern;
  /** The right hand's resting MIDI note (voicing.ts rhVoicing). */
  rhCentre: number;
  lhStyle: LhStyle;
  /** Max timing deviation J (s), 0 = on the grid. */
  jitterSec: number;
  velocitySigma: number;
  peaky: boolean;
  room: Room;
  noiseSnrDb: number | null;
}

export function synthParams(v: C2Variant): C2SynthParams {
  const set = C2_SETS.find((s) => s.split === v.split)!;
  if (!set.seeds.includes(v.seed)) throw new Error(`${v.name}: seed not in the ${v.split} split`);
  const heldOnly = v.piano === 'P2' || v.bass === 'C';
  if (heldOnly !== v.heldOut || v.heldOut !== (v.split === 'heldOut') || v.piano !== set.piano) {
    throw new Error(`${v.name}: piano P2 and bass C are held-out only, and held-out uses only them`);
  }
  if (v.bass !== null && v.bass !== set.bass(v.seed)) throw new Error(`${v.name}: bass timbre not of its split`);
  const score = streamOf(v, 'score');
  const bpm = Math.round(uni(score, 72, 126));
  const leadSec = Math.round(uni(score, 50, 120)) / 100;
  const transpose = v.split === 'tuning' && v.seed === 1 ? 0 : Math.floor(score() * 12);
  const comps: Comp[] = ['whole', 'block4', 'arp8'];
  const comp = comps[Math.floor(score() * comps.length)];
  const patterns: BassPattern[] = ['whole', 'half', 'eighths'];
  const bassPattern = patterns[Math.floor(score() * patterns.length)];
  const rhCentre = Math.round(uni(score, 63, 70));
  const octave = score() < 0.5;
  const lv = streamOf(v, 'level', { perVariation: true });
  const human = v.variation !== 'clean';
  const jitterSec = human ? r3(uni(lv, 0.02, 0.03)) : 0;
  let room: Room = { kind: 'none' };
  if (human) {
    const r = { rt60: r3(uni(lv, 0.3, 0.6)), wet: r3(uni(lv, 0.12, 0.25)) };
    room = v.heldOut ? { kind: 'fdn', ...r } : { kind: 'schroeder', ...r };
  }
  return {
    bpm,
    leadSec,
    transpose,
    comp,
    bassPattern,
    rhCentre,
    lhStyle: v.variation === 'lh15' ? 'fifth' : v.variation === 'piano' && octave ? 'octave' : 'single',
    jitterSec,
    velocitySigma: human ? 8 : 0,
    peaky: v.variation === 'peaky',
    room,
    noiseSnrDb: human ? 35 : null,
  };
}
