// Chord etude (docs/audio-spike0-plan.md, T4): a synthetic 4/4 song of 32
// bars whose chords cover all 24 major/minor triads plus 7/maj7/min7.
// Sections are A1, B1, A2, B2 (8 bars each; chordTimeline forbids repeated
// labels, so the labels differ), where A2 repeats A1's chords and B2 repeats
// B1's (review R2). Each section starts with a crash and every section but
// the last ends with a snare fill, so boundaries are audible. The drums
// carry `\tf triplet8th` (straight variants rewrite it to `\tf none`).
// There is no `{key}`: the chords are a random walk, not in a key (R13).
// Deterministic from the seed.

import { chordMidi, noteName } from './pianoPart';
import { prng } from './prng';

const ROOTS = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
];
const LABELS = ['A1', 'B1', 'A2', 'B2'];
/** Section index whose chords a section repeats (A2 = A1, B2 = B1). */
const CHORDS_FROM = [0, 1, 0, 1];
const BARS_PER_SECTION = 8;

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Wider-vocabulary qualities (spike 2, design decision 8) mixed in by `vocabShare`. */
export const VOCAB_EXTRAS = ['dim', 'aug', 'sus4', 'm7b5', 'dim7'];

/**
 * Replaces about `share` of the slots with a random root + a VOCAB_EXTRAS quality (in place); the
 * qualities take turns, so every one of them appears once at least 5 slots are replaced.
 */
function mixVocab(chords: string[], share: number, rnd: () => number): void {
  let k = 0;
  for (let i = 0; i < chords.length; i++) {
    if (rnd() < share) chords[i] = ROOTS[Math.floor(rnd() * 12)] + VOCAB_EXTRAS[k++ % VOCAB_EXTRAS.length];
  }
}

export interface Etude {
  /** Complete .bandsheet song text. */
  text: string;
  /** Chord symbols per bar (1 or 2 each). */
  chordsPerBar: string[][];
}

/**
 * `seventhShare` (0-1): share of chord slots that are sevenths (7/maj7/m7).
 * Absent = the original construction (all 24 triads + a few sevenths).
 * With a share, the triads are a random subset of the 24 as far as the
 * remaining slots go, so full triad coverage is only guaranteed for shares
 * up to ~0.25.
 * `vocabShare` (spike 2, T4): additionally replace about that share of the
 * slots with dim / aug / sus4 / m7b5 / dim7 chords. Absent = unchanged output.
 */
export function chordEtude(seed: number, seventhShare?: number, vocabShare?: number): Etude {
  const rnd = prng(seed);
  // 16 unique bars (A1 + B1). Which bars carry two chords: at least 8, so
  // that there are >= 24 chord slots for all 24 triads.
  const split = Array.from({ length: 16 }, () => rnd() < 0.5);
  while (split.filter(Boolean).length < 8) split[Math.floor(rnd() * 16)] = true;
  const slots = split.reduce((n, s) => n + (s ? 2 : 1), 0);
  const triads = ROOTS.flatMap((r) => [r, `${r}m`]);
  const extras = ['7', 'maj7', 'm7'];
  const pool =
    seventhShare === undefined
      ? [...triads]
      : shuffle(triads, rnd).slice(0, Math.max(0, slots - Math.round(seventhShare * slots)));
  while (pool.length < slots) {
    const r = ROOTS[Math.floor(rnd() * 12)];
    pool.push(r + extras[Math.floor(rnd() * extras.length)]);
  }
  const chords = shuffle(pool, rnd);
  if (vocabShare !== undefined) mixVocab(chords, vocabShare, rnd);
  const unique: string[][] = [];
  let k = 0;
  for (const s of split) {
    unique.push(s ? [chords[k++], chords[k++]] : [chords[k++]]);
  }
  const chordsPerBar = CHORDS_FROM.flatMap((from) =>
    unique.slice(from * BARS_PER_SECTION, (from + 1) * BARS_PER_SECTION),
  );

  const chart: string[] = [];
  const melody: string[] = [];
  const drums: string[] = [];
  LABELS.forEach((label, si) => {
    const bars = chordsPerBar.slice(
      si * BARS_PER_SECTION,
      (si + 1) * BARS_PER_SECTION,
    );
    chart.push(`{start_of_verse: ${label}}`);
    melody.push(`\\section "${label}"`);
    drums.push(`\\section "${label}"`, '\\tf triplet8th');
    for (let half = 0; half < 2; half++) {
      chart.push(
        bars
          .slice(half * 4, half * 4 + 4)
          .flat()
          .map((c) => `[${c}]ら`)
          .join(''),
      );
    }
    chart.push('{end_of_verse}', '');
    bars.forEach((cs, b) => {
      const dur = cs.length === 1 ? ':1 ' : ':2 ';
      const notes = cs.map((c) => {
        const root = chordMidi(c)[1] + 12;
        return `${noteName(root)}{lyrics "ら"}`;
      });
      melody.push(`${dur}${notes.join(' ')} |`);
      const first = b === 0 ? '(CR BD)' : '(HH BD)';
      const last = b === BARS_PER_SECTION - 1 && si < LABELS.length - 1 ? 'SD SD SD SD' : '(HH BD) HH (HH SD) HH';
      drums.push(`${b === 0 ? ':8 ' : ''}${first} HH (HH SD) HH ${last} |`);
    });
  });

  const text = [
    '{title: コード練習曲}',
    '{tempo: 90}',
    '{time: 4/4}',
    '',
    ...chart,
    '{start_of_part: Vocal}',
    ...melody,
    '{end_of_part}',
    '',
    '{start_of_part: Drums}',
    '\\instrument percussion',
    ...drums,
    '{end_of_part}',
    '',
  ].join('\n');
  return { text, chordsPerBar };
}

