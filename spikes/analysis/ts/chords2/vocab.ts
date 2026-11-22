/**
 * The chords2 (spike 7) vocabulary: stages V0-V3 (plan §2.2), interval templates, names, the expanded state
 * space, and the "family" mapping of each new quality to an existing quality's transition row (theory note §1.4).
 * V0 = the 120 v1a states (ts/dsp/vocab.ts, read only); each later stage appends 12 states per new quality.
 */
import * as v1 from '../dsp/vocab';
import { intervals } from '../dsp/vocab';
import type { ChordState, VocabConfig } from '../dsp/vocab';

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

/**
 * Interval templates of the new qualities. V3: the no-5th form is a second template of the same quality (§2.2).
 * 7sus4 deliberately has no no-5th template: with one, D7sus4 (no 5th) = Gsus4 = Csus2 would make a triple
 * (plan §2.2 V2 risk); adding it means extending the pair rule to triples first.
 */
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


/** The qualities a stage adds beyond V0 (state order: V0 states first, then these in this order). */
export function newQualities(stage: Stage): string[] {
  return stageQualities(stage).filter((q) => q in NEW_TEMPLATES);
}

/**
 * State space of a stage: the v1a states (`vocab.states`, in v1a order) then 12 roots per new quality.
 * V0 = 120, V1 = 156, V2 = 204, V3 = 240.
 */
export function states(stage: Stage, v1cfg: VocabConfig): ChordState[] {
  const out = v1.states(v1cfg);
  for (const quality of newQualities(stage)) for (let root = 0; root < 12; root++) out.push({ root, quality });
  return out;
}

const SUFFIX: Record<string, string> = {
  mM7: 'mM7',
  m6: 'm6',
  '6': '6',
  sus2: 'sus2',
  '7sus4': '7sus4',
  add9: 'add9',
  madd9: 'madd9',
  '9': '9',
  m9: 'm9',
  maj9: 'maj9', // follows the existing 'maj7'
};

export function suffix(quality: string): string {
  return SUFFIX[quality] ?? v1.suffix(quality);
}

/**
 * 仲間の写し (note §1.4): the existing quality whose row and column of the transition tier matrix a new
 * quality uses. A tuple = the stronger (elementwise max) of those qualities' tiers (sus2: maj or min).
 */
export const FAMILY_OF: Readonly<Record<string, readonly string[]>> = {
  '6': ['maj'],
  add9: ['maj'],
  maj9: ['maj7'],
  mM7: ['min'],
  m6: ['min'],
  madd9: ['min'],
  m9: ['min7'],
  '9': ['7'],
  '7sus4': ['sus4'],
  sus2: ['maj', 'min'],
};

/** The existing qualities a state's tiers come from (itself for an existing quality). */
export function familyOf(quality: string): readonly string[] {
  return FAMILY_OF[quality] ?? [quality];
}
