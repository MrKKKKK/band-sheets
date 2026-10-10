// Piano accompaniment from a chord timeline (docs/audio-spike0-plan.md, T4;
// design decision 4): one quarter-note chord per beat, left hand = root (or
// slash bass) in C2-B2, right hand = close-position voicing near C4.
// Spelling uses sharps only. alphaTab octave convention: C4 = MIDI 60.

import { parseChordSymbol } from './chordSymbol';
import { chordsPerBeat } from './chordTimeline';
import type { ChordQuality, ChordTimeline } from './types';

const SHARP_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus4: [0, 5, 7],
};

/** alphaTex note name of a MIDI note (C4 = 60), e.g. 61 -> "C#4". */
export function noteName(midi: number): string {
  return `${SHARP_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** MIDI notes of a chord: left hand first (36-47), then the right hand. */
export function chordMidi(text: string): number[] {
  const c = parseChordSymbol(text);
  const low = 36 + (c.bass ?? c.root);
  // Root in 55..66 so the voicing stays around C4.
  const rh = c.root <= 6 ? 60 + c.root : 48 + c.root;
  return [low, ...CHORD_INTERVALS[c.quality].map((i) => rh + i)];
}

/** Part body (for `{start_of_part: Piano}`), with one `\section` per section. */
export function pianoPartBody(timeline: ChordTimeline): string {
  const perBeat = chordsPerBeat(timeline);
  const lines: string[] = [];
  for (const sec of timeline.sections) {
    lines.push(`\\section "${sec.label}"`);
    for (let b = 0; b < sec.bars; b++) {
      const row = perBeat[sec.startBar + b];
      const beats = row.map((text) => {
        if (text === null) throw new Error('コードの無い拍があります');
        return `(${chordMidi(text).map(noteName).join(' ')})`;
      });
      lines.push(`${b === 0 ? ':4 ' : ''}${beats.join(' ')} |`);
    }
  }
  return lines.join('\n');
}
