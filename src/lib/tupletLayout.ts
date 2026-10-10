/**
 * Pure layout of a tuplet bracket: the line segments (two hooks + the
 * horizontal line broken for the number) and the number's position, for one
 * tuplet group (docs/m5-plan.md T5). Assumes the group never spans systems
 * (the plan's design decision — a group that would cross a bar/system is
 * read-only or rejected upstream, see `tuplet.ts`'s `groupsFitBars`).
 *
 * Inputs are plain numbers (x positions, stem-tip y, the printed count), not
 * `tuplet.ts`'s `TupletGroup` or any staff-layout type: this module has no
 * dependency on how the caller computed them. `drumLayout.ts` (T14) and
 * `staffLayout.ts` (T16) each pass the x/y they already have for every beat
 * in the group.
 *
 * Coordinates: y grows downwards, same convention as `staffLayout.ts`.
 *
 * Design choices:
 * - **Mixed stem heights.** The bracket is a single FLAT line, not a slope.
 *   It sits `CLEARANCE` staff spaces beyond the group's most extreme tip
 *   (the smallest y for `side: 'above'`, the largest for `side: 'below'`),
 *   so it clears every beat in between, not just the two ends. The two end
 *   hooks are a fixed short length (`HOOK_LEN`), not stretched down to each
 *   end beat's own tip — this is how Finale/Sibelius-style tuplet brackets
 *   are drawn, and it keeps the bracket's shape independent of how uneven
 *   the stems are (one very tall note in the middle doesn't tilt anything).
 * - **The number** sits centered on the bracket, in a gap sized to the
 *   digit count (`numberGapWidth`); the bracket's horizontal line is split
 *   into a left and right arm around that gap, each at least `MIN_ARM`
 *   long.
 * - **Single-beat / narrow groups.** If the beats are too close together
 *   (including a single beat, where `xs.length === 1`) for both arms to fit
 *   at their minimum length, the bracket is widened symmetrically around
 *   its center to the minimum total width that fits the gap + two arms —
 *   it never collapses to a point or lets the arms overlap the gap.
 * - **The number's glyph** is Bravura's SMuFL "Tuplets" range (U+E880 =
 *   tuplet0 … U+E889 = tuplet9, confirmed against the SMuFL 1.4 spec), the
 *   same convention `staffLayout.ts` uses for time-signature digits, so the
 *   caller draws it with `font-family: var(--font-music)` like everything
 *   else on the staff instead of a plain-text font.
 */

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TupletNumberGlyph {
  /** Bravura "Tuplets" glyphs (tuplet0…tuplet9), one per digit, left to right. */
  text: string;
  /** Center x (text-anchor middle). */
  x: number;
  /** Baseline y. */
  y: number;
}

export interface TupletBracketInput {
  /** The printed count (the group's `n`; must be a positive integer). */
  n: number;
  /**
   * x of each beat in the group, left to right, one per slot (length ≥ 1,
   * same length as `tipYs`). Typically the stem x, or the notehead/rest
   * center for a stemless piece.
   */
  xs: readonly number[];
  /**
   * Stem-tip y for each beat, same order as `xs` — the end of the stem
   * furthest from the notehead, or (for a rest) the point on the glyph
   * nearest `side` that the bracket should clear.
   */
  tipYs: readonly number[];
  /**
   * Which side of the notes the bracket is drawn on: 'above' for stems up
   * (smaller y = higher on screen), 'below' for stems down. The caller
   * resolves which side to use when a group mixes stem directions — this
   * function always draws one flat bracket on the given side.
   */
  side: 'above' | 'below';
  /** px per staff space; every other metric here scales with it. */
  staffSpace: number;
}

export interface TupletBracketLayout {
  /** Always 4, in this order: left hook, left arm, right arm, right hook. */
  line: LineSegment[];
  number: TupletNumberGlyph;
}

const CLEARANCE = 1.0; // staff spaces: bracket line beyond the extreme tip
const HOOK_LEN = 0.6; // staff spaces: fixed length of each end hook
const DIGIT_GAP_W = 0.9; // staff spaces: width reserved per digit in the number gap
const GAP_PAD = 0.35; // staff spaces: extra clearance each side of the digits
const MIN_ARM = 0.4; // staff spaces: shortest visible arm on each side of the gap
const NUMBER_BASELINE_OFFSET = 0.35; // staff spaces: baseline below the bracket's visual center

/** SMuFL "Tuplets" glyphs (U+E880 = tuplet0 … U+E889 = tuplet9). */
function tupletDigits(n: number): string {
  return String(n)
    .split('')
    .map((c) => String.fromCharCode(0xe880 + Number(c)))
    .join('');
}

function numberGapWidth(n: number): number {
  return String(n).length * DIGIT_GAP_W + 2 * GAP_PAD;
}

/**
 * Layout for one tuplet bracket (line segments + number position).
 *
 * Throws `RangeError` if `n` isn't a positive integer, or if `xs`/`tipYs`
 * are empty or of different lengths — every group has at least one beat.
 */
export function layoutTupletBracket(
  input: TupletBracketInput,
): TupletBracketLayout {
  const { n, xs, tipYs, side, staffSpace: s } = input;
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(
      `layoutTupletBracket: n must be a positive integer, got ${n}`,
    );
  }
  if (xs.length === 0 || xs.length !== tipYs.length) {
    throw new RangeError(
      'layoutTupletBracket: xs and tipYs must be non-empty and the same length',
    );
  }

  // y grows downwards; 'above' moves toward smaller y, 'below' toward larger y.
  const sign = side === 'above' ? -1 : 1;
  const extremeTip = side === 'above' ? Math.min(...tipYs) : Math.max(...tipYs);
  const bracketY = extremeTip + sign * CLEARANCE * s;
  // The hooks drop from the bracket line back toward the notes, i.e. the
  // opposite direction from where the bracket line was pushed out to.
  const hookEnd = bracketY - sign * HOOK_LEN * s;

  let left = xs[0];
  let right = xs[xs.length - 1];
  const gapW = numberGapWidth(n) * s;
  const minWidth = gapW + 2 * MIN_ARM * s;
  if (right - left < minWidth) {
    const center = (left + right) / 2;
    left = center - minWidth / 2;
    right = center + minWidth / 2;
  }
  const centerX = (left + right) / 2;
  const halfGap = gapW / 2;

  const line: LineSegment[] = [
    { x1: left, y1: bracketY, x2: left, y2: hookEnd }, // left hook
    { x1: left, y1: bracketY, x2: centerX - halfGap, y2: bracketY }, // left arm
    { x1: centerX + halfGap, y1: bracketY, x2: right, y2: bracketY }, // right arm
    { x1: right, y1: bracketY, x2: right, y2: hookEnd }, // right hook
  ];

  return {
    line,
    number: {
      text: tupletDigits(n),
      x: centerX,
      y: bracketY + NUMBER_BASELINE_OFFSET * s,
    },
  };
}
