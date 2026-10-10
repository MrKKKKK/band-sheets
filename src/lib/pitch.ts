import { diatonicChords } from './keys';

/**
 * Pitch model and helpers (docs/m4-plan.md decision 3, docs/m4-decisions.md
 * key operations). A `Pitch` is a letter A–G, an optional single accidental
 * and an octave 0–8 (scientific pitch notation, C4 = middle C = MIDI 60).
 */

export type Letter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type Accidental = '' | '#' | 'b';

export interface Pitch {
  letter: Letter;
  accidental: Accidental;
  octave: number;
}

const PITCH = /^([A-G])([#b]?)([0-8])$/;

/** Strict pitch parser: "C4", "C#4", "Db4"… Anything else → null. */
export function parsePitch(s: string): Pitch | null {
  const m = PITCH.exec(s);
  if (!m) return null;
  return {
    letter: m[1] as Letter,
    accidental: m[2] as Accidental,
    octave: Number(m[3]),
  };
}

export function formatPitch(p: Pitch): string {
  return `${p.letter}${p.accidental}${p.octave}`;
}

const LETTER_PC: Record<Letter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** MIDI note number; C4 = 60. */
export function pitchToMidi(p: Pitch): number {
  const pc =
    LETTER_PC[p.letter] +
    (p.accidental === '#' ? 1 : p.accidental === 'b' ? -1 : 0);
  return (p.octave + 1) * 12 + pc;
}

const SHARP_SPELLING: [Letter, Accidental][] = [
  ['C', ''],
  ['C', '#'],
  ['D', ''],
  ['D', '#'],
  ['E', ''],
  ['F', ''],
  ['F', '#'],
  ['G', ''],
  ['G', '#'],
  ['A', ''],
  ['A', '#'],
  ['B', ''],
];

const FLAT_SPELLING: [Letter, Accidental][] = [
  ['C', ''],
  ['D', 'b'],
  ['D', ''],
  ['E', 'b'],
  ['E', ''],
  ['F', ''],
  ['G', 'b'],
  ['G', ''],
  ['A', 'b'],
  ['A', ''],
  ['B', 'b'],
  ['B', ''],
];

/**
 * Whether `key` is spelled with sharps or flats (circle of fifths): a sharp
 * key, C or Am → sharps; a flat key → flats. No key / invalid key → sharps.
 * Derived from `diatonicChords`: a flat key's diatonic triads contain a
 * letter+'b', a sharp key's contain a letter+'#' (C/Am's are all natural).
 */
function keyDirection(key?: string): 'sharp' | 'flat' {
  if (!key) return 'sharp';
  const chords = diatonicChords(key);
  return chords.some((c) => c.includes('b')) ? 'flat' : 'sharp';
}

/**
 * Spells a MIDI note number as a Pitch, sharps for sharp keys/C/Am and
 * flats for flat keys (see `keyDirection`). No key → sharps.
 */
export function midiToPitch(midi: number, key?: string): Pitch {
  const octave = Math.floor(midi / 12) - 1;
  const pc = ((midi % 12) + 12) % 12;
  const table = keyDirection(key) === 'flat' ? FLAT_SPELLING : SHARP_SPELLING;
  const [letter, accidental] = table[pc];
  return { letter, accidental, octave };
}

/** Transposes by `semitones`, re-spelling the result per `key`. */
export function transpose(p: Pitch, semitones: number, key?: string): Pitch {
  return midiToPitch(pitchToMidi(p) + semitones, key);
}

/** Shifts the octave by ±1, keeping the same letter/accidental spelling. */
export function transposeOctave(p: Pitch, direction: 1 | -1): Pitch {
  return { ...p, octave: p.octave + direction };
}

/**
 * KeyboardEvent.code → semitone above the base octave's C, per
 * docs/m4-decisions.md's key table (A S D F G H J K = white keys C…C,
 * W E T Y U = black keys). Unknown code → null.
 */
const CODE_SEMITONES: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
};

export function codeToSemitone(code: string): number | null {
  return code in CODE_SEMITONES ? CODE_SEMITONES[code] : null;
}

/** The pitch `semitone` half-steps above C of `baseOctave`, respelled per `key`. */
export function semitoneToPitch(
  baseOctave: number,
  semitone: number,
  key?: string,
): Pitch {
  return midiToPitch((baseOctave + 1) * 12 + semitone, key);
}

const DIATONIC_LETTERS: Letter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * Treble clef staff position: diatonic steps (letter only, accidental
 * ignored) from the bottom line E4 (E4 = 0, F4 = 1, G4 = 2, …, F5 = 8,
 * C4 = -2).
 */
export function staffStep(p: Pitch): number {
  const idx = DIATONIC_LETTERS.indexOf(p.letter);
  return p.octave * 7 + idx - 30;
}

/**
 * Inverse of `staffStep`: the natural letter/octave at that staff position,
 * with the accidental from the key signature for that letter (naturals if
 * no key, or a key with no accidental on that letter).
 */
export function stepToPitch(step: number, key?: string): Pitch {
  const absolute = step + 30;
  const octave = Math.floor(absolute / 7);
  const idx = ((absolute % 7) + 7) % 7;
  const letter = DIATONIC_LETTERS[idx];
  const accidental = keyAccidentals(key)[letter] ?? '';
  return { letter, accidental, octave };
}

/**
 * The key signature's accidentals, one per letter that has one (e.g. key G
 * → { F: '#' }, key F → { B: 'b' }, key C/Am → {}). Derived from the first 7
 * `diatonicChords` entries (the scale degrees; a minor key's appended 8th,
 * harmonic-V entry is not a scale degree and is ignored). No key / invalid
 * key → {}.
 */
export function keyAccidentals(
  key?: string,
): Partial<Record<Letter, '#' | 'b'>> {
  const chords = key ? diatonicChords(key).slice(0, 7) : [];
  const out: Partial<Record<Letter, '#' | 'b'>> = {};
  for (const chord of chords) {
    const m = /^([A-G])([#b]?)/.exec(chord);
    if (!m) continue;
    const [, letter, accidental] = m;
    if (accidental === '#' || accidental === 'b') {
      out[letter as Letter] = accidental;
    }
  }
  return out;
}
