/**
 * Spike 7 T4: the "落" (down-mapped) vocabulary of the chords2 scorer (plan §5; theory note §4.2 "採点の対応", proposal N7
 * in docs/audio-spike7-t2-note-proposal.md). A quality of the full vocabulary ("全") is mapped to the v1a vocabulary (the 11
 * names of ts/bass/score.ts `mapVocab`, which mirrors py/score.py `map_vocab`) so a v2 result can be compared with v1a.
 *
 * The rule is `mapVocab` plus these table rows (the only differences from spike 6's mapping are mM7 / madd9 handling):
 *   mM7 -> min (spike 6 dropped it), m6 -> min, madd9 -> min, 6 -> maj, add9 -> maj, 9 -> 7, m9 -> min7, maj9 -> maj7,
 *   7sus4 -> sus4, and sus2 -> null: NOT counted (v1a never emits a 5, so mapping it to 5 would make every baseline lose).
 * null = the chord is dropped from the "落" scoring (truth) or counts as no match (result).
 */
import { mapVocab } from '../../bass/score';
import { stageQualities } from '../vocab';

/** The table rows above (full-vocabulary qualities that `mapVocab` would not map this way). */
export const MAP_DOWN: Readonly<Record<string, string | null>> = {
  mM7: 'min',
  m6: 'min',
  madd9: 'min',
  '6': 'maj',
  add9: 'maj',
  '9': '7',
  m9: 'min7',
  maj9: 'maj7',
  '7sus4': 'sus4',
  sus2: null,
};

/** A quality (full-vocabulary name or a verbatim suffix such as '7(#9)', 'mM7(9)') in the v1a vocabulary, or null (dropped). */
export function mapDown(quality: string | null | undefined): string | null {
  if (quality === null || quality === undefined) return null;
  const q = String(quality).trim();
  if (Object.prototype.hasOwnProperty.call(MAP_DOWN, q)) return MAP_DOWN[q];
  const s = q.replace(/[(),\s]/g, '');
  if (!s.includes('sus2') && /^(mM|mmaj|minmaj|minM|m\^|mΔ)/.test(s)) return 'min'; // minor-major forms: like mM7
  return mapVocab(q);
}

/** The qualities of "全": every stage's, plus the power chord '5' (truth only; the analyzer never emits it). */
export const FULL_QUALITIES: readonly string[] = [...stageQualities('V3'), '5'];

/** A quality as one of FULL_QUALITIES, or null (outside the full vocabulary: such a truth chord is not scored in "全"). */
export const fullQuality = (quality: string | null | undefined): string | null =>
  quality !== null && quality !== undefined && FULL_QUALITIES.includes(String(quality).trim()) ? String(quality).trim() : null;
