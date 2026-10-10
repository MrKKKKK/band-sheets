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

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
 */
export function chordEtude(seed: number, seventhShare?: number): Etude {
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
