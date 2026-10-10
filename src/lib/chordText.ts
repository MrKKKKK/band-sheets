import { isRawLine, type Song } from './song';

/**
 * Chord text accepted for palette / chord input: non-empty after trimming,
 * no inner whitespace and no `[ ] { }` (which would break ChordPro syntax).
 * Anything else is opaque, e.g. "(C)", "N.C.", "C7(9,13)", "Bm7(b5)".
 */
export function isValidChordText(s: string): boolean {
  return /^[^\s[\]{}]+$/.test(s.trim());
}

/** Chart chords (not parts), unique, in order of first appearance. */
export function usedChords(song: Song): string[] {
  const seen = new Set<string>();
  for (const section of song.chart) {
    for (const line of section.lines) {
      if (isRawLine(line)) continue;
      for (const { chord } of line.segments) {
        if (chord !== undefined) seen.add(chord);
      }
    }
  }
  return [...seen];
}
