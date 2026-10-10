export interface ParsedKey {
  /** Letter name A–G. */
  tonic: string;
  accidental: '' | '#' | 'b';
  minor: boolean;
}

const KEY = /^([A-G])([#b]?)(m?)$/;

/** Strict key parser: "C", "F#m", "Bb"… Anything else → null. */
export function parseKey(key: string): ParsedKey | null {
  const m = KEY.exec(key);
  if (!m) return null;
  return {
    tonic: m[1],
    accidental: m[2] as ParsedKey['accidental'],
    minor: m[3] === 'm',
  };
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_QUALITIES = ['', 'm', 'm', '', '', 'm', 'dim'];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const MINOR_QUALITIES = ['m', 'dim', '', 'm', 'm', '', ''];

/**
 * Diatonic triads of a key, spelled by letter names (one letter per degree,
 * #/b chosen from the semitone distance). Major: I ii iii IV V vi vii°.
 * Minor: natural-minor i ii° III iv v VI VII, then the harmonic V (major).
 * Invalid key → [].
 */
export function diatonicChords(key: string): string[] {
  const parsed = parseKey(key);
  if (!parsed) return [];
  const tonicIdx = LETTERS.indexOf(parsed.tonic);
  const tonicPc =
    LETTER_PC[tonicIdx] +
    (parsed.accidental === '#' ? 1 : parsed.accidental === 'b' ? -1 : 0);

  const note = (degree: number, semitones: number): string => {
    const idx = (tonicIdx + degree) % 7;
    const offset = mod(tonicPc + semitones - LETTER_PC[idx] + 6, 12) - 6;
    const accidental = offset > 0 ? '#'.repeat(offset) : 'b'.repeat(-offset);
    return LETTERS[idx] + accidental;
  };

  const steps = parsed.minor ? MINOR_STEPS : MAJOR_STEPS;
  const qualities = parsed.minor ? MINOR_QUALITIES : MAJOR_QUALITIES;
  const chords = steps.map((s, i) => note(i, s) + qualities[i]);
  if (parsed.minor) chords.push(note(4, 7));
  return chords;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
