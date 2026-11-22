// Spike 7 T5: chord names of the chords2 vocabulary (ts/chords2/vocab.ts: every quality of V0-V3) for the synthetic
// material. Names are written with sharps (render/pianoPart.ts convention); flats are read. `C6/E` = root C, quality
// '6', bass E. The quality names and suffixes come from ts/chords2/vocab.ts only (one place).

import { stageQualities, suffix, templates } from '../../ts/chords2/vocab';

export const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface Chord2 {
  root: number;
  quality: string;
  /** Written bass (`/X`) as a pitch class, null = the root. */
  bass: number | null;
}

/** Every chords2 quality (V3 = all stages), by its written suffix. */
const BY_SUFFIX = new Map(stageQualities('V3').map((q) => [suffix(q), q]));

export function notePc(name: string): number {
  const m = /^([A-G])([#b]?)$/.exec(name);
  if (!m) throw new Error(`bad note name: ${name}`);
  return (NATURAL[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

export function parseChord2(text: string): Chord2 {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(text);
  const quality = m ? BY_SUFFIX.get(m[2]) : undefined;
  if (!m || quality === undefined) throw new Error(`chords2: cannot read chord "${text}"`);
  const root = notePc(m[1]);
  const bass = m[3] === undefined ? null : notePc(m[3]);
  return { root, quality, bass: bass === root ? null : bass };
}

export function chordName(c: Chord2): string {
  return `${SHARP[c.root]}${suffix(c.quality)}${c.bass === null ? '' : `/${SHARP[c.bass]}`}`;
}

/** Name without the `/X`. */
export const upperName = (c: Chord2): string => chordName({ ...c, bass: null });

export const transposeChord = (c: Chord2, k: number): Chord2 => ({
  root: (c.root + k + 120) % 12,
  quality: c.quality,
  bass: c.bass === null ? null : (c.bass + k + 120) % 12,
});

/** The sounding bass pitch class (the `/X`, else the root). */
export const bassPc = (c: Chord2): number => c.bass ?? c.root;

/** Sorted pitch classes of template `form` of the quality (0 = the full form; 1 = V3's no-5th form), plus the bass. */
export function chordPcs(c: Chord2, form = 0): number[] {
  const t = templates(c.quality)[form];
  if (!t) throw new Error(`${chordName(c)}: no template ${form}`);
  return [...new Set([...t.map((i) => (c.root + i) % 12), bassPc(c)])].sort((a, b) => a - b);
}
