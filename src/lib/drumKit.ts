/**
 * Drum kit table shared by the drum editor and the drum alphaTex codec (M5,
 * docs/m5-plan.md 設計判断 3, key map agreed in docs/m5-decisions.md).
 *
 * `step` is the input staff position (0 = bottom line, 8 = top line) that
 * the hand-drawn SVG staff (T14/T18) must draw at, chosen to match
 * alphaTab's own percussion rendering 1:1: `step = 8 − staffLine`, verified
 * for all 9 pieces against `alphaTab.importer.AlphaTexImporter`
 * (`track.percussionArticulations[note.percussionArticulation].staffLine`)
 * in docs/m5-alphatab-findings.md §8.4 and re-checked in drumKit.test.ts.
 *
 * `midi` is the id passed to `\articulation <id> <midi>` in
 * `partsToAlphaTex.ts`'s `DRUM_ARTICULATIONS` (kept in sync there — T1 is
 * 50 and T2 is 48, not the GM-typical 48/45, so that every piece except
 * HH/HO lands on a distinct `staffLine`; HH and HO deliberately share one
 * and are told apart by notehead instead).
 */

export type DrumInstrument =
  'CR' | 'RD' | 'HH' | 'HO' | 'T1' | 'SD' | 'T2' | 'FT' | 'BD';

export interface DrumKitEntry {
  /** alphaTex alias: the note name written in a part's body. */
  id: DrumInstrument;
  /** The id passed to `\articulation <id> <midi>` (see partsToAlphaTex.ts). */
  midi: number;
  /** Japanese display name. */
  name: string;
  /** Keyboard key, matched by `e.code` (docs/m5-decisions.md key map). */
  code: string;
  /** Input staff position: 0 = bottom line, 8 = top line. */
  step: number;
  /** Notehead shape drawn at `step`. */
  head: 'normal' | 'x' | 'circleX' | 'heavyX';
}

/** The 9-piece kit, top of the staff to bottom (descending `step`). */
export const DRUM_KIT: readonly DrumKitEntry[] = [
  {
    id: 'CR',
    midi: 49,
    name: 'クラッシュ',
    code: 'KeyU',
    step: 10,
    head: 'heavyX',
  },
  {
    id: 'HH',
    midi: 42,
    name: 'ハイハット（クローズ）',
    code: 'KeyH',
    step: 9,
    head: 'x',
  },
  {
    id: 'HO',
    midi: 46,
    name: 'ハイハット（オープン）',
    code: 'KeyG',
    step: 9,
    head: 'circleX',
  },
  { id: 'RD', midi: 51, name: 'ライド', code: 'KeyI', step: 8, head: 'x' },
  {
    id: 'T1',
    midi: 50,
    name: 'ハイタム',
    code: 'KeyK',
    step: 7,
    head: 'normal',
  },
  {
    id: 'T2',
    midi: 48,
    name: 'ミッドタム',
    code: 'KeyL',
    step: 6,
    head: 'normal',
  },
  { id: 'SD', midi: 38, name: 'スネア', code: 'KeyF', step: 5, head: 'normal' },
  {
    id: 'FT',
    midi: 41,
    name: 'フロアタム',
    code: 'Semicolon',
    step: 3,
    head: 'normal',
  },
  {
    id: 'BD',
    midi: 36,
    name: 'バスドラム',
    code: 'KeyJ',
    step: 1,
    head: 'normal',
  },
];

/** `DRUM_KIT` entry for a given instrument id (throws if unknown). */
export function drumKitEntry(id: DrumInstrument): DrumKitEntry {
  const entry = DRUM_KIT.find((e) => e.id === id);
  if (!entry) throw new RangeError(`unknown drum instrument: ${id}`);
  return entry;
}

/** `DRUM_KIT` entry whose key matches a keydown event's `e.code`, if any. */
export function drumKitEntryForCode(code: string): DrumKitEntry | undefined {
  return DRUM_KIT.find((e) => e.code === code);
}
