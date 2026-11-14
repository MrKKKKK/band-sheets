// Spike 6 T2: bass lines of the synthetic songs (docs/audio-spike6-plan.md section 4 ベースの型), and their alphaTex.
//
// Every chord segment starts with its HEAD note on the segment's first beat, and the head plays the written bass
// (the `/X`, else the root): so the two truths (written bass of the chart, played bass at the segment head) agree at
// every head by construction (check.ts verifies it on the MIDI). Inside a segment the line moves per style:
//   whole    one note for the whole segment
//   rock8    eighths on the head note
//   twoBeat  half notes: head, then the second pitch
//   octave   eighths alternating the head and its octave
//   walking  quarters: head, chord tones, and a chromatic approach (a semitone below / above) to the next head
//   sync16   16th syncopation per half bar (3 + 3 + 2 sixteenths): head, head, second pitch / octave
// Second pitch: plain sections the chord's fifth, inversion sections the chord root, cliche / descending / pedal
// sections the bass note itself (its octave in the octave style), so the moving bass of those stays unambiguous.
// Register: BASS_LO..BASS_HI (E1..G3); heads up to HEAD_HI, placed per section so stepwise lines (cliche, descending)
// move by step (headNotes).
// Ghost / muted notes (levels B2+, `marks`): some fill notes become ghosts (low velocity, half length) or are muted
// (half length); the note list itself (times, pitches) does not change with the level.

import { noteName } from '../pianoPart';
import { parseChordSymbol } from '../chordSymbol';
import type { BassSong, SectionKind } from './progressions';
import { chordTones } from './progressions';
import { BASS_HI, BASS_LO } from './timbres';

export const BASS_STYLES = ['whole', 'rock8', 'twoBeat', 'octave', 'walking', 'sync16'] as const;
export type BassStyle = (typeof BASS_STYLES)[number];
/** Highest head note (keeps the heads in the low register). */
export const HEAD_HI = 48;
export const NOMINAL_VELOCITY = { head: 100, fill: 88, approach: 92, ghost: 36 } as const;
export const GHOST_SHARE = 0.2;
export const MUTED_SHARE = 0.15;

export interface BassNote {
  /** Start in sixteenths from the song start, and the written length in sixteenths. */
  at16: number;
  len16: number;
  midi: number;
  role: 'head' | 'fill' | 'approach' | 'ghost';
  /** Sounds for half its written length (ghost or muted note). */
  short: boolean;
  velocity: number;
  /** Index of the chord segment the note belongs to. */
  segment: number;
}

export interface Segment {
  at16: number;
  len16: number;
  text: string;
  kind: SectionKind;
  section: number;
  /** Written bass pitch class (bass ?? root). */
  bassPc: number;
}

export function segmentsOf(song: BassSong): Segment[] {
  const t = song.timeline;
  const pos = (c: { bar: number; beat: number }) => c.bar * 16 + c.beat * 4;
  return t.chords.map((c, i) => {
    const s = parseChordSymbol(c.text);
    const end = i + 1 < t.chords.length ? pos(t.chords[i + 1]) : t.bars * 16;
    const sec = t.sections.findIndex((x) => c.bar >= x.startBar && c.bar < x.startBar + x.bars);
    return { at16: pos(c), len16: end - pos(c), text: c.text, kind: song.kinds[sec], section: sec, bassPc: s.bass ?? s.root };
  });
}

/** MIDI of pitch class `pc` nearest to `near` within [lo, hi] (ties: the lower one). */
export function nearest(pc: number, near: number, lo = BASS_LO, hi = BASS_HI): number {
  let best = -1;
  for (let m = lo; m <= hi; m++) if ((m - pc) % 12 === 0 && (best < 0 || Math.abs(m - near) < Math.abs(best - near))) best = m;
  if (best < 0) throw new Error(`no pitch class ${pc} in ${lo}..${hi}`);
  return best;
}
/** MIDI of `pc` at or above `from` (else the nearest below) within the bass range. */
const above = (pc: number, from: number): number => {
  for (let m = from; m <= BASS_HI; m++) if ((m - pc) % 12 === 0) return m;
  return nearest(pc, from);
};
const octaveOf = (h: number): number => (h + 12 <= BASS_HI ? h + 12 : h - 12);

/**
 * Head notes, section by section: each octave of the section's first bass (BASS_LO..HEAD_HI) is tried, the later heads
 * of the section follow by nearest octave, and the try with the least motion (from the previous head, then inside the
 * section; ties: the lower) wins, so a stepwise line never jumps an octave at the edge of the range.
 */
