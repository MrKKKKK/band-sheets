// Spike 7 T5: how a pianist voices a chords2 chord (user, 2026-11-15: right hand = a comfortable inversion of the
// chord, left hand = the bass; a passing bass under an unchanged chord keeps the right-hand shape, `C -> C/D -> C/E`).
//
// Right hand (handPcs + rhVoicing):
//   - a close-position inversion (every pitch class once, stacked within an octave) between RH_LO and RH_HI;
//   - a 4-note chord whose bass is one of its tones leaves that tone to the left hand (C7 -> E G Bb over C,
//     Am7/G -> A C E over G, Am6 -> C E F# over A): the usual shell. Triads keep all three (C/E -> C E G over E);
//     a bass outside the chord (C/D) leaves the right hand as it is;
//   - the inversion is the one closest to the previous right hand (sum of nearest-note moves both ways), plus a pull
//     towards the variant's centre so the hand does not drift; an unchanged chord therefore keeps its exact shape.
// 9th chords (V3, plan section 2.2 "9 の 3 つの弾き方"), bass = root:
//   full      RH 3-7-9, LH root + 5th  (all five tones)
//   no5       RH 3-7-9, LH root        (template 2 of ts/chords2/vocab.ts, the no-5th form)
//   rootless  RH 3-5-7-9, LH root      (the right hand alone is a 4-note chord a 3rd up: C9 -> Em7b5)
// Left hand (lhNotes): the bass in C2..B2 ('single'), with its octave ('octave'), or with its 5th when the bass is the
// root of a chord with a perfect 5th ('fifth': the "left hand 1-5" guard of plan section 3.1; not on 9th chords,
// whose form decides where the 5th is).

import { templates } from '../../ts/chords2/vocab';
import { bassPc, chordPcs, type Chord2 } from './chordName';

export const NINE_FORMS = ['full', 'no5', 'rootless'] as const;
export type NineForm = (typeof NINE_FORMS)[number];
export const isNine = (quality: string): boolean => quality === '9' || quality === 'm9' || quality === 'maj9';

/** Right-hand range (G3..A5); the left hand stays at or below F#3 (lhNotes), so the hands never share a key. */
export const RH_LO = 55;
export const RH_HI = 81;
/** Left hand: the bass from C2 (36) to B2; octave below down to E1 (28), else above. */
export const LH_LO = 36;
export const LH_MIN = 28;
export type LhStyle = 'single' | 'octave' | 'fifth';

// 7th voicing variations (spike 8 T3; tuning and dev material only, never the hold-out): how a pianist places the 7th
// of a seventh chord. They change only the right hand of a chord whose quality is in SEVENTH_QUALITIES (9th chords
// keep their own forms; every other chord is voiced as before, so the other files are unchanged).
//   top    the 7th is the highest right-hand note
//   inner  the 7th is neither the highest nor the lowest right-hand note
//   no5    the right hand leaves the 5th out (only 7, maj7, min7, mM7: without the 5th of m7b5 / dim7 the chord reads as
//          another one); a 5th that is the written bass is still played by the left hand
//   wide   open spread: the close inversion with every other note raised an octave (over an octave and a half)
export const VOICINGS7 = ['top', 'inner', 'no5', 'wide'] as const;
export type Voicing7 = (typeof VOICINGS7)[number];
export const SEVENTH_QUALITIES: readonly string[] = ['7', 'maj7', 'min7', 'mM7', 'm7b5', 'dim7', '7sus4'];
const NO5_QUALITIES: readonly string[] = ['7', 'maj7', 'min7', 'mM7'];
/** Wide voicings may reach this far above RH_HI (the open top note). */
export const WIDE_HI = RH_HI + 7;

/** The voicing in force for a chord (undefined = as always). */
export function voicing7Of(c: Chord2, v?: Voicing7): Voicing7 | undefined {
  return v !== undefined && SEVENTH_QUALITIES.includes(c.quality) ? v : undefined;
}
export const seventhPc = (c: Chord2): number => (c.root + templates(c.quality)[0].at(-1)!) % 12;
const fifthPc = (c: Chord2): number => (c.root + templates(c.quality)[0][2]) % 12;

/** Pitch classes sounding in a chord as played (template form plus the bass, minus a dropped 5th). */
export function soundedPcs(c: Chord2, form?: NineForm, v?: Voicing7): number[] {
  const all = chordPcs(c, form === 'no5' ? 1 : 0);
  if (voicing7Of(c, v) !== 'no5' || !NO5_QUALITIES.includes(c.quality)) return all;
  const five = fifthPc(c);
  return five === bassPc(c) ? all : all.filter((p) => p !== five);
}

