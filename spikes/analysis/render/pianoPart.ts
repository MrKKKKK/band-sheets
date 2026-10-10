// Piano accompaniment from a chord timeline (docs/audio-spike0-plan.md, T4;
// design decision 4): one quarter-note chord per beat, left hand = root (or
// slash bass) in C2-B2, right hand = close-position voicing near C4.
// Spelling uses sharps only. alphaTab octave convention: C4 = MIDI 60.

import { parseChordSymbol } from './chordSymbol';
import { prng } from './prng';
import { chordsPerBeat } from './chordTimeline';
import type { ChordQuality, ChordTimeline, TimelineChord } from './types';

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
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
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

export type Comp = 'block4' | 'arp8' | 'whole' | 'rec';

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
  if (comp === 'rec') throw new Error("comp 'rec' は recComp で作ってください（正解のコードの時刻も変わるため）");
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

// ---------------------------------------------------------------------------
// REC-like accompaniment (docs/audio-spike2-plan.md, design decision 3, T4).
// Imitates a PLAYING STYLE only (no song material of any recording):
// - left hand: eighth-note 1-5-8-5 arpeggio from the bass (slash bass or root),
//   restarting on the bass at every chord start and every half bar;
// - right hand: 2 of the chord's tones (third + fifth / root + third; 7th
//   chords third + seventh), per chord span from the seed, in a per-bar rhythm
//   pattern, re-struck at every chord change;
// - top voice: short melody figures (eighths / sixteenths) above the right
//   hand, partly non-chord tones (neighbour / passing);
// - a chord change on a bar head or half bar is anticipated by one eighth
//   (`anticipateShare` of them), so the truth chord starts on an eighth-note
//   position (e.g. the "and" of beat 2 for a change written on beat 3);
// - `missShare` of the right-hand hits get an extra note a semitone off
//   (stand-in for a wrong note).
// Three alphaTex voices in one piano staff. x/4 only, 4 beats per bar.

export interface RecCompOptions {
  seed?: number;
  /** Share of eligible chord changes anticipated by one eighth (default 0.35). */
  anticipateShare?: number;
  /** Share of right-hand hits with a wrong-note semitone (default 0.06). */
  missShare?: number;
  /** Share of beats carrying a melody figure (default 0.5). */
  melodyShare?: number;
  /** Share of melody notes that are non-chord tones (default 0.3). */
  nonChordShare?: number;
  /** Pickup beats in bar 0 (the rest of bar 0 is silent); default 0. */
  pickupBeats?: number;
}

export const REC_DEFAULTS = {
  seed: 1,
  anticipateShare: 0.35,
  missShare: 0.06,
  melodyShare: 0.5,
  nonChordShare: 0.3,
  pickupBeats: 0,
} as const;

/** Right-hand rhythm patterns per bar: [start, length] in eighths. */
const RH_PATTERNS: [number, number][][] = [
  [[0, 2], [2, 2], [4, 2], [6, 2]],
  [[0, 3], [3, 3], [6, 2]],
  [[0, 2], [3, 1], [4, 2], [7, 1]],
  [[1, 1], [2, 2], [5, 1], [6, 2]],
  [[0, 4], [4, 4]],
];
/** Melody figures per beat: [start, length] in sixteenths. */
const MELODY_FIGURES: [number, number][][] = [
  [[0, 2]],
  [[2, 2]],
  [[2, 1], [3, 1]],
  [[0, 1], [1, 1]],
];
/** alphaTex duration of a length in sixteenths (dotted where needed). */
const DUR16: Record<number, string> = {
  1: ':16', 2: ':8', 3: ':8 {d}', 4: ':4', 6: ':4 {d}', 8: ':2', 12: ':2 {d}', 16: ':1',
};
const DUR16_SIZES = [16, 12, 8, 6, 4, 3, 2, 1];

interface VoiceEvent {
  /** MIDI notes; empty = rest. */
  notes: number[];
  len16: number;
}

function voiceTex(events: VoiceEvent[]): string {
  return events
    .map((e) => {
      const [dur, dot] = DUR16[e.len16].split(' ');
      const body = e.notes.length === 0 ? 'r' : e.notes.length === 1 ? noteName(e.notes[0]) : `(${e.notes.map(noteName).join(' ')})`;
      return `${dur} ${body}${dot ? ` ${dot}` : ''}`;
    })
    .join(' ');
}

