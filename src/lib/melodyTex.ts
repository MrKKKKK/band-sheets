/**
 * alphaTex writer for the melody subset. See the big spec comment at the
 * top of `melody.ts` (section "Writing") for the exact contract this
 * implements; golden data lives in `src/lib/fixtures/melodyFixtures.ts`.
 */

import {
  cleanTexText,
  slurId,
  slurMarks,
  splitAtBars,
  type BarPiece,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { tupletTex } from './tuplet';

/** Writes one beat's effects: `{d t tu N lyrics "…" ch "…" slur "…"}` (in that order, empty omitted). */
function effectsOf(piece: BarPiece, slur: string | undefined): string {
  const { event, dotted, isContinuation, tuplet } = piece;
  const isNote = event.kind === 'note';
  const parts: string[] = [];
  if (dotted) parts.push('d');
  if (isContinuation && isNote) parts.push('t');
  if (tuplet) parts.push(tupletTex(tuplet.n));
  if (!isContinuation && isNote) {
    const lyric = cleanTexText(event.lyric);
    if (lyric !== undefined) parts.push(`lyrics "${lyric}"`);
  }
  if (!isContinuation) {
    const chord = cleanTexText(event.chord);
    if (chord !== undefined) parts.push(`ch "${chord}"`);
  }
  if (slur !== undefined) parts.push(`slur "${slur}"`);
  return parts.length > 0 ? `{${parts.join(' ')}}` : '';
}

/**
 * Serializes a flat event list into an alphaTex section body (one bar per
 * line, each ending with ` |`, joined with `\n`, no trailing newline; ''
 * when there are no events). See `melody.ts`'s spec comment for the full
 * contract (duration tokens, effect order, ties, `{tu N}` on every tuplet
 * slot, lyric/chord placement, melisma slurs). Throws RangeError (Japanese
 * message for tuplet problems) like `splitAtBars`, e.g. when a tuplet would
 * cross a barline. `label` is the section's label; it only makes the slur
 * ids unique within the part (`slurId`).
 */
export function serializeMelody(
  events: MelodyEvent[],
  ts: TimeSig,
  label = '',
): string {
  const bars = splitAtBars(events, ts);
  if (bars.length === 0) return '';
  const marks = slurMarks(bars, events);

  let prevDuration: string | undefined;
  const lines = bars.map((bar) => {
    const tokens = bar.map((piece) => {
      const prefix =
        prevDuration === undefined || piece.d !== prevDuration
          ? `:${piece.d} `
          : '';
      prevDuration = piece.d;
      const head = piece.event.kind === 'note' ? piece.event.pitch! : 'r';
      const mark = marks.get(piece);
      const slur = mark && slurId(label, mark.n);
      return `${prefix}${head}${effectsOf(piece, slur)}`;
    });
    return `${tokens.join(' ')} |`;
  });
  return lines.join('\n');
}
