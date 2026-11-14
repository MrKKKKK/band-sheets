/**
 * Helpers shared by the bass evaluation tools (segment_eval, t9_sweep, rec_eval, baseline, root_regression,
 * heldout_eval, heldout_guard). Not a CLI: importing it runs nothing.
 */
import { readFileSync } from 'node:fs';
import { noteToPc, type ScoreChord } from './score';
import { slashChordsOf, withSlash, type SlashMark } from './slash';

/** Value after the flag `k` in argv, or undefined. */
export const argOf = (argv: string[], k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

export const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

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
export function withSlashMarks(chords: readonly ScoreChord[], marks: readonly (SlashMark | null)[]): ScoreChord[] {
  return withSlash(
    chords.map((c) => ({ ...c, bass: null as string | null })),
    marks,
  );
}
