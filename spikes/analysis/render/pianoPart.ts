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
  /** The harder REC-like style (spike 2, T4b); absent = the T4 style, unchanged. See `recCompHard`. */
  hard?: RecHardOptions;
}

/** Options of the harder REC-like style (T4b). Their decisions use their own random stream. */
export interface RecHardOptions {
  /** Share of right-hand pairs containing the third, major-like chords (else power-chord pairs: 1-5, 5-1', 5-9, 1-9). */
  thirdShare: number;
  /** The same for minor-like chords (min, min7, dim, m7b5, dim7). */
  minorThirdShare: number;
  /** Share of melody chord tones (not steps / non-chord tones) that are the third (else root, 5th, top tone). */
  melodyThirdShare: number;
  /** Share of chord-in-bar pieces (no slash bass, not sus4) played as an inverted power chord: the 5th lowest. */
  invertShare: number;
  /** Share of bars with one chord that get a passing chord on beat 3 (harmonic rhythm of 2 beats). */
  halfBarShare: number;
  /** Share of beats 1 and 3 carrying a held (quarter / half) non-chord tone in the melody. */
  longNonChordShare: number;
  /** Eighths the last right-hand pair of a chord keeps ringing into the next chord (sustain pedal). */
  pedalEighths: number;
  /** Left hand ff, right hand and melody mf (about +6 dB for the left hand); false = all f. */
  lhLouder: boolean;
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
  if (o.hard) return recCompHard(timeline, o, o.hard);
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

// ---------------------------------------------------------------------------
// Harder REC-like style (docs/audio-spike2-plan.md, T4b). Same playing-style idea as `recComp`, tuned
// so that dsp-v1 errs on chroma CONTENT (not only at chord changes), using only this project's songs:
// - power-chord voicings: right-hand pairs mostly without the third (1-5, 5-1', 5-9, 1-9; the third
//   comes mainly from melody notes), chosen per chord and bar; in `invertShare` of them an inverted
//   power chord with the 5th as the lowest note (left hand 5-1-5'-1, right hand 5-1' / 5-9);
// - held non-chord tones (9th, 4th, 6th / minor 7th) on beats 1 and 3 in the melody;
// - a passing chord on beat 3 of some one-chord bars (a 2-beat harmonic rhythm); it is in the
//   returned timeline, so the truth stays exact;
// - right hand legato, and its last pair of a chord rings into the next chord (two alternating
//   right-hand voices; pitches the next chord re-strikes are cut at the change);
// - left hand louder than the right hand.
// Four alphaTex voices: left hand, right hand A / B (alternating per chord span), melody.

export const REC_HARD_DEFAULTS: RecHardOptions = {
  thirdShare: 0.1,
  minorThirdShare: 0.9,
  melodyThirdShare: 0.3,
  invertShare: 0.75,
  halfBarShare: 0.5,
  longNonChordShare: 0.5,
  pedalEighths: 4,
  lhLouder: true,
};

/** Options of the hard style as used by the LR "-hard" variants (melody busier, more non-chord tones). */
export const REC_HARD: RecCompOptions = { melodyShare: 0.9, nonChordShare: 0.5, hard: REC_HARD_DEFAULTS };

const MINORISH = new Set<ChordQuality>(['min', 'min7', 'dim', 'm7b5', 'dim7']);

/** A passing chord for beat 3 of a bar on `text`: a diatonic-like neighbour (IV, V, vi, ii / iv, III, V, VI). */
function passingChord(text: string, r: number): string {
  const c = parseChordSymbol(text);
  const cands: [number, string][] = MINORISH.has(c.quality)
    ? [[5, 'm'], [3, ''], [7, '7'], [8, '']]
    : [[5, ''], [7, ''], [9, 'm'], [2, 'm']];
  const [off, q] = cands[Math.floor(r * cands.length)];
  return `${SHARP_NAMES[(c.root + off) % 12]}${q}`;
}

interface AbsHit {
  at16: number;
  len16: number;
  notes: number[];
  /** Tied on from the previous beat of the voice (same pitches). */
  tie?: boolean;
}

/**
 * One voice over the whole song from absolute hits (sixteenths, no overlaps): splits hits at bar lines
 * and into writable lengths, tying the pieces (`{t}` on the notes). `firstEffect` goes on the first beat.
 */
function voiceBars(hits: AbsHit[], bars: number, firstEffect: string): string[] {
  const perBar: { notes: number[]; len16: number; tie: boolean }[][] = Array.from({ length: bars }, () => []);
  const pos = new Array<number>(bars).fill(0);
  const push = (bar: number, notes: number[], len: number, tie: boolean) => {
    let first = true;
    while (len > 0) {
      const d = DUR16_SIZES.find((x) => x <= len)!;
      perBar[bar].push({ notes, len16: d, tie: tie || (!first && notes.length > 0) });
      pos[bar] += d;
      len -= d;
      first = false;
    }
  };
  const restTo = (bar: number, at: number) => push(bar, [], at - pos[bar], false);
  for (const h of [...hits].sort((a, b) => a.at16 - b.at16)) {
    let at = h.at16;
    let len = h.len16;
    let tie = h.tie ?? false;
    while (len > 0) {
      const bar = Math.floor(at / 16);
      const inBar = at - bar * 16;
      if (inBar < pos[bar] || bar >= bars) throw new Error('recCompHard: 重なった音');
      restTo(bar, inBar);
      const piece = Math.min(len, 16 - inBar);
      push(bar, h.notes, piece, tie);
      at += piece;
      len -= piece;
      tie = true;
    }
  }
  return perBar.map((evs, bar) => {
    restTo(bar, 16);
    return `${evs
      .map((e, i) => {
        const [dur, dot] = DUR16[e.len16].split(' ');
        const n = (m: number) => `${noteName(m)}${e.tie ? '{t}' : ''}`;
        const body = e.notes.length === 0 ? 'r' : e.notes.length === 1 ? n(e.notes[0]) : `(${e.notes.map(n).join(' ')})`;
        const fx = [dot ? 'd' : '', bar === 0 && i === 0 ? firstEffect : ''].filter((x) => x !== '');
        return `${dur} ${body}${fx.length > 0 ? ` {${fx.join(' ')}}` : ''}`;
      })
      .join(' ')} |`;
  });
}

/** The hard style (`options.hard`); called by `recComp`, same contract. */
function recCompHard(
  timeline: ChordTimeline,
  o: Required<Omit<RecCompOptions, 'hard'>>,
  h: RecHardOptions,
): { body: string; timeline: ChordTimeline } {
  const rnd = prng(o.seed);
  const rndH = prng((o.seed * 7919 + 104729) >>> 0); // hard-style decisions
  const E = timeline.bars * 8;
  const firstPlayed = o.pickupBeats > 0 ? 8 : 0;
  const last = timeline.bars - 1;
  const firstBar = o.pickupBeats > 0 ? 1 : 0;

  // ---- passing chords on beat 3 of one-chord bars (the bar's chord comes back on the next bar head) ----
  const src = timeline.chords;
  const changeInside = new Set(src.filter((c) => c.beat !== 0).map((c) => c.bar));
  const headAt = new Set(src.filter((c) => c.beat === 0).map((c) => c.bar));
  const written: TimelineChord[] = [...src];
  for (let bar = firstBar, k = 0; bar < last; bar++) {
    while (k + 1 < src.length && (src[k + 1].bar < bar || (src[k + 1].bar === bar && src[k + 1].beat === 0))) k++;
    if (changeInside.has(bar) || rndH() >= h.halfBarShare) continue;
    written.push({ bar, beat: 2, text: passingChord(src[k].text, rndH()) });
    if (!headAt.has(bar + 1)) written.push({ bar: bar + 1, beat: 0, text: src[k].text });
  }
  written.sort((x, y) => x.bar - y.bar || x.beat - y.beat);

  // ---- chord changes on the eighth grid, with anticipation (as recComp) ----
  const startE = (c: TimelineChord) => c.bar * 8 + c.beat * 2;
  const changes: { e: number; text: string }[] = [];
  written.forEach((c, i) => {
    let e = i === 0 ? 0 : startE(c);
    const r = rnd();
    if (i > 0 && Number.isInteger(c.beat) && c.beat % 2 === 0 && c.text !== written[i - 1].text && r < o.anticipateShare) {
      const prev = Math.max(changes[changes.length - 1].e, firstPlayed);
      if (e - 1 >= prev + 2) e -= 1;
    }
    if (changes.length > 0 && changes[changes.length - 1].text === c.text) return; // same chord continues
    changes.push({ e, text: c.text });
  });
  const span: number[] = []; // span index per eighth
  for (let e = 0, k = 0; e < E; e++) {
    while (k + 1 < changes.length && changes[k + 1].e <= e) k++;
    span.push(k);
  }
  const chordAt = (e: number) => changes[span[e]].text;
  const spanStart = (e: number) => changes[span[e]].e;
  const outChords: TimelineChord[] = changes.map((c) => ({ bar: Math.floor(c.e / 8), beat: (c.e % 8) / 2, text: c.text }));

  // ---- per chord span and bar: inverted power chord (5th lowest) or not, and the right-hand pair ----
  const voicings = new Map<number, { inverted: boolean; pair: number[] }>();
  const voicing = (e: number) => {
    const key = span[e] * 1000 + Math.floor(e / 8);
    let v = voicings.get(key);
    if (!v) {
      const { c, iv } = tonesOf(chordAt(e));
      const inverted = rndH() < h.invertShare && c.bass === null && c.quality !== 'sus4';
      const fifth = iv[2];
      let pick: number[];
      if (rndH() < (MINORISH.has(c.quality) ? h.minorThirdShare : h.thirdShare)) {
        const third = iv[1];
        pick = iv.length === 4 ? ([[third, iv[3]], [third, fifth]] as number[][])[Math.floor(rndH() * 2)] : ([[third, fifth], [0, third]] as number[][])[Math.floor(rndH() * 2)];
      } else if (inverted) {
        pick = ([[fifth, 12], [fifth, 14]] as number[][])[Math.floor(rndH() * 2)]; // 5-1' (a 4th) / 5-9
      } else {
        pick = ([[0, fifth], [fifth, 12], [fifth, 14], [0, 14]] as number[][])[Math.floor(rndH() * 4)];
      }
      const lo = atOrAbove((c.root + pick[0]) % 12, 60);
      v = { inverted, pair: [lo, atOrAbove((c.root + pick[1]) % 12, lo + 1)] };
      voicings.set(key, v);
    }
    return v;
  };

  const lastBarSingle = new Set(span.slice(last * 8)).size === 1;
  const lh: AbsHit[] = [];
  const rhStarts = new Map<number, number[]>(); // eighth -> notes
  const mel: AbsHit[] = [];
  for (let bar = 0; bar < timeline.bars; bar++) {
    const b0 = bar * 8;
    if (bar === 0 && o.pickupBeats > 0) {
      const { c, iv } = tonesOf(chordAt(8));
      for (let k = 0; k < o.pickupBeats * 2; k++) {
        const pc = (c.root + iv[k % 2 === 0 ? 2 : 0]) % 12;
        mel.push({ at16: (4 - o.pickupBeats) * 4 + k * 2, len16: 2, notes: [atOrAbove(pc, 72)] });
      }
      continue;
    }
    if (bar === last && lastBarSingle) {
      lh.push({ at16: b0 * 2, len16: 16, notes: [36 + tonesOf(chordAt(b0)).bass] });
      rhStarts.set(b0, voicing(b0).pair);
      continue;
    }
    for (let i = 0; i < 8; i++) {
      const e = b0 + i;
      const origin = Math.max(spanStart(e), b0 + (i < 4 ? 0 : 4));
      const { c, iv, bass } = tonesOf(chordAt(e));
      const one = 36 + bass;
      const five = atOrAbove((c.root + iv[2]) % 12, one + 1);
      // Inverted power chord: 5th lowest (C2-B2), the root a 4th above: 5-1-5'-1.
      const low5 = 36 + ((c.root + iv[2]) % 12);
      const up1 = atOrAbove(c.root, low5 + 1);
      const fig = voicing(e).inverted ? [low5, up1, low5 + 12, up1] : [one, five, one + 12, five];
      lh.push({ at16: e * 2, len16: 2, notes: [fig[(e - origin) % 4]] });
    }
    const pattern = RH_PATTERNS[Math.floor(rnd() * RH_PATTERNS.length)];
    const starts = new Set<number>(pattern.map(([s]) => s));
    for (let i = 0; i < 8; i++) if (spanStart(b0 + i) === b0 + i) starts.add(i);
    for (const s of [...starts].sort((a, b) => a - b)) {
      const notes = [...voicing(b0 + s).pair];
      if (rnd() < o.missShare) {
        const n = notes[Math.floor(rnd() * notes.length)] + (rnd() < 0.5 ? -1 : 1);
        if (!notes.includes(n)) notes.push(n);
      }
      rhStarts.set(b0 + s, notes.sort((a, b) => a - b));
    }
    if (bar === last) continue;
    // Melody: held non-chord tones on beats 1 / 3, short figures elsewhere.
    const busy = new Set<number>();
    for (const beat of [0, 2]) {
      if (rndH() >= h.longNonChordShare) continue;
      const e = b0 + beat * 2;
      const { c } = tonesOf(chordAt(e));
      const offs = MINORISH.has(tonesOf(chordAt(e)).c.quality) ? [2, 5, 10] : [2, 5, 9];
      let len = rndH() < 0.5 ? 4 : 8;
      while (len > 4 && span[e + len / 2 - 1] !== span[e]) len -= 4; // stay inside the chord
      mel.push({ at16: e * 2, len16: len, notes: [atOrAbove((c.root + offs[Math.floor(rndH() * 3)]) % 12, 72)] });
      for (let k = 0; k < len / 4; k++) busy.add(beat + k);
    }
    for (let beat = 0; beat < 4; beat++) {
      if (busy.has(beat) || rnd() >= o.melodyShare) continue;
      const fig = MELODY_FIGURES[Math.floor(rnd() * MELODY_FIGURES.length)];
      let prev: number | null = null;
      for (const [s, l] of fig) {
        const at16 = beat * 4 + s;
        const { c, iv } = tonesOf(chordAt(b0 + Math.floor(at16 / 2)));
        // Scale tones of the chord (major / dominant / minor); steps and non-chord tones stay in it.
        const scale = MINORISH.has(c.quality) ? [0, 2, 3, 5, 7, 8, 10] : c.quality === '7' ? [0, 2, 4, 5, 7, 9, 10] : [0, 2, 4, 5, 7, 9, 11];
        const ladder: number[] = [];
        for (let m = 70; m <= 88; m++) if (scale.includes((m - c.root + 120) % 12)) ladder.push(m);
        const near = (m: number) => ladder.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
        let n: number;
        if (prev !== null && rnd() < 0.5) {
          const i = ladder.indexOf(near(prev)) + [-2, -1, 1, 2][Math.floor(rnd() * 4)];
          n = ladder[Math.max(0, Math.min(ladder.length - 1, i))];
        } else {
          const tone = rndH() < h.melodyThirdShare ? iv[1] : [0, iv[2], iv[iv.length - 1]][Math.floor(rndH() * 3)];
          n = atOrAbove((c.root + tone) % 12, 72);
          if (rnd() < o.nonChordShare) {
            const i = ladder.indexOf(n) + [-1, 1][Math.floor(rnd() * 2)];
            n = ladder[Math.max(0, Math.min(ladder.length - 1, i))];
          }
        }
        mel.push({ at16: b0 * 2 + at16, len16: l, notes: [n] });
        prev = n;
      }
    }
  }

  // ---- right hand: legato within a span, the span's last pair rings into the next span ----
  const rhVoices: AbsHit[][] = [[], []];
  const startList = [...rhStarts.keys()].sort((a, b) => a - b);
  startList.forEach((s, j) => {
    const k = span[s];
    const nextStart = j + 1 < startList.length ? startList[j + 1] : E;
    const notes = rhStarts.get(s)!;
    const voice = rhVoices[k % 2];
    if (nextStart < E && span[nextStart] === k) {
      voice.push({ at16: s * 2, len16: (nextStart - s) * 2, notes });
      return;
    }
    // Last hit of span k: to the change, then ring (without the pitches the next span strikes).
    const change = k + 1 < changes.length ? Math.min(changes[k + 1].e, E) : E;
    const end = Math.min(nextStart, change);
    voice.push({ at16: s * 2, len16: (end - s) * 2, notes });
    if (end < change || change >= E || h.pedalEighths <= 0) return;
    const after = k + 2 < changes.length ? changes[k + 2].e : E;
    const ringEnd = Math.min(change + h.pedalEighths, after, E);
    const struck = new Set(rhStarts.get(change) ?? []);
    const ring = notes.filter((n) => !struck.has(n));
    if (ring.length === 0 || ringEnd <= change) return;
    if (ring.length === notes.length) voice[voice.length - 1].len16 += (ringEnd - change) * 2;
    else voice.push({ at16: change * 2, len16: (ringEnd - change) * 2, notes: ring, tie: true });
  });

  const lhFx = h.lhLouder ? 'dy ff' : '';
  const rhFx = h.lhLouder ? 'dy mf' : '';
  const lhBars = voiceBars(lh, timeline.bars, lhFx);
  const lines: string[] = ['\\voice'];
  for (const sec of timeline.sections) {
    lines.push(`\\section "${sec.label}"`);
    lines.push(...lhBars.slice(sec.startBar, sec.startBar + sec.bars));
  }
  for (const v of [...rhVoices, mel]) lines.push('\\voice', ...voiceBars(v, timeline.bars, rhFx));
  return { body: lines.join('\n'), timeline: { ...timeline, chords: outChords } };
}
