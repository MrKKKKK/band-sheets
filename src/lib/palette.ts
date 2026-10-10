import { isValidChordText, usedChords } from './chordText';
import { diatonicChords } from './keys';
import type { Song } from './song';

export interface PaletteGroups {
  /** meta.palette, as stored in {x_palette:}. */
  user: string[];
  /** Chart chords in order of first appearance. */
  used: string[];
  /** Diatonic triads of meta.key ([] when the key is missing/invalid). */
  diatonic: string[];
  /** user → used → diatonic, deduplicated (first occurrence wins). */
  all: string[];
}

export function paletteGroups(song: Song): PaletteGroups {
  // meta.palette keeps the raw x_palette text verbatim for round-trip (even
  // when hand-edited into something invalid, e.g. a stray "]"); only the
  // derived groups shown as chips filter it through isValidChordText (R12).
  const user = (song.meta.palette ?? []).filter(isValidChordText);
  const used = usedChords(song);
  const diatonic = diatonicChords(song.meta.key ?? '');
  const all = [...new Set([...user, ...used, ...diatonic])];
  return { user: [...user], used, diatonic, all };
}

/**
 * Appends a chord (trimmed) to meta.palette. Invalid chord text or a chord
 * already in the palette → the same song object.
 */
export function addToPalette(song: Song, chord: string): Song {
  if (!isValidChordText(chord)) return song;
  const c = chord.trim();
  const palette = song.meta.palette ?? [];
  if (palette.includes(c)) return song;
  return { ...song, meta: { ...song.meta, palette: [...palette, c] } };
}

/** Removes a chord from meta.palette; not present → the same song object. */
export function removeFromPalette(song: Song, chord: string): Song {
  const palette = song.meta.palette ?? [];
  if (!palette.includes(chord)) return song;
  return {
    ...song,
    meta: { ...song.meta, palette: palette.filter((c) => c !== chord) },
  };
}