/** Pitch classes of the right hand, and the left hand's intervals above the bass. */
export function handPcs(c: Chord2, form?: NineForm, v?: Voicing7): { rh: number[]; lhAbove: number[] } {
  const iv = templates(c.quality)[0];
  const pc = (i: number) => (c.root + i) % 12;
  const b = bassPc(c);
  if (isNine(c.quality)) {
    if (c.bass !== null) throw new Error('9th chords are voiced over their root only');
    const [, ninth, third, fifth, seventh] = iv; // [0, 2, 3|4, 7, 10|11]
    const f = form ?? 'full';
    const rh = f === 'rootless' ? [third, fifth, seventh, ninth] : [third, seventh, ninth];
    return { rh: rh.map(pc), lhAbove: f === 'full' ? [7] : [] };
  }
  const pcs = iv.map(pc);
  let rh = pcs.length >= 4 && pcs.includes(b) ? pcs.filter((p) => p !== b) : pcs;
  if (voicing7Of(c, v) === 'no5' && NO5_QUALITIES.includes(c.quality)) rh = rh.filter((p) => p !== fifthPc(c));
  return { rh, lhAbove: [] };
}

/** Every close-position inversion of the pitch classes inside the right-hand range (ascending MIDI notes). */
export function rhCandidates(pcs: readonly number[]): number[][] {
  const sorted = [...new Set(pcs)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (let r = 0; r < sorted.length; r++) {
    const order = [...sorted.slice(r), ...sorted.slice(0, r)];
    for (let n0 = RH_LO; n0 < RH_LO + 24; n0++) {
      if (n0 % 12 !== order[0]) continue;
      const notes = [n0];
      for (const p of order.slice(1)) notes.push(notes[notes.length - 1] + ((p - notes[notes.length - 1] + 120) % 12 || 12));
      if (notes[notes.length - 1] <= RH_HI) out.push(notes);
    }
  }
  return out;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const nearest = (x: number, ys: readonly number[]) => Math.min(...ys.map((y) => Math.abs(x - y)));

/** The shapes of voicing7 that pick or rearrange the close inversions (no5 changes the pitch classes instead). */
function shaped(cands: number[][], seventh: number, v: Voicing7 | undefined): number[][] {
  if (v === 'top') return cands.filter((n) => n[n.length - 1] % 12 === seventh);
  if (v === 'inner') return cands.filter((n) => n.length >= 3 && n[0] % 12 !== seventh && n[n.length - 1] % 12 !== seventh && n.some((m) => m % 12 === seventh));
  if (v === 'wide')
    return cands
      .filter((n) => n.length >= 3)
      .map((n) => n.map((m, i) => (i % 2 === 1 ? m + 12 : m)).sort((x, y) => x - y))
      .filter((n) => n[n.length - 1] <= WIDE_HI);
  return cands;
}

/**
 * The inversion a player would take next (see top); `centre` = the hand's resting MIDI note. `shape` = the chord's
 * 7th voicing and its 7th pitch class (voicing7Of); a shape that no inversion can take falls back to the plain choice.
 */
export function rhVoicing(pcs: readonly number[], prev: readonly number[] | null, centre: number, shape?: { v: Voicing7 | undefined; seventh: number }): number[] {
  const all = rhCandidates(pcs);
  const picked = shape?.v === undefined ? all : shaped(all, shape.seventh, shape.v);
  const cands = picked.length > 0 ? picked : all;
  if (cands.length === 0) throw new Error(`no right-hand voicing for pitch classes ${pcs.join(',')}`);
  const cost = (v: number[]) =>
    prev === null
      ? Math.abs(mean(v) - centre)
      : v.reduce((a, x) => a + nearest(x, prev), 0) + prev.reduce((a, x) => a + nearest(x, v), 0) + 0.25 * Math.abs(mean(v) - centre);
  let best = cands[0];
  for (const v of cands) if (cost(v) < cost(best) - 1e-9) best = v;
  return best;
}

/** Left-hand MIDI notes (see top). `lhAbove` from handPcs (the full 9th's 5th) is always added. */
export function lhNotes(c: Chord2, style: LhStyle, lhAbove: readonly number[] = []): number[] {
  const b = LH_LO + bassPc(c);
  const fifthOk = c.bass === null && !isNine(c.quality) && templates(c.quality)[0].includes(7); // a 9th's form owns its 5th
  const extra = style === 'octave' ? [b - 12 >= LH_MIN ? b - 12 : b + 12] : style === 'fifth' && fifthOk ? [b + 7] : [];
  return [...new Set([b, ...extra, ...lhAbove.map((i) => b + i)])].sort((x, y) => x - y);
}