export function headNotes(segs: readonly Segment[]): number[] {
  const heads: number[] = [];
  for (let i = 0; i < segs.length; ) {
    let j = i;
    while (j < segs.length && segs[j].section === segs[i].section) j++;
    let best: { cost: number; run: number[] } | null = null;
    for (let first = BASS_LO; first <= HEAD_HI; first++) {
      if ((first - segs[i].bassPc) % 12 !== 0) continue;
      const run = [first];
      for (let k = i + 1; k < j; k++) run.push(nearest(segs[k].bassPc, run[run.length - 1], BASS_LO, HEAD_HI));
      const prev = heads[heads.length - 1];
      const cost = (prev === undefined ? 0 : Math.abs(first - prev)) + run.slice(1).reduce((a, m, k) => a + 2 * Math.abs(m - run[k]), 0);
      if (!best || cost < best.cost) best = { cost, run };
    }
    heads.push(...best!.run);
    i = j;
  }
  return heads;
}

export function bassLine(song: BassSong, style: BassStyle, rnd: () => number): BassNote[] {
  const segs = segmentsOf(song);
  const heads = headNotes(segs);
  const out: BassNote[] = [];
  segs.forEach((s, i) => {
    const h = heads[i];
    const c = parseChordSymbol(s.text);
    const tones = chordTones(c.root, c.quality);
    const second =
      s.kind === 'plain' ? above(tones[2], h + 1)
      : s.kind === 'inversion' ? (c.bass === null ? above(tones[2], h + 1) : above(c.root, h + 1))
      : style === 'octave' || style === 'sync16' ? octaveOf(h) : h;
    const L = s.len16;
    const add = (off: number, len: number, midi: number, role: BassNote['role'] = 'fill') =>
      out.push({ at16: s.at16 + off, len16: len, midi, role, short: false, velocity: NOMINAL_VELOCITY[role], segment: i });
    add(0, 0, h, 'head'); // length set below
    const head = out[out.length - 1];
    switch (style) {
      case 'whole':
        head.len16 = L;
        break;
      case 'rock8':
      case 'octave':
        head.len16 = 2;
        for (let k = 2; k < L; k += 2) add(k, 2, style === 'octave' && (k / 2) % 2 === 1 ? octaveOf(h) : h);
        break;
      case 'twoBeat':
        head.len16 = 8;
        if (L === 16) add(8, 8, second);
        break;
      case 'walking': {
        head.len16 = 4;
        const n = L / 4;
        const next = heads[i + 1];
        const mids = [above(tones[1], h + 1), above(tones[2], h + 1)];
        for (let k = 1; k < n; k++) {
          if (k === n - 1 && next !== undefined) {
            const down = rnd() < 0.5;
            const a = down && next - 1 >= BASS_LO ? next - 1 : next + 1 <= BASS_HI ? next + 1 : next - 1;
            add(k * 4, 4, a, 'approach');
          } else add(k * 4, 4, mids[(k - 1) % mids.length]);
        }
        break;
      }
      case 'sync16':
        head.len16 = 3;
        for (let g = 0; g < L; g += 8) {
          if (g > 0) add(g, 3, h);
          add(g + 3, 3, h);
          add(g + 6, 2, second);
        }
        break;
    }
  });
  return out;
}

/** Ghost / muted fill notes (levels B2+); heads and approaches stay. */
export function applyMarks(notes: BassNote[], rnd: () => number): BassNote[] {
  return notes.map((n) => {
    if (n.role !== 'fill') return n;
    const u = rnd();
    if (u < GHOST_SHARE) return { ...n, role: 'ghost', short: true, velocity: NOMINAL_VELOCITY.ghost };
    if (u < GHOST_SHARE + MUTED_SHARE) return { ...n, short: true };
    return n;
  });
}

const DUR: Record<number, string> = { 16: ':1', 12: ':2 {d}', 8: ':2', 6: ':4 {d}', 4: ':4', 3: ':8 {d}', 2: ':8', 1: ':16' };

/** alphaTex part body of the bass line, one `\section` per chart section (labels of the timeline). */
export function bassPartBody(song: BassSong, notes: readonly BassNote[]): string {
  const t = song.timeline;
  const lines: string[] = [];
  for (const sec of t.sections) {
    lines.push(`\\section "${sec.label}"`);
    for (let bar = sec.startBar; bar < sec.startBar + sec.bars; bar++) {
      const inBar = notes.filter((n) => Math.floor(n.at16 / 16) === bar);
      const filled = inBar.reduce((a, n) => a + n.len16, 0);
      if (filled !== 16 || inBar.some((n, k) => n.at16 !== bar * 16 + inBar.slice(0, k).reduce((a, m) => a + m.len16, 0))) {
        throw new Error(`bass bar ${bar + 1}: notes do not fill the bar`);
      }
      lines.push(
        `${inBar
          .map((n) => {
            const d = DUR[n.len16];
            if (!d) throw new Error(`bass note length ${n.len16} sixteenths`);
            const [dur, dot] = d.split(' ');
            return `${dur} ${noteName(n.midi)}${dot ? ` ${dot}` : ''}`;
          })
          .join(' ')} |`,
      );
    }
  }
  return lines.join('\n');
}