/** One bar (16 sixteenths) of hits; gaps become rests. */
function barEvents(hits: { at16: number; len16: number; notes: number[] }[]): VoiceEvent[] {
  const out: VoiceEvent[] = [];
  let pos = 0;
  const rest = (len: number) => {
    while (len > 0) {
      const d = DUR16_SIZES.find((x) => x <= len)!;
      out.push({ notes: [], len16: d });
      len -= d;
    }
  };
  for (const h of [...hits].sort((a, b) => a.at16 - b.at16)) {
    if (h.at16 < pos) throw new Error('recComp: 重なった音');
    rest(h.at16 - pos);
    if (DUR16[h.len16] === undefined) throw new Error(`recComp: 長さ ${h.len16}/16 は書けません`);
    out.push({ notes: h.notes, len16: h.len16 });
    pos = h.at16 + h.len16;
  }
  rest(16 - pos);
  return out;
}

/** Parsed chord, its intervals and its bass pitch class. */
function tonesOf(text: string) {
  const c = parseChordSymbol(text);
  const iv = CHORD_INTERVALS[c.quality];
  return { c, iv, bass: c.bass ?? c.root };
}

/** Lowest MIDI note >= lo with pitch class pc. */
const atOrAbove = (pc: number, lo: number) => lo + ((((pc - lo) % 12) + 12) % 12);

/**
 * REC-like accompaniment for `timeline` (4/4 only). Returns the piano part
 * body (three voices) and the timeline the audio really follows (anticipated
 * changes moved one eighth earlier) — use the latter for the truth.
 */
