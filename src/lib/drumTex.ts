/**
 * alphaTex writer for the drum subset. See the big spec comment at the top
 * of `drum.ts` ("Writing") for the exact contract this implements; golden
 * data lives in `src/lib/fixtures/drumFixtures.ts`.
 */

import {
  SHUFFLE_TEX,
  drumBars,
  type DrumEvent,
  type DrumHit,
  type Shuffle,
} from './drum';
import { ticksToDuration, type TimeSig } from './melody';
import { atoms, tupletTex } from './tuplet';

/** The note effect token (no braces), or undefined when the hit is plain. */
function noteEffectToken(hit: DrumHit): string | undefined {
  if (hit.ghost) return 'g';
  if (hit.accent === 'heavy') return 'hac';
  if (hit.accent === 'normal') return 'ac';
  return undefined;
}

/**
 * One beat's body + effects (no `:N` prefix). `tupletN` is the enclosing
 * group's n, when this beat is one of its slots (always undotted then).
 */
function renderBeat(
  ev: DrumEvent,
  dotted: boolean,
  tupletN: number | undefined,
): string {
  const beatEffects: string[] = [];
  if (dotted) beatEffects.push('d');
  if (tupletN !== undefined) beatEffects.push(tupletTex(tupletN));

  if (ev.hits.length === 0) {
    return beatEffects.length > 0 ? `r{${beatEffects.join(' ')}}` : 'r';
  }
  if (ev.hits.length === 1) {
    const noteEffect = noteEffectToken(ev.hits[0]);
    const parts = [
      ...(noteEffect !== undefined ? [noteEffect] : []),
      ...beatEffects,
    ];
    const braces = parts.length > 0 ? `{${parts.join(' ')}}` : '';
    return `${ev.hits[0].inst}${braces}`;
  }
  const names = ev.hits
    .map((h) => {
      const noteEffect = noteEffectToken(h);
      return noteEffect !== undefined ? `${h.inst}{${noteEffect}}` : h.inst;
    })
    .join(' ');
  const braces = beatEffects.length > 0 ? `{${beatEffects.join(' ')}}` : '';
  return `(${names})${braces}`;
}

/**
 * Serializes a flat event list into an alphaTex section body. See `drum.ts`'s
 * spec comment for the full contract (`\tf` line, bar splitting, `:N`,
 * note/beat effects, `{tu N}` on every tuplet slot). `events` must already
 * be normalized (`normalizeDrums`); this function does not normalize them.
 * Throws RangeError (the message from `drumBars`/`tuplet.ts`, Japanese for
 * tuplet problems) when a beat or a tuplet group crosses a barline, when a
 * tuplet group is broken, or when an event's `ticks` is not one note value.
 */
export function serializeDrums(
  events: DrumEvent[],
  shuffle: Shuffle,
  ts: TimeSig,
): string {
  if (events.length === 0) return '';
  const bars = drumBars(events, ts);
  const lines: string[] = [`\\tf ${SHUFFLE_TEX[shuffle]}`];

  let prevDur: string | undefined;
  let barIndex = 0;
  let tokens: string[] = [];

  const withPrefix = (d: string, body: string): string => {
    const prefix = prevDur === undefined || d !== prevDur ? `:${d} ` : '';
    prevDur = d;
    return `${prefix}${body}`;
  };
  const flushThrough = (end: number): void => {
    while (barIndex < bars.length && bars[barIndex].end === end) {
      lines.push(`${tokens.join(' ')} |`);
      tokens = [];
      barIndex++;
    }
  };

  for (const a of atoms(events)) {
    if (a.kind === 'single') {
      const ev = events[a.index];
      const nv = ticksToDuration(ev.ticks);
      if (!nv) {
        throw new RangeError(
          `${a.index + 1} 番目の拍の長さ（${ev.ticks}）が正しくありません`,
        );
      }
      tokens.push(withPrefix(nv.d, renderBeat(ev, nv.dotted, undefined)));
      flushThrough(a.index + 1);
    } else {
      const { group } = a;
      const nv = ticksToDuration(group.unitTicks);
      if (!nv) {
        throw new RangeError(
          `${group.start + 1} 番目の拍の長さ（${group.unitTicks}）が正しくありません`,
        );
      }
      for (let k = group.start; k < group.end; k++) {
        tokens.push(withPrefix(nv.d, renderBeat(events[k], false, group.n)));
      }
      flushThrough(group.end);
    }
  }
  return lines.join('\n');
}
