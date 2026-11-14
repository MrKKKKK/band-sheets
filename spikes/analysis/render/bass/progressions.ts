// Spike 6 T2: chord progressions of the synthetic bass songs (docs/audio-spike6-plan.md section 4 進行).
//
// A song = 4 sections of 4 bars in 4/4, one key (major tonic; the minor cliche uses the relative minor). Two sections
// are plain (no slash chord: the false-`/X` check, so more than half of all chords have none) and two are drawn without
// replacement from the slash kinds:
//   inversion   C/E, G/B, D/F#, F/A, G7/B, C/G, Am/E (idiomatic templates)
//   cliche      C - C/B - C/A# - C/A          (major, bass descends by semitone under the same chord)
//   clicheMin   Am - Am/G# - Am/G - Am/F#     (relative minor)
//   descending  C - G/B - Am - Em/G - F - C/E - Dm - G
//   pedal       C - F/C - G/C - C             (the tonic held under changing chords)
// Chords sit on beat 0 or 2 (one or two per bar). Names are spelled with sharps (render/pianoPart.ts convention), so
// B-flat is A#; scorers compare pitch classes.

import { CHORD_INTERVALS } from '../pianoPart';
import type { ChordQuality, ChordTimeline, TimelineChord } from '../types';

export const SECTION_KINDS = ['plain', 'inversion', 'cliche', 'clicheMin', 'descending', 'pedal'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];
export const SLASH_KINDS: SectionKind[] = ['inversion', 'cliche', 'clicheMin', 'descending', 'pedal'];
export const SECTIONS = 4;
export const SECTION_BARS = 4;
export const SECTION_LABELS = ['A', 'B', 'C', 'D'];

/** A template chord relative to the section tonic: root, quality, bass (semitones above the tonic) or null. */
type T = [number, ChordQuality, number | null];
const I: T = [0, 'maj', null];
const ii: T = [2, 'min', null];
const iii: T = [4, 'min', null];
const IV: T = [5, 'maj', null];
const V: T = [7, 'maj', null];
const vi: T = [9, 'min', null];
const PLAIN: T[][] = [
  [I, vi, IV, V],
  [I, IV, V, I],
  [vi, IV, I, V],
  [I, V, vi, IV],
  [ii, V, I, vi],
  [IV, V, iii, vi],
  [I, iii, IV, V],
];
const TEMPLATES: Record<Exclude<SectionKind, 'plain'>, T[][]> = {
  inversion: [
    [I, [7, 'maj', 11], vi, IV], // C G/B Am F
    [I, [0, 'maj', 4], IV, V], // C C/E F G
    [I, [2, 'maj', 6], V, [7, '7', 11]], // C D/F# G G7/B
    [IV, [0, 'maj', 7], V, I], // F C/G G C
    [vi, [9, 'min', 4], IV, [5, 'maj', 9]], // Am Am/E F F/A
    [I, [7, 'maj', 11], vi, [0, 'maj', 7], IV, [0, 'maj', 4], ii, V], // two per bar
  ],
  cliche: [
    [I, [0, 'maj', 11], [0, 'maj', 10], [0, 'maj', 9]],
    [I, [0, 'maj', 11], [0, 'maj', 10], [0, 'maj', 9], IV, [5, 'maj', 9], ii, V],
  ],
  // relative to the minor tonic
  clicheMin: [
    [[0, 'min', null], [0, 'min', 11], [0, 'min', 10], [0, 'min', 9]],
    [[0, 'min', null], [0, 'min', 11], [0, 'min', 10], [0, 'min', 9], [8, 'maj', null], [5, 'min', null], [7, 'maj', null], [7, '7', null]],
  ],
  descending: [
    [I, [7, 'maj', 11], vi, [4, 'min', 7], IV, [0, 'maj', 4], ii, V],
    [I, [7, 'maj', 11], vi, [7, 'maj', 7], IV, [0, 'maj', 4], [2, 'min7', null], [7, '7', null]],
  ],
  pedal: [
    [I, [5, 'maj', 0], [7, 'maj', 0], I],
    [I, [5, 'maj', 0], [7, 'maj', 0], I, [5, 'maj', 0], [2, 'min', 0], [7, '7', 0], I],
  ],
};

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SUFFIX: Partial<Record<ChordQuality, string>> = { maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7' };

export function chordText(tonic: number, [root, quality, bass]: T): string {
  const r = (tonic + root) % 12;
  const suffix = SUFFIX[quality];
  if (suffix === undefined) throw new Error(`quality ${quality} is not used here`);
  return `${SHARP[r]}${suffix}${bass === null ? '' : `/${SHARP[(tonic + bass) % 12]}`}`;
}

export interface BassSong {
  /** Major tonic (pitch class). */
  key: number;
  kinds: SectionKind[];
  timeline: ChordTimeline;
}

const pick = <X>(rnd: () => number, xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)];

/** 7th colours on plain chords (V -> V7, ii -> ii7, I -> Imaj7), drawn per chord. */
function colour(rnd: () => number, t: T): T {
  if (t[2] !== null) return t;
  const u = rnd();
  if (t[0] === 7 && t[1] === 'maj' && u < 0.5) return [7, '7', null];
  if (t[0] === 2 && t[1] === 'min' && u < 0.3) return [2, 'min7', null];
  if (t[0] === 0 && t[1] === 'maj' && u < 0.15) return [0, 'maj7', null];
  return t;
}

export function generateSong(rnd: () => number): BassSong {
  const key = Math.floor(rnd() * 12);
  const slash = [...SLASH_KINDS];
  const chosen: SectionKind[] = [];
  for (let i = 0; i < 2; i++) chosen.push(slash.splice(Math.floor(rnd() * slash.length), 1)[0]);
  const kinds: SectionKind[] = ['plain', 'plain', ...chosen];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const chords: TimelineChord[] = [];
  const sections: ChordTimeline['sections'] = [];
  kinds.forEach((kind, s) => {
    const startBar = s * SECTION_BARS;
    let tpl: T[];
    if (kind === 'plain') {
      const a = pick(rnd, PLAIN);
      let b: T[] = [];
      if (rnd() < 0.4) do b = pick(rnd, PLAIN); while (b[0] === a[3]); // no repeated chord at the join
      tpl = [...a, ...b].map((t) => colour(rnd, t));
    } else tpl = pick(rnd, TEMPLATES[kind]);
    const tonic = kind === 'clicheMin' ? (key + 9) % 12 : key;
    const per = tpl.length / SECTION_BARS; // 1 or 2 chords per bar
    tpl.forEach((t, i) => chords.push({ bar: startBar + Math.floor(i / per), beat: per === 2 ? (i % 2) * 2 : 0, text: chordText(tonic, t) }));
    sections.push({ label: SECTION_LABELS[s], startBar, bars: SECTION_BARS });
  });
  return { key, kinds, timeline: { ts: [4, 4], bars: SECTIONS * SECTION_BARS, sections, chords } };
}

/** Pitch classes of a chord's tones, root first (CHORD_INTERVALS). */
export const chordTones = (root: number, quality: ChordQuality): number[] => CHORD_INTERVALS[quality].map((i) => (root + i) % 12);
