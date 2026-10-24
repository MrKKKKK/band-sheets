import { WHOLE_TICKS, type MelodyEvent } from '../melody';
import { parsePitch, pitchToMidi } from '../pitch';
import { atoms } from '../tuplet';

/**
 * Melody events -> the notes to sound, for the recording-vs-draft listening
 * comparison (docs/audio-integration-plan.md §4 S4, a simple Web Audio tone).
 * One `MelodyEvent` is one sounding note (a tie across a barline is inside
 * one event); rests are silent; tuplet slots last their real length.
 */

export interface SoundingNote {
  /** Index of the note in the input events (for the moving cursor). */
  index: number;
  /** Seconds, on the same clock as `startSec` (the recording's). */
  start: number;
  duration: number;
  midi: number;
  hz: number;
}

/** Equal temperament, A4 (MIDI 69) = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * `tempo` is the song's `{tempo}` (quarter notes per minute, e.g.
 * `HumDraftOk.tempo`), `startSec` the second of tick 0 (bar 1 head, e.g.
 * `HumDraftOk.startSec`). Time-ordered. Throws RangeError for a tempo that is
 * not a positive number, or a broken tuplet (as `atoms`).
 */
export function playbackNotes(
  events: readonly MelodyEvent[],
  tempo: number,
  startSec: number,
): SoundingNote[] {
  if (!(Number.isFinite(tempo) && tempo > 0))
    throw new RangeError(`invalid tempo: ${tempo}`);
  const tickSec = 60 / (tempo * (WHOLE_TICKS / 4));
  const out: SoundingNote[] = [];
  let pos = 0; // real ticks
  const sound = (index: number, ticks: number) => {
    const e = events[index];
    const p = e.kind === 'note' && e.pitch ? parsePitch(e.pitch) : null;
    if (p) {
      const midi = pitchToMidi(p);
      out.push({
        index,
        start: startSec + pos * tickSec,
        duration: ticks * tickSec,
        midi,
        hz: midiToHz(midi),
      });
    }
    pos += ticks;
  };
  for (const a of atoms(events)) {
    if (a.kind === 'single') sound(a.index, a.ticks);
    else
      for (let i = a.group.start; i < a.group.end; i++)
        sound(i, a.group.span / a.group.n);
  }
  return out;
}
