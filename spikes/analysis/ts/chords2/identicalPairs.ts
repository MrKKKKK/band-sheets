/**
 * DRAFT — UNCONFIRMED (spike 7 T2, first half). Not used by any analyzer code yet.
 *
 * Identical-note pairs of the staged vocabulary (plan §2.2 V1–V3, §2.3) and the truth table the user
 * confirms before the §2.3 rule runs (decision U2). Human-readable version with reasons:
 * docs/audio-spike7-t2-truth.md. The rows and the note § refs stay DRAFT until the user confirms them
 * and the theory note is updated (T2, second half); only then may T9 use TRUTH_DRAFT as test truth.
 *
 * NEW_TEMPLATES is the interval data T3 needs for the chords2 vocabulary; when T3 writes that vocabulary,
 * it should own these templates and this file should import them (one place, DRY).
 */
import { intervals } from '../dsp/vocab';

export type Stage = 'V0' | 'V1' | 'V2' | 'V3';

/** v1a state qualities (ts/dsp/vocab.ts v2 + sevenths; power '5' is off). */
const V0_QUALITIES = ['maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus4', 'm7b5', 'dim7'] as const;

/** Plan §2.2. Each stage adds these qualities on top of the previous stage. */
export const STAGE_ADDS: Record<Stage, readonly string[]> = {
  V0: V0_QUALITIES,
  V1: ['mM7', 'm6', '6'],
  V2: ['sus2', '7sus4', 'add9', 'madd9'],
  V3: ['9', 'm9', 'maj9'],
};
const STAGE_ORDER: readonly Stage[] = ['V0', 'V1', 'V2', 'V3'];

/** Interval templates of the new qualities. V3: the no-5th form is a second template of the same quality (§2.2). */
export const NEW_TEMPLATES: Record<string, readonly (readonly number[])[]> = {
  mM7: [[0, 3, 7, 11]],
  m6: [[0, 3, 7, 9]],
  '6': [[0, 4, 7, 9]],
  sus2: [[0, 2, 7]],
  '7sus4': [[0, 5, 7, 10]],
  add9: [[0, 2, 4, 7]],
  madd9: [[0, 2, 3, 7]],
  '9': [
    [0, 2, 4, 7, 10],
    [0, 2, 4, 10],
  ],
  m9: [
    [0, 2, 3, 7, 10],
    [0, 2, 3, 10],
  ],
  maj9: [
    [0, 2, 4, 7, 11],
    [0, 2, 4, 11],
  ],
};

export function templates(quality: string): readonly (readonly number[])[] {
  return NEW_TEMPLATES[quality] ?? [intervals(quality)];
}

export function stageQualities(stage: Stage): string[] {
  const upTo = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1);
  return upTo.flatMap((s) => [...STAGE_ADDS[s]]);
}

export interface PcState {
  root: number;
  quality: string;
}

/**
 * Groups of (root, quality) whose pitch-class sets are identical (any template of each quality),
 * groups of size >= 2 only. This is how the pairs below were derived.
 */
export function identicalGroups(qualities: readonly string[]): PcState[][] {
  const bySet = new Map<string, PcState[]>();
  for (const quality of qualities) {
    for (let root = 0; root < 12; root++) {
      for (const t of templates(quality)) {
        const key = [...new Set(t.map((i) => (root + i) % 12))].sort((a, b) => a - b).join(',');
        const g = bySet.get(key) ?? [];
        if (!g.some((s) => s.root === root && s.quality === quality)) g.push({ root, quality });
        bySet.set(key, g);
      }
    }
  }
  return [...bySet.values()].filter((g) => g.length >= 2);
}

/**
 * Cross-quality identical pairs (plan §2.3). Root of `b` = root of `a` + `offset` (C6 = Am7: a '6' on C,
 * b 'min7' on A). `stage` = the first stage where the pair exists.
 */
export interface IdenticalPair {
  a: string;
  b: string;
  offset: number;
  stage: Stage;
}
export const IDENTICAL_PAIRS_DRAFT: readonly IdenticalPair[] = [
  { a: '6', b: 'min7', offset: 9, stage: 'V1' }, // C6 = Am7
  { a: 'm6', b: 'm7b5', offset: 9, stage: 'V1' }, // Am6 = F#m7b5
  { a: 'sus2', b: 'sus4', offset: 7, stage: 'V2' }, // Csus2 = Gsus4
];

/** Same-quality symmetric groups: outside the §2.3 rule, root by ROOT_TIE as in v1a (plan §2.3). */
export const SYMMETRIC_EXCLUDED: readonly string[] = ['aug', 'dim7'];

