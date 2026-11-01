/** What the take card shows and plays of a take (docs/mic-recording-plan.md §2.7), pure. */
import { clickBeats, clickNotes } from './clickTrack';
import type { SoundingNote } from '../playback';
import type { TakeInfo } from './recorderState';

/** The clicks the take was recorded with, as notes for 「クリックも一緒に聞く」. */
export function takeClickNotes(
  take: Pick<TakeInfo, 'meter' | 'durationSec'>,
): SoundingNote[] {
  return clickNotes(
    clickBeats(take.meter.tempo, take.meter.ts, take.durationSec),
  );
}

/** The bars after the count-in, rounded (「約 N 小節」). */
export function takeBars(
  take: Pick<TakeInfo, 'durationSec' | 'bar1Sec'>,
): number {
  return Math.max(
    0,
    Math.round((take.durationSec - take.bar1Sec) / take.bar1Sec),
  );
}
