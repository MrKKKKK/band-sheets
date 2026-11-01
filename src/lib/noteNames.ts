import { parsePitch } from './pitch';

/** How S4 / the melody views name pitches (stored per device by storage.ts). */

export type NoteNameMode = 'doremi' | 'letter' | 'none';

export const NOTE_NAME_MODES: readonly {
  value: NoteNameMode;
  label: string;
}[] = [
  { value: 'doremi', label: 'ドレミ' },
  { value: 'letter', label: 'C D E' },
  { value: 'none', label: '表示しない' },
];

const DOREMI: Record<string, string> = {
  C: 'ド',
  D: 'レ',
  E: 'ミ',
  F: 'ファ',
  G: 'ソ',
  A: 'ラ',
  B: 'シ',
};

const ACCIDENTAL: Record<string, string> = { '': '', '#': '♯', b: '♭' };

/** 'F#4' → 「ファ♯」 / 「F♯」 / '' (no octave: the staff shows it). '' for 'none' or an unreadable pitch. */
export function noteName(pitch: string, mode: NoteNameMode): string {
  const p = parsePitch(pitch);
  if (!p || mode === 'none') return '';
  const letter = mode === 'doremi' ? DOREMI[p.letter] : p.letter;
  return `${letter}${ACCIDENTAL[p.accidental]}`;
}
