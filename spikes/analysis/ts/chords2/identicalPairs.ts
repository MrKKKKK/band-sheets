/**
 * Identical-note pairs of the staged vocabulary (plan §2.2 V1–V3, §2.3) and their truth table
 * (spike 7 T2, confirmed by the user 2026-11-15, decision U2). This file is the single source of the
 * rows; docs/audio-spike7-t2-truth.md gives the reason per row ID (a test keeps the IDs in sync).
 * `src` cites the theory note 「和声法ノート v3」 by § (v3 の追記 2026-11: §1.4, §3.5, §3.7, §3.8, §6.7).
 *
 * The stages, qualities and interval templates live in ./vocab (T3, the chords2 vocabulary); they are
 * re-exported here so this file's users keep one import.
 */
import { templates, type Stage } from './vocab';

export { NEW_TEMPLATES, STAGE_ADDS, stageQualities, templates, type Stage } from './vocab';

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
export const IDENTICAL_PAIRS: readonly IdenticalPair[] = [
  { a: '6', b: 'min7', offset: 9, stage: 'V1' }, // C6 = Am7
  { a: 'm6', b: 'm7b5', offset: 9, stage: 'V1' }, // Am6 = F#m7b5
  { a: 'sus2', b: 'sus4', offset: 7, stage: 'V2' }, // Csus2 = Gsus4
];

/** Same-quality symmetric groups: outside the §2.3 rule, root by ROOT_TIE as in v1a (plan §2.3). */
export const SYMMETRIC_EXCLUDED: readonly string[] = ['aug', 'dim7'];

/** One truth-table row (docs/audio-spike7-t2-truth.md has the reason per ID). */
export interface TruthRow {
  id: string;
  key: string; // 'C' major, 'Am' minor, ...
  prev: string | null;
  next: string | null;
  bass: string; // bass note name
  truth: string; // the reading taken as truth
  candidate: string; // the other reading of the pair, always kept as a candidate (plan §2.3)
  conflict: boolean; // 食い違う例: the bass is not the truth reading's root
  src: string; // theory-note § refs
}

export const TRUTH_ROWS: readonly TruthRow[] = [
  // C6 / Am7
  { id: 'A1', key: 'C', prev: 'G7', next: null, bass: 'C', truth: 'C6', candidate: 'Am7', conflict: false, src: '§2.4, §2.5, §4.2' },
  { id: 'A2', key: 'C', prev: 'Caug', next: 'C7', bass: 'C', truth: 'C6', candidate: 'Am7', conflict: false, src: '§3.8, §4.2' },
  { id: 'A3', key: 'Am', prev: 'AmM7', next: 'Am6', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '§3.8' },
  { id: 'A4', key: 'C', prev: 'Em7', next: 'Dm7', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '§2.4, §6.2' },
  { id: 'A5', key: 'Am', prev: 'Dm7', next: 'E7', bass: 'A', truth: 'Am7', candidate: 'C6', conflict: false, src: '§2.3, §6.2' },
  { id: 'A6', key: 'Am', prev: 'AmM7', next: 'Am6', bass: 'G', truth: 'Am7', candidate: 'C6', conflict: true, src: '§3.6, §3.8' },
  { id: 'A7', key: 'C', prev: 'C', next: 'F', bass: 'E', truth: 'C6', candidate: 'Am7', conflict: true, src: '§3.6, §3.8' },
  { id: 'A8', key: 'G', prev: 'Am', next: 'D7', bass: 'C', truth: 'C6', candidate: 'Am7', conflict: false, src: '§2.4, §6.7' },
  { id: 'A9', key: 'C', prev: 'Am', next: 'F', bass: 'G', truth: 'Am7', candidate: 'C6', conflict: true, src: '§3.6, §3.8' },
  { id: 'A10', key: 'C', prev: 'F', next: 'Dm7', bass: 'E', truth: 'C6', candidate: 'Am7', conflict: true, src: '§2.4, §2.5, §6.2' },
  // Am6 / F#m7b5 (and Fm6 / Dm7b5)
  { id: 'B1', key: 'Am', prev: 'Am7', next: null, bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '§3.8' },
  { id: 'B2', key: 'G', prev: 'G', next: 'D7', bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '§2.4, §6.2, §4.2' },
  { id: 'B3', key: 'Em', prev: 'Em', next: 'B7', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§2.3, §2.4, §6.2' },
  { id: 'B4', key: 'C', prev: 'C', next: 'B7', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§3.2, §6.2' },
  { id: 'B5', key: 'Am', prev: 'Am7', next: 'Fmaj7', bass: 'F#', truth: 'Am6', candidate: 'F#m7b5', conflict: true, src: '§3.6, §3.8' },
  { id: 'B6', key: 'Em', prev: 'Am7', next: 'B7', bass: 'C', truth: 'Am6', candidate: 'F#m7b5', conflict: true, src: '§2.4, §3.8' },
  { id: 'B7', key: 'Em', prev: 'Em', next: 'B7', bass: 'A', truth: 'Am6', candidate: 'F#m7b5', conflict: false, src: '§2.3, §2.4, §6.7' },
  { id: 'B8', key: 'C', prev: 'G', next: 'F', bass: 'F#', truth: 'F#m7b5', candidate: 'Am6', conflict: false, src: '§3.6, §6.7' },
  { id: 'B9', key: 'C', prev: 'F', next: 'C', bass: 'C', truth: 'Fm6', candidate: 'Dm7b5', conflict: true, src: '§3.4, §3.6, §3.8' },
  // Csus2 / Gsus4 (and Asus2 / Esus4, Fsus2 / Csus4)
  { id: 'C1', key: 'C', prev: 'Dm7', next: 'G7', bass: 'G', truth: 'Gsus4', candidate: 'Csus2', conflict: false, src: '§3.7, §2.4' },
  { id: 'C2', key: 'C', prev: 'G7', next: 'C', bass: 'C', truth: 'Csus2', candidate: 'Gsus4', conflict: false, src: '§2.4, §3.7' },
  { id: 'C3', key: 'C', prev: 'F', next: 'F', bass: 'C', truth: 'Csus2', candidate: 'Gsus4', conflict: false, src: '§2.4, §2.5, §1.4' },
  { id: 'C4', key: 'C', prev: 'Am7', next: 'G', bass: 'D', truth: 'Gsus4', candidate: 'Csus2', conflict: true, src: '§3.7, §3.6' },
  { id: 'C6', key: 'Am', prev: 'E7', next: 'Am', bass: 'A', truth: 'Asus2', candidate: 'Esus4', conflict: false, src: '§2.4, §1.4, §3.7' },
  { id: 'C7', key: 'C', prev: 'C', next: 'F', bass: 'F', truth: 'Fsus2', candidate: 'Csus4', conflict: false, src: '§2.4, §3.7, §6.7' },
];

/** Rows that are not identical pairs but sit next to them in the synthetic set (T5). */
export interface OtherRow {
  id: string;
  key: string;
  prev: string;
  next: string;
  notes: string; // pitch classes played, low to high
  truth: string;
  src: string;
}
export const OTHER_ROWS: readonly OtherRow[] = [
  // was C5: the right hand keeps C-E-G while the left hand plays C-D-E (passing bass, spike 6 "passing")
  { id: 'P1', key: 'C', prev: 'C', next: 'C/E', notes: 'D C E G', truth: 'C/D', src: '§3.6' },
];