export function recComp(timeline: ChordTimeline, options: RecCompOptions = {}): { body: string; timeline: ChordTimeline } {
  const o = { ...REC_DEFAULTS, ...options };
  if (timeline.ts[0] !== 4 || timeline.ts[1] !== 4) throw new Error("comp 'rec' は 4/4 の曲だけです");
  if (!(o.pickupBeats >= 0 && o.pickupBeats < 4 && Number.isInteger(o.pickupBeats))) {
    throw new Error(`pickupBeats ${o.pickupBeats} は 0〜3 の整数にしてください`);
  }
  const rnd = prng(o.seed);
  const E = timeline.bars * 8; // eighths
  const firstPlayed = o.pickupBeats > 0 ? 8 : 0; // the pickup bar has only the melody pickup

  // ---- chord changes on the eighth grid, with anticipation ----
  const startE = (c: TimelineChord) => c.bar * 8 + c.beat * 2;
  const changes: { e: number; text: string }[] = [];
  timeline.chords.forEach((c, i) => {
    let e = i === 0 ? 0 : startE(c);
    const r = rnd();
    if (i > 0 && Number.isInteger(c.beat) && c.beat % 2 === 0 && c.text !== timeline.chords[i - 1].text && r < o.anticipateShare) {
      const prev = Math.max(changes[changes.length - 1].e, firstPlayed);
      if (e - 1 >= prev + 2) e -= 1;
    }
    changes.push({ e, text: c.text });
  });
  const chordAt: string[] = [];
  const spanStart: number[] = [];
  for (let e = 0, k = 0; e < E; e++) {
    while (k + 1 < changes.length && changes[k + 1].e <= e) k++;
    chordAt.push(changes[k].text);
    spanStart.push(changes[k].e);
  }
  const outChords: TimelineChord[] = changes.map((c) => ({ bar: Math.floor(c.e / 8), beat: (c.e % 8) / 2, text: c.text }));

  // ---- per chord span: right-hand pair ----
  const pairOf = new Map<number, number[]>(); // span start -> MIDI pair
  const rhPair = (e: number) => {
    const s = spanStart[e];
    let p = pairOf.get(s);
    if (!p) {
      const { c, iv } = tonesOf(chordAt[e]);
      const choices: number[][] =
        iv.length === 4 ? [[1, 3], [1, 3], [0, 1]] : c.quality === 'sus4' ? [[1, 2], [0, 1]] : [[1, 2], [0, 1], [1, 2]];
      const pick = choices[Math.floor(rnd() * choices.length)];
      const lo = atOrAbove((c.root + iv[pick[0]]) % 12, 60);
      const hi = atOrAbove((c.root + iv[pick[1]]) % 12, lo + 1);
      p = [lo, hi];
      pairOf.set(s, p);
    }
    return p;
  };

  const last = timeline.bars - 1;
  const lastBarSingle = new Set(spanStart.slice(last * 8)).size === 1;
  const lh: string[] = [];
  const rh: string[] = [];
  const mel: string[] = [];
  for (let bar = 0; bar < timeline.bars; bar++) {
    const b0 = bar * 8;
    const lhHits: { at16: number; len16: number; notes: number[] }[] = [];
    const rhHits: typeof lhHits = [];
    const melHits: typeof lhHits = [];
    if (bar === 0 && o.pickupBeats > 0) {
      // Pickup: melody only, two eighths per pickup beat on the first chord's tones.
      const { c, iv } = tonesOf(chordAt[8]);
      for (let k = 0; k < o.pickupBeats * 2; k++) {
        const pc = (c.root + iv[k % 2 === 0 ? 2 : 0]) % 12;
        melHits.push({ at16: (4 - o.pickupBeats) * 4 + k * 2, len16: 2, notes: [atOrAbove(pc, 72)] });
      }
    } else if (bar === last && lastBarSingle) {
      const { bass } = tonesOf(chordAt[b0]);
      lhHits.push({ at16: 0, len16: 16, notes: [36 + bass] });
      rhHits.push({ at16: 0, len16: 16, notes: rhPair(b0) });
    } else {
      // Left hand 1-5-8-5 from each chord start / half bar.
      for (let i = 0; i < 8; i++) {
        const e = b0 + i;
        const origin = Math.max(spanStart[e], b0 + (i < 4 ? 0 : 4));
        const { c, iv, bass } = tonesOf(chordAt[e]);
        const one = 36 + bass;
        const five = atOrAbove((c.root + iv[2]) % 12, one + 1);
        lhHits.push({ at16: i * 2, len16: 2, notes: [[one, five, one + 12, five][(e - origin) % 4]] });
      }
      // Right hand: pattern hits plus a hit at every chord change in the bar.
      const pattern = RH_PATTERNS[Math.floor(rnd() * RH_PATTERNS.length)];
      const starts = new Map<number, number>(pattern.map(([s, l]) => [s, l]));
      for (let i = 0; i < 8; i++) if (spanStart[b0 + i] === b0 + i && !starts.has(i)) starts.set(i, 2);
      const sorted = [...starts.keys()].sort((a, b) => a - b);
      sorted.forEach((s, j) => {
        const next = j + 1 < sorted.length ? sorted[j + 1] : 8;
        let end = Math.min(next, s + starts.get(s)!);
        for (let i = s + 1; i < end; i++) if (spanStart[b0 + i] === b0 + i) end = i;
        const notes = [...rhPair(b0 + s)];
        if (rnd() < o.missShare) {
          const n = notes[Math.floor(rnd() * notes.length)] + (rnd() < 0.5 ? -1 : 1);
          if (!notes.includes(n)) notes.push(n);
        }
        rhHits.push({ at16: s * 2, len16: (end - s) * 2, notes: notes.sort((a, b) => a - b) });
      });
      // Melody figures above the right hand.
      if (bar !== last) {
        for (let beat = 0; beat < 4; beat++) {
          if (rnd() >= o.melodyShare) continue;
          const fig = MELODY_FIGURES[Math.floor(rnd() * MELODY_FIGURES.length)];
          let prev: number | null = null;
          for (const [s, l] of fig) {
            const at16 = beat * 4 + s;
            const { c, iv } = tonesOf(chordAt[b0 + Math.floor(at16 / 2)]);
            const chordPcs = iv.map((x) => (c.root + x) % 12);
            let n: number;
            if (prev !== null && rnd() < 0.5) {
              n = prev + [-2, -1, 1, 2][Math.floor(rnd() * 4)];
            } else {
              n = atOrAbove(chordPcs[Math.floor(rnd() * chordPcs.length)], 72);
              if (rnd() < o.nonChordShare) n += [-2, -1, 1, 2][Math.floor(rnd() * 4)];
            }
            melHits.push({ at16, len16: l, notes: [n] });
            prev = n;
          }
        }
      }
    }
    lh.push(`${voiceTex(barEvents(lhHits))} |`);
    rh.push(`${voiceTex(barEvents(rhHits))} |`);
    mel.push(`${voiceTex(barEvents(melHits))} |`);
  }
  const lines: string[] = ['\\voice'];
  for (const sec of timeline.sections) {
    lines.push(`\\section "${sec.label}"`);
    lines.push(...lh.slice(sec.startBar, sec.startBar + sec.bars));
  }
  lines.push('\\voice', ...rh, '\\voice', ...mel);
  return { body: lines.join('\n'), timeline: { ...timeline, chords: outChords } };
}
