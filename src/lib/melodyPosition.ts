import {
  barTicks,
  WHOLE_TICKS,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { atoms } from './tuplet';

/**
 * Real positions inside one melody section (tuplet slots at their actual fractional position), shared by the
 * humming review (S4) and the melody editor's playback. Bars and beats are 1-based and section-local.
 */

/** Ticks of one beat (the time signature's denominator). */
export const beatTicksOf = (ts: TimeSig) => WHOLE_TICKS / ts.den;

/** Real start tick of every event (tuplet slots at their actual fractional position). */
export function eventStarts(events: readonly MelodyEvent[]): number[] {
  const out: number[] = new Array(events.length);
  let pos = 0;
  for (const a of atoms(events)) {
    if (a.kind === 'single') {
      out[a.index] = pos;
      pos += a.ticks;
    } else {
      const slot = a.group.span / a.group.n;
      for (let i = a.group.start; i < a.group.end; i++) {
        out[i] = pos;
        pos += slot;
      }
    }
  }
  return out;
}

/** 1-based bar and beat of a tick; `onBeat` false when it is between beats. */
export function barBeatAt(
  tick: number,
  ts: TimeSig,
): { bar: number; beat: number; onBeat: boolean } {
  const bar = barTicks(ts);
  const beat = beatTicksOf(ts);
  const inBar = tick - Math.floor(tick / bar) * bar;
  return {
    bar: Math.floor(tick / bar) + 1,
    beat: Math.floor(inBar / beat) + 1,
    onBeat: inBar % beat === 0,
  };
}

/** 「1 小節目の 1 拍目」, 「2 小節目の 3 拍目のすこし後」 (between beats). */
export function positionLabel(tick: number, ts: TimeSig): string {
  const p = barBeatAt(tick, ts);
  return `${p.bar} 小節目の ${p.beat} 拍目${p.onBeat ? '' : 'のすこし後'}`;
}
