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

export type Comp = 'block4' | 'arp8' | 'whole';

/** Chord-tone index per 8th note of an `arp8` bar (0 = bass, 1-3 = right hand low to high). */
const ARP8_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3];

/** alphaTex duration (with optional dot) of `beats` quarter notes, or null. */
const WHOLE_DURATION: Record<number, string> = { 1: ':4', 2: ':2', 3: ':2', 4: ':1' };

function barLine(comp: Comp, row: (string | null)[]): string {
  const chordAt = (b: number) => {
    const text = row[b];
    if (text === null) throw new Error('コードの無い拍があります');
    return text;
  };
  if (comp === 'block4') {
    return row.map((_, b) => `(${chordMidi(chordAt(b)).map(noteName).join(' ')})`).join(' ');
  }
  if (comp === 'arp8') {
    // Two 8th notes per beat, each beat arpeggiating that beat's chord.
    const out: string[] = [];
    for (let i = 0; i < row.length * 2; i++) {
      const tones = chordMidi(chordAt(i >> 1));
      out.push(noteName(tones[ARP8_PATTERN[i % ARP8_PATTERN.length] % tones.length]));
    }
    return out.join(' ');
  }
  // whole: one chord per bar; a bar with a change splits at the change.
  const segs: { text: string; beats: number }[] = [];
  for (let b = 0; b < row.length; b++) {
    const text = chordAt(b);
    if (segs.length > 0 && segs[segs.length - 1].text === text) segs[segs.length - 1].beats++;
    else segs.push({ text, beats: 1 });
  }
  return segs
    .map(({ text, beats }) => {
      const notes = `(${chordMidi(text).map(noteName).join(' ')})`;
      const dur = WHOLE_DURATION[beats];
      if (dur === undefined) throw new Error(`白玉の長さ ${beats} 拍は扱えません`);
      return `${dur} ${notes}${beats === 3 ? ' {d}' : ''}`;
    })
    .join(' ');
}

/** Part body (for `{start_of_part: Piano}`), with one `\section` per section. */
export function pianoPartBody(timeline: ChordTimeline, comp: Comp = 'block4'): string {
  const perBeat = chordsPerBeat(timeline);
  const lines: string[] = [];
  const unit = comp === 'arp8' ? ':8 ' : comp === 'block4' ? ':4 ' : '';
  for (const sec of timeline.sections) {
    lines.push(`\\section "${sec.label}"`);
    for (let b = 0; b < sec.bars; b++) {
      const row = perBeat[sec.startBar + b];
      lines.push(`${b === 0 ? unit : ''}${barLine(comp, row)} |`);
    }
  }
  return lines.join('\n');
}
