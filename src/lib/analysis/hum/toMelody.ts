/**
 * Spike 4 T6: QuantizedMelody -> the app's melody model (docs/audio-spike4-plan.md section 2 "result").
 *
 * src/lib is READ ONLY here: this only checks that the analyzer output can be written by the app's own code.
 *   toMelodyEvents()   QuantizedMelody -> MelodyEvent[] (one event per note/rest; a note crossing a bar line stays
 *                      one event, as in the model; pitch spelled by midiToPitch (sharps, or by `key`); triplet
 *                      slots (triplet switch) become `tuplet: {n: 3, slot}` events of written 8 ticks)
 *   melodyRoundTrip()  + splitAtBars (bar layout, ties/decompose) -> serializeMelody -> parseMelody, and whether
 *                      the parsed events deep-equal the input events.
 */
import {
  barTicks,
  splitAtBars,
  type MelodyEvent,
  type TimeSig,
} from '../../melody';
import { parseMelody } from '../../melodyParse';
import { serializeMelody } from '../../melodyTex';
import { formatPitch, midiToPitch } from '../../pitch';
import { checkQuantized, type QuantizedEventT } from './quantize';
import type { QuantizedMelody } from './types';

export const timeSigOf = (ts: [number, number]): TimeSig => ({
  num: ts[0],
  den: ts[1],
});

/** MIDI -> app pitch string ('C4', 'C#4', 'Bb3' with a flat key). Throws outside the model's octaves 0..8. */
export function midiToPitchString(midi: number, key?: string): string {
  if (!Number.isInteger(midi))
    throw new RangeError(`midi must be an integer: ${midi}`);
  const p = midiToPitch(midi, key);
  if (p.octave < 0 || p.octave > 8)
    throw new RangeError(
      `midi ${midi} is outside the melody model (octaves 0-8)`,
    );
  return formatPitch(p);
}

/**
 * The events of `q` as MelodyEvent[]. Throws when `q` breaks its invariants (gaps, overlaps, bad ticks,
 * two rests in a row: those would not survive the parse round trip).
 */
export function toMelodyEvents(
  q: QuantizedMelody,
  key?: string,
): MelodyEvent[] {
  const errs = checkQuantized(q);
  if (errs.length)
    throw new RangeError(`invalid QuantizedMelody: ${errs.join('; ')}`);
  return q.events.map((e0) => {
    const e = e0 as QuantizedEventT;
    const ev: MelodyEvent =
      e.kind === 'note'
        ? {
            kind: 'note',
            pitch: midiToPitchString(e.midi, key),
            ticks: e.ticks,
          }
        : { kind: 'rest', ticks: e.ticks };
    if (e.tuplet) ev.tuplet = { n: e.tuplet.n, slot: e.tuplet.slot };
    return ev;
  });
}

export interface RoundTrip {
  events: MelodyEvent[];
  /** Number of bars (splitAtBars) and of written beats (pieces, incl. tied continuations). */
  bars: number;
  pieces: number;
  /** Tied continuation pieces (notes split at bar lines or decomposed). */
  ties: number;
  /** serializeMelody output (one section body). */
  tex: string;
  /** parseMelody accepted the text. */
  parsed: boolean;
  /** The parsed events deep-equal `events`. */
  identical: boolean;
  /** parseMelody's read-only reason, or a description of the first difference. */
  problem?: string;
}

function sameEvent(a: MelodyEvent, b: MelodyEvent): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
const canon = (e: MelodyEvent) => ({
  kind: e.kind,
  pitch: e.pitch,
  ticks: e.ticks,
  lyric: e.lyric,
  chord: e.chord,
  tuplet: e.tuplet ? { n: e.tuplet.n, slot: e.tuplet.slot } : undefined,
});

/** QuantizedMelody -> MelodyEvent[] -> splitAtBars / serializeMelody -> parseMelody, compared. */
export function melodyRoundTrip(
  q: QuantizedMelody,
  key?: string,
  label = 'hum',
): RoundTrip {
  const ts = timeSigOf(q.ts);
  barTicks(ts); // throws for an unsupported time signature
  const events = toMelodyEvents(q, key);
  const bars = splitAtBars(events, ts);
  const pieces = bars.reduce((s, b) => s + b.length, 0);
  const ties = bars.reduce(
    (s, b) => s + b.filter((p) => p.isContinuation).length,
    0,
  );
  const tex = serializeMelody(events, ts, label);
  const res = parseMelody(tex, ts);
  if (!res.ok)
    return {
      events,
      bars: bars.length,
      pieces,
      ties,
      tex,
      parsed: false,
      identical: false,
      problem: res.reason,
    };
  let problem: string | undefined;
  if (res.events.length !== events.length)
    problem = `event count ${res.events.length} != ${events.length}`;
  else {
    const i = events.findIndex((e, k) => !sameEvent(e, res.events[k]));
    if (i >= 0) problem = `event ${i} differs`;
  }
  return {
    events,
    bars: bars.length,
    pieces,
    ties,
    tex,
    parsed: true,
    identical: problem === undefined,
    problem,
  };
}
