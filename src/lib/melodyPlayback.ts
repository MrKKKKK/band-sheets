/**
 * Playback in the melody editor (the メロディ tab's player bar; sketch
 * https://claude.ai/artifact/WjYDhuLPY7TRVZHH1BTcta, agreed 2026-10-24):
 * the current section only, from the selected note / the cursor (or the
 * section head) to its end, as sine tones (hooks/tonePlayer.ts). Pure: where
 * to start, what sounds when, and the player bar / live-region texts.
 */
import { DEFAULT_TEMPO } from './autoScroll';
import { playbackNotes, type SoundingNote } from './playback';
import {
  barTicks,
  totalTicks,
  WHOLE_TICKS,
  type MelodyEvent,
  type TimeSig,
} from './melody';
import { eventStarts, positionLabel } from './melodyPosition';

/** The song's `{tempo}` (♩ per minute), else `DEFAULT_TEMPO` with `set: false` (「未設定」). */
export function playbackTempo(tempo: number | undefined): {
  tempo: number;
  set: boolean;
} {
  return tempo !== undefined && Number.isFinite(tempo) && tempo > 0
    ? { tempo, set: true }
    : { tempo: DEFAULT_TEMPO, set: false };
}

export interface PlaybackStart {
  /** First event to play. */
  index: number;
  from: 'selection' | 'cursor' | 'head';
}

const hasNoteFrom = (events: readonly MelodyEvent[], i: number) =>
  events.slice(i).some((e) => e.kind === 'note');

/**
 * Where 「再生」 starts: the selected event, else the cursor. The section head
 * when that is 0, or nothing but rests follows it (e.g. the cursor at the end
 * after typing). null when the section has no note at all.
 */
export function playbackStart(
  events: readonly MelodyEvent[],
  state: { cursor: number; selected: number | null },
): PlaybackStart | null {
  if (!hasNoteFrom(events, 0)) return null;
  const head: PlaybackStart = { index: 0, from: 'head' };
  const at = state.selected ?? state.cursor;
  if (at <= 0 || !hasNoteFrom(events, at)) return head;
  return { index: at, from: state.selected !== null ? 'selection' : 'cursor' };
}

export interface PlaybackPlan {
  /** Seconds from the start point (0 = the first played event). */
  notes: SoundingNote[];
  /** Every played event (rests too) and when it begins: drives the playhead. */
  steps: { index: number; start: number }[];
  duration: number;
}

/** What sounds when, from event `from` to the section end (ties = one note, tuplets at their real length). */
export function playbackPlan(
  events: readonly MelodyEvent[],
  tempo: number,
  from: number,
): PlaybackPlan {
  const tickSec = 60 / (tempo * (WHOLE_TICKS / 4));
  const starts = eventStarts(events);
  const offset = (starts[from] ?? 0) * tickSec;
  return {
    notes: playbackNotes(events, tempo, -offset).filter((n) => n.index >= from),
    steps: starts
      .slice(from)
      .map((t, i) => ({ index: from + i, start: t * tickSec - offset })),
    duration: totalTicks(events) * tickSec - offset,
  };
}

/** The event at second `t` of the plan (a rest too); null from the end on. */
export function stepAt(plan: PlaybackPlan, t: number): number | null {
  if (t >= plan.duration) return null;
  let at: number | null = null;
  for (const s of plan.steps) {
    if (s.start > t) break;
    at = s.index;
  }
  return at ?? plan.steps[0]?.index ?? null;
}

/** 「3 小節目の 2 拍目」 of event `index`. */
export function eventPosition(
  events: readonly MelodyEvent[],
  ts: TimeSig,
  index: number,
): string {
  return positionLabel(eventStarts(events)[index] ?? 0, ts);
}

/** The player bar's hint while stopped. */
export function startHint(
  start: PlaybackStart,
  events: readonly MelodyEvent[],
  ts: TimeSig,
): string {
  if (start.from === 'head') return 'セクションの最初から鳴らします';
  const where = eventPosition(events, ts, start.index);
  return start.from === 'cursor'
    ? `カーソルの位置（${where}）から鳴らします`
    : `選んだ音（${where}）から鳴らします`;
}

/** Bar of event `index` and the section's bar count (「3 / 4 小節」). */
export function barProgress(
  events: readonly MelodyEvent[],
  ts: TimeSig,
  index: number,
): { bar: number; bars: number } {
  const size = barTicks(ts);
  return {
    bar: Math.floor((eventStarts(events)[index] ?? 0) / size) + 1,
    bars: Math.max(1, Math.ceil(totalTicks(events) / size)),
  };
}

/** Live-region texts (the editor's one live region). */
export function startMessage(
  events: readonly MelodyEvent[],
  ts: TimeSig,
  index: number,
): string {
  return `${barProgress(events, ts, index).bar} 小節目から再生します`;
}
export const STOPPED_MESSAGE = '止めました';
export const FINISHED_MESSAGE = '最後まで再生しました';
export const FAILED_MESSAGE = '音を鳴らせませんでした';
/** Player-bar hint and live text when 再生 can't be used. */
export const READ_ONLY_MESSAGE = '読み取り専用のセクションは再生できません';
export const NO_NOTES_HINT = '音符を入れると再生できます';
export const NO_NOTES_MESSAGE = '再生する音符がありません';