/** Section labels of the AABA etude (labels may not repeat). */
const AABA_LABELS = ['A1', 'A2', 'B', 'A3'];
const AABA_FROM = [0, 0, 1, 0];

/**
 * etude3 (spike 2, T4; the held-out song with a different form): 4 sections
 * of 8 bars, AABA (A1 A2 B A3, the A sections share their chords), and a
 * pickup of `pickupBeats` beats: bar 0 is a full bar whose first
 * 4 - pickupBeats beats are rests (the renderer cuts them from the wav), so
 * there are 33 bars and A1 has 9. The pickup note carries no chord. Chord
 * pool as `chordEtude` (all 24 triads + sevenths), deterministic per seed.
 */
export function chordEtudeAABA(seed: number, pickupBeats = 1): Etude {
  if (!(Number.isInteger(pickupBeats) && pickupBeats >= 1 && pickupBeats <= 3)) {
    throw new Error(`pickupBeats ${pickupBeats} は 1〜3 にしてください`);
  }
  const rnd = prng(seed);
  const split = Array.from({ length: 16 }, () => rnd() < 0.5);
  while (split.filter(Boolean).length < 8) split[Math.floor(rnd() * 16)] = true;
  const slots = split.reduce((n, s) => n + (s ? 2 : 1), 0);
  const pool = ROOTS.flatMap((r) => [r, `${r}m`]);
  const extras = ['7', 'maj7', 'm7'];
  while (pool.length < slots) pool.push(ROOTS[Math.floor(rnd() * 12)] + extras[Math.floor(rnd() * extras.length)]);
  const chords = shuffle(pool, rnd);
  const unique: string[][] = [];
  let k = 0;
  for (const s of split) unique.push(s ? [chords[k++], chords[k++]] : [chords[k++]]);
  const sectionBars = AABA_FROM.map((from) => unique.slice(from * BARS_PER_SECTION, (from + 1) * BARS_PER_SECTION));

  // Pickup note: the fifth of the first chord, an octave and a fifth above its voicing root.
  const pickupNote = noteName(chordMidi(sectionBars[0][0][0])[1] + 19);
  const chart: string[] = [];
  const melody: string[] = [];
  const drums: string[] = [];
  AABA_LABELS.forEach((label, si) => {
    const bars = sectionBars[si];
    chart.push(`{start_of_verse: ${label}}`);
    melody.push(`\\section "${label}"`);
    drums.push(`\\section "${label}"`, '\\tf triplet8th');
    if (si === 0) {
      const rests = Array.from({ length: 4 - pickupBeats }, () => 'r');
      const notes = Array.from({ length: pickupBeats }, () => `${pickupNote}{lyrics "ら"}`);
      melody.push(`:4 ${[...rests, ...notes].join(' ')} |`);
      drums.push(`:4 ${[...rests, ...Array.from({ length: pickupBeats }, () => 'HH')].join(' ')} |`);
    }
    for (let half = 0; half < 2; half++) {
      const pick = si === 0 && half === 0 ? 'ら'.repeat(pickupBeats) : '';
      chart.push(pick + bars.slice(half * 4, half * 4 + 4).flat().map((c) => `[${c}]ら`).join(''));
    }
    chart.push('{end_of_verse}', '');
    bars.forEach((cs, b) => {
      const dur = cs.length === 1 ? ':1 ' : ':2 ';
      const notes = cs.map((c) => `${noteName(chordMidi(c)[1] + 12)}{lyrics "ら"}`);
      melody.push(`${dur}${notes.join(' ')} |`);
      const first = b === 0 ? '(CR BD)' : '(HH BD)';
      const last = b === BARS_PER_SECTION - 1 && si < AABA_LABELS.length - 1 ? 'SD SD SD SD' : '(HH BD) HH (HH SD) HH';
      drums.push(`${b === 0 ? ':8 ' : ''}${first} HH (HH SD) HH ${last} |`);
    });
  });
  const text = [
    '{title: コード練習曲 3}',
    '{tempo: 90}',
    '{time: 4/4}',
    '',
    ...chart,
    '{start_of_part: Vocal}',
    ...melody,
    '{end_of_part}',
    '',
    '{start_of_part: Drums}',
    '\\instrument percussion',
    ...drums,
    '{end_of_part}',
    '',
  ].join('\n');
  return { text, chordsPerBar: [[sectionBars[0][0][0]], ...sectionBars.flat()] };
}
