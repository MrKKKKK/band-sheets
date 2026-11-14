/**
 * Helpers shared by the bass evaluation tools (segment_eval, t9_sweep, rec_eval, baseline, root_regression,
 * heldout_eval, heldout_guard). Not a CLI: importing it runs nothing.
 */
import { readFileSync } from 'node:fs';
import { NOTE_NAMES } from '../dsp/chords';
import { noteToPc, type ScoreChord } from './score';
import { slashChordsOf, type SlashMark } from './slash';

/** Value after the flag `k` in argv, or undefined. */
export const argOf = (argv: string[], k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

export const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** Parsed file reduced by `pick`; null when the file is missing or unparsable. */
export const readJson = <T>(p: string, pick: (j: any) => T): T | null => {
  try {
    return pick(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
};

/** The chord whose [start, end) holds t. */
export const at = <C extends { start: number; end: number }>(cs: readonly C[], t: number): C | undefined => cs.find((c) => c.start <= t && t < c.end);

/** JSON-lines text (e.g. out/results/heldout-log.jsonl) to objects; blank lines skipped, null = no file. */
export const parseJsonl = <T>(text: string | null): T[] =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/** B-2 input of score chords (roots by noteToPc, flats ok). */
export const slashIn = (chords: readonly ScoreChord[], beats: readonly number[]) => slashChordsOf(chords, beats, noteToPc);

/** Chords with only the B-2 marks as `/X` (sharp names): the bass of every unmarked chord is cleared. */
export const withSlashMarks = (chords: readonly ScoreChord[], marks: readonly (SlashMark | null)[]): ScoreChord[] =>
  chords.map((c, i) => ({ ...c, bass: marks[i] ? NOTE_NAMES[marks[i]!.bass] : null }));
