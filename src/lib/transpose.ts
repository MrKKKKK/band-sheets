/**
 * Display-only transposition (issue #7). Pure helpers for the viewer: the
 * song text is never rewritten, the viewer just shows chords / keys shifted.
 *
 * Spelling (sharp vs flat) follows the TARGET key: a flat key → flats, a
 * sharp key → sharps. For C / Am / no key the input's own accidental style
 * decides (Bb stays flat-style), and a plain note then goes by direction
 * (up → sharp, down → flat).
 *
 * The score (notes, key signature, `ch` chord names) is transposed on the
 * alphaTab model: see transposeScore.ts.
 */
import { parseKey } from './keys';
import { isRawLine, type ChartSection } from './song';

export const TRANSPOSE_MIN = -6;
export const TRANSPOSE_MAX = 6;

/** Round to a whole semitone and clamp to −6..+6; non-finite → 0. */
export function clampTranspose(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(TRANSPOSE_MAX, Math.max(TRANSPOSE_MIN, Math.round(n)));
}

/** 0 → "0", 3 → "+3", −2 → "−2" (U+2212). */
export function formatTranspose(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `−${-n}`;
}

const LETTER_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FIFTHS: Record<string, number> = {
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
};

const mod = (n: number, m: number) => ((n % m) + m) % m;

function pcOf(name: string): number {
  const acc = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
  return mod(LETTER_PC[name[0]] + acc, 12);
}

/** Position on the circle of fifths of a MAJOR key named `name`. */
function majorFifths(name: string): number {
  const acc = name[1] === '#' ? 7 : name[1] === 'b' ? -7 : 0;
  return FIFTHS[name[0]] + acc;
}

/**
 * The key `semitones` away, spelled with the fewest accidentals (never more
 * than 7). A tie (6 sharps vs 6 flats) goes by direction: up → sharps. Minor
 * keys keep their "m". Invalid / missing key → null.
 */
export function transposeKey(
  key: string | undefined,
  semitones: number,
): string | null {
  const parsed = key === undefined ? null : parseKey(key);
  if (!parsed) return null;
  const tonic = parsed.tonic + parsed.accidental;
  const pc = mod(pcOf(tonic) + semitones, 12);
  const candidates = [SHARP[pc], FLAT[pc]];
  const count = (name: string) =>
    parsed.minor ? majorFifths(name) - 3 : majorFifths(name);
  let best: string | null = null;
  for (const c of candidates) {
    const n = Math.abs(count(c));
    if (n > 7) continue;
    if (best === null || n < Math.abs(count(best))) best = c;
    else if (n === Math.abs(count(best)) && c !== best && semitones < 0) {
      best = FLAT[pc]; // tie, going down → flats
    }
  }
  // For the up-direction tie SHARP[pc] was tried first and is kept.
  return (best ?? SHARP[pc]) + (parsed.minor ? 'm' : '');
}

/** Key signature as a number of accidentals (−7..7, − = flats), or null. */
export function keyFifths(key: string | undefined): number | null {
  const parsed = key === undefined ? null : parseKey(key);
  if (!parsed) return null;
  const major = majorFifths(parsed.tonic + parsed.accidental);
  const n = parsed.minor ? major - 3 : major;
  return Math.abs(n) <= 7 ? n : null;
}

function spell(pc: number, flats: boolean): string {
  return (flats ? FLAT : SHARP)[pc];
}

/** true = flats. `style` is the input chord's own accidental style. */
function preferFlats(
  targetKey: string | undefined,
  semitones: number,
  style: '#' | 'b' | '',
): boolean {
  const parsed = targetKey === undefined ? null : parseKey(targetKey);
  if (parsed) {
    const name = parsed.tonic + parsed.accidental;
    const fifths = parsed.minor ? majorFifths(name) - 3 : majorFifths(name);
    if (fifths < 0) return true;
    if (fifths > 0) return false;
    // C / Am: neutral, fall through
  }
  if (style === 'b') return true;
  if (style === '#') return false;
  return semitones < 0;
}

const CHORD = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

/**
 * Shifts a chord's root and slash bass; the quality / extensions (`m7`,
 * `add9`, `sus4`, `(b9)` …) are kept verbatim. Text that is not a chord
 * (`N.C.`, `(C)`, …) is returned unchanged.
 */
export function transposeChord(
  text: string,
  semitones: number,
  targetKey: string | undefined,
): string {
  if (semitones === 0) return text;
  return shiftChord(text, semitones, targetKey);
}

/**
 * The same chord respelled for `targetKey` (a transposition by 0 semitones
 * into that key): a flat key → flats, a sharp key → sharps, C / Am / no key →
 * the chord's own accidental style. Quality verbatim; a trailing `?` (draft
 * mark) is kept; non-chord text (`N.C.`) is returned unchanged.
 */
export function respellChord(
  text: string,
  targetKey: string | undefined,
): string {
  const mark = text.endsWith('?') ? '?' : '';
  const body = mark ? text.slice(0, -1) : text;
  return shiftChord(body, 0, targetKey) + mark;
}

function shiftChord(
  text: string,
  semitones: number,
  targetKey: string | undefined,
): string {
  const m = CHORD.exec(text);
  if (!m) return text;
  const [, root, quality, bass] = m;
  const style = root.endsWith('b') ? 'b' : root.endsWith('#') ? '#' : '';
  const bassStyle = bass?.endsWith('b') ? 'b' : bass?.endsWith('#') ? '#' : '';
  const shift = (name: string, s: '#' | 'b' | '') =>
    spell(
      mod(pcOf(name) + semitones, 12),
      preferFlats(targetKey, semitones, s),
    );
  return (
    shift(root, style) +
    quality +
    (bass === undefined ? '' : `/${shift(bass, bassStyle as '#' | 'b' | '')}`)
  );
}

/** The section with every chord transposed (same object at 0). */
export function transposeChartSection(
  section: ChartSection,
  semitones: number,
  targetKey: string | undefined,
): ChartSection {
  if (semitones === 0) return section;
  return {
    ...section,
    lines: section.lines.map((line) =>
      isRawLine(line)
        ? line
        : {
            ...line,
            segments: line.segments.map((seg) =>
              seg.chord === undefined
                ? seg
                : {
                    ...seg,
                    chord: transposeChord(seg.chord, semitones, targetKey),
                  },
            ),
          },
    ),
  };
}

/** "Bb" → "B♭", "F#m" → "F♯m" (display only). */
export function displayKey(key: string): string {
  return key.replace(/^([A-G])b/, '$1♭').replace(/^([A-G])#/, '$1♯');
}

/**
 * The viewer's key label: "キー C" at 0, "キー C → B♭（−2）" otherwise;
 * null when the song has no usable key.
 */
export function keyLabel(
  key: string | undefined,
  semitones: number,
): string | null {
  if (key === undefined || parseKey(key) === null) return null;
  if (semitones === 0) return `キー ${displayKey(key)}`;
  const to = transposeKey(key, semitones);
  if (to === null) return null;
  return `キー ${displayKey(key)} → ${displayKey(to)}（${formatTranspose(semitones)}）`;
}
