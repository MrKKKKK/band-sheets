/**
 * Japanese screen-reader / status text for the drum editor (M5 T19). Mirrors
 * `src/components/MelodyStaff/labels.ts`'s shapes so `DrumEditor` (T21) can
 * use both the same way: `announcement` for the aria-live region's cursor /
 * selection text, `stateChangeMessage` for input-state-only changes, and a
 * handful of one-shot messages for the commands that change the events
 * (shuffle, tuplet insert/remove, Shift+instrument on the previous beat).
 * Rejections already carry their own Japanese reason
 * (`drumInput.ts`'s `DrumCommandResult.message` / `MESSAGES`); `
 * rejectionMessage` is the explicit pass-through for that case so DrumEditor
 * has one place to look for "what does a command result become in the live
 * region".
 */

import {
  articulationOf,
  hasHit,
  sortHits,
  type Articulation,
  type DrumEvent,
  type DrumHit,
  type Shuffle,
} from './drum';
import { drumKitEntry, type DrumInstrument } from './drumKit';
import { durationTicks, ticksToDuration, type Duration } from './melody';
import type { TupletMark } from './tuplet';

const VALUE_NAME: Record<Duration, string> = {
  '1': '全',
  '2': '2分',
  '4': '4分',
  '8': '8分',
  '16': '16分',
  '32': '32分',
};

const ARTICULATION_LABEL: Record<Articulation, string | null> = {
  none: null,
  ghost: 'ゴースト',
  accent: 'アクセント',
  heavy: '強いアクセント',
};

/** 'BD' → 「バスドラム」; a ghost/accented hit → 「スネア（ゴースト）」等. */
export function instrumentLabel(hit: DrumHit): string {
  const name = drumKitEntry(hit.inst).name;
  const art = ARTICULATION_LABEL[articulationOf(hit)];
  return art ? `${name}（${art}）` : name;
}

/** [] → 「休符」; otherwise the hits in staff order, joined by ＋. */
export function hitsLabel(hits: readonly DrumHit[]): string {
  if (hits.length === 0) return '休符';
  return sortHits(hits).map(instrumentLabel).join('＋');
}

/**
 * A single (optionally dotted) note value: 64 → 「全」, 16 → 「4分」, 24 →
 * 「付点4分」. Ticks that are not a plain drum value (should not happen for
 * `isValidDrumTicks` ticks) fall back to the raw number.
 */
export function durationLabel(ticks: number): string {
  const v = ticksToDuration(ticks);
  if (!v) return `${ticks}`;
  return `${v.dotted ? '付点' : ''}${VALUE_NAME[v.d]}`;
}

/** { n: 3, slot: 1 } → 「3連の 2 つ目」 (slot is 0-based). */
export function tupletSlotLabel(mark: TupletMark): string {
  return `${mark.n}連の ${mark.slot + 1} つ目`;
}

/**
 * One beat: duration + hits/rest (「8分 ハイハット（クローズ）＋バスドラム」,
 * 「付点4分 休符」), or, inside a tuplet, the slot position instead of the
 * duration (「3連の 2 つ目、スネア（ゴースト）」).
 */
export function beatLabel(ev: DrumEvent): string {
  const content = hitsLabel(ev.hits);
  if (ev.tuplet) return `${tupletSlotLabel(ev.tuplet)}、${content}`;
  return `${durationLabel(ev.ticks)} ${content}`;
}

/**
 * 「3 番目: 8分 スネア」 (index is 0-based). 「番目」, not 「拍目」: the index
 * counts notes/rests from the section start, not musical beats
 * (m5-review.md R8).
 */
export function describeBeat(ev: DrumEvent, index: number): string {
  return `${index + 1} 番目: ${beatLabel(ev)}`;
}

/**
 * What the aria-live region says for the current cursor / selection —
 * mirrors `MelodyStaff/labels.ts`'s `announcement` with 「拍」 in place of
 * 「音」 (ModeStatus's unit for the drum editor). A stale selection (≥
 * length) is treated as no selection.
 */
export function announcement(
  events: readonly DrumEvent[],
  cursor: number,
  selected: number | null,
): string {
  if (selected !== null && events[selected]) {
    return `選択中 ${describeBeat(events[selected], selected)}`;
  }
  if (events.length === 0) return '拍なし';
  if (cursor <= 0) return '先頭';
  const i = Math.min(cursor, events.length) - 1;
  return describeBeat(events[i], i);
}

/**
 * Short live-region text for an input-state change that does not touch the
 * events (M8): 「8分」「付点あり」「付点2分」. Null when neither changed.
 */
export function stateChangeMessage(
  before: { duration: Duration; dotted: boolean },
  after: { duration: Duration; dotted: boolean },
): string | null {
  if (after.duration !== before.duration) {
    return durationLabel(durationTicks(after.duration, after.dotted));
  }
  if (after.dotted !== before.dotted) {
    return after.dotted ? '付点あり' : '付点なし';
  }
  return null;
}

/** 'none' → 「シャッフルなし」; '8' / '16' → 「シャッフル 8分」/「シャッフル 16分」. */
export function shuffleMessage(shuffle: Shuffle): string {
  if (shuffle === 'none') return 'シャッフルなし';
  return `シャッフル ${shuffle}分`;
}

/** TupletPicker's insert, applied: 「3連符を挿入しました」. */
export function tupletInsertedMessage(n: number): string {
  return `${n}連符を挿入しました`;
}

/** TupletPicker's delete, applied. */
export function tupletRemovedMessage(): string {
  return '連符を削除しました';
}

/**
 * Shift+instrument on the previous beat, applied: compares `before`/`after`
 * to say whether `inst` was added or removed.
 */
export function toggleOnPreviousMessage(
  inst: DrumInstrument,
  before: DrumEvent,
  after: DrumEvent,
): string {
  const added = !hasHit(before, inst) && hasHit(after, inst);
  const name = drumKitEntry(inst).name;
  return added ? `${name}を追加しました` : `${name}を外しました`;
}

/**
 * The live-region text for a refused command: the rejection reason itself
 * (`DrumCommandResult.message`), unchanged. Null when the command was not
 * refused (DrumEditor then computes the message itself, e.g. via
 * `stateChangeMessage` / `shuffleMessage` / `tupletInsertedMessage` /
 * `toggleOnPreviousMessage`).
 */
export function rejectionMessage(message?: string): string | null {
  return message ?? null;
}