/** One truth-table row (docs/audio-spike7-t2-truth.md has the reasons and the note § refs). */
export interface TruthRow {
  id: string;
  key: string; // 'C' major, 'Am' minor, ...
  prev: string | null;
  next: string | null;
  bass: string; // bass note name
  truth: string; // reading proposed as truth (DRAFT)
  candidate: string; // the other reading of the pair, kept as a candidate
  conflict: boolean; // 食い違う例: the bass is not the truth reading's root
  src: string; // note § refs; '案 N1' etc. = proposed addition (docs/audio-spike7-t2-note-proposal.md)
}

export const TRUTH_DRAFT: readonly TruthRow[] = [
  // C6 / Am7
  { id: 'A1', key: 'C', prev: 'G7', next: null, bass: 'C', truth: 'C6', candidate: 'Am7', conflict: false, src: '§2.4, §2.5, §4.2' },
  { id: 'A2', key: 'C', prev: 'Caug', next: 'C7', bass: 'C', truth: 'C6', candidate: 'Am7', conflict: false, src: '案 N1, §4.2' },
  { id: 'A3', key: 'Am', prev: 'AmM7', next: 'Am6', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '案 N1' },
  { id: 'A4', key: 'C', prev: 'Em7', next: 'Dm7', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '§2.4, §6.2' },
  { id: 'A5', key: 'Am', prev: 'Dm7', next: 'E7', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '§2.3, §6.2' },
  { id: 'A6', key: 'Am', prev: 'AmM7', next: 'Am6', bass: 'G', truth: 'Am7', candidate: 'C6', conflict: true, src: '§3.6, 案 N1' },
  { id: 'A7', key: 'C', prev: 'C', next: 'F', bass: 'E', truth: 'C6', candidate: 'Am7', conflict: true, src: '§3.6, 案 N1' },
  { id: 'A8', key: 'G', prev: 'Am', next: 'D7', bass: 'C', truth: 'Am7', candidate: 'C6', conflict: true, src: '§3.6, 案 N1, §2.4' },
  // Am6 / F#m7b5
  { id: 'B1', key: 'Am', prev: 'Am7', next: null, bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '案 N1' },
  { id: 'B2', key: 'G', prev: 'G', next: 'D7', bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '§2.4, §6.2, §4.2' },
  { id: 'B3', key: 'Em', prev: 'Em', next: 'B7', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§2.3, §2.4, §6.2' },
  { id: 'B4', key: 'C', prev: 'C', next: 'B7', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§3.2, §6.2' },
  { id: 'B5', key: 'Am', prev: 'Am7', next: 'Fmaj7', bass: 'F#', truth: 'Am6', candidate: 'F#m7b5', conflict: true, src: '§3.6, 案 N1' },
  { id: 'B6', key: 'Em', prev: 'Am7', next: 'B7', bass: 'C', truth: 'Am6', candidate: 'F#m7b5', conflict: true, src: '§2.4, §3.6, 案 N1' },
  { id: 'B7', key: 'Em', prev: 'Em', next: 'B7', bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '§2.3, §2.4' },
  { id: 'B8', key: 'C', prev: 'G', next: 'F', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§3.6, 案 N5' },
  // Csus2 / Gsus4 (and Asus2 / Esus4)
  { id: 'C1', key: 'C', prev: 'Dm7', next: 'G7', bass: 'G', truth: 'Gsus4', candidate: 'Csus2', conflict: false, src: '§3.7, §2.4' },
  { id: 'C2', key: 'C', prev: 'G7', next: 'C', bass: 'C', truth: 'Csus2', candidate: 'Gsus4', conflict: false, src: '§2.4, 案 N3' },
  { id: 'C3', key: 'C', prev: 'F', next: 'F', bass: 'C', truth: 'Csus2', candidate: 'Gsus4', conflict: false, src: '§2.4, §2.5, 案 N2' },
  { id: 'C4', key: 'C', prev: 'Am7', next: 'G', bass: 'D', truth: 'Gsus4', candidate: 'Csus2', conflict: true, src: '§3.7, §3.6' },
  { id: 'C5', key: 'C', prev: 'C', next: 'C', bass: 'D', truth: 'Csus2', candidate: 'Gsus4', conflict: true, src: '§3.6, 案 N1, 案 N3' },
  { id: 'C6', key: 'Am', prev: 'E7', next: 'Am', bass: 'A', truth: 'Asus2', candidate: 'Esus4', conflict: false, src: '§2.4, 案 N2, 案 N3' },
];
