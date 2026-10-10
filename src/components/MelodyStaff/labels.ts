import {
  decompose,
  durationTicks,
  type Duration,
  ticksToDuration,
  type MelodyEvent,
  type NoteValue,
} from '../../lib/melody';
import { parsePitch, type Letter } from '../../lib/pitch';
import { fillZone } from '../../lib/tuplet';
import type { TupletMark } from '../../lib/tuplet';

/** Japanese labels for the melody staff (tooltip, aria-live). */

const SOLFEGE: Record<Letter, string> = {
  C: 'ド',
  D: 'レ',
  E: 'ミ',
  F: 'ファ',
  G: 'ソ',
  A: 'ラ',
  B: 'シ',
};
const ACC = { '': '', '#': '♯', b: '♭' } as const;

/** 'F#4' → 'ファ♯'; invalid → the input. */
export function solfege(pitch: string): string {
  const p = parsePitch(pitch);
  return p ? SOLFEGE[p.letter] + ACC[p.accidental] : pitch;
}

/** Hover tooltip: 'E4' → 「ミ（E4）」. */
export function pitchTooltip(pitch: string): string {
  return `${solfege(pitch)}（${pitch}）`;
}

/** 'G4' → 「ソ4」. */
export function spokenPitch(pitch: string): string {
  const p = parsePitch(pitch);
  return p ? `${solfege(pitch)}${p.octave}` : pitch;
}

const VALUE_NAME: Record<NoteValue['d'], string> = {
  '1': '全',
  '2': '2分',
  '4': '4分',
  '8': '8分',
  '16': '16分',
  '32': '32分',
};

function valueName(v: NoteValue, rest: boolean): string {
  return `${v.dotted ? '付点' : ''}${VALUE_NAME[v.d]}${rest ? '休符' : '音符'}`;
}

/** 16 → 「4分音符」, 24 → 「付点4分音符」, 40 → 「2分音符＋8分音符」. */
export function durationLabel(ticks: number, rest = false): string {
  const single = ticksToDuration(ticks);
  const values = single ? [single] : decompose(ticks);
  return values.map((v) => valueName(v, rest)).join('＋');
}

/** 「3連の 2 つ目」 (slot is 0-based; spoken 1-based). */
export function tupletSlotLabel(tuplet: TupletMark): string {
  return `${tuplet.n}連の ${tuplet.slot + 1} つ目`;
}

/**
 * 「3音目: ソ4、4分音符、歌詞 か」 / 「4音目: 4分休符」 (index is 0-based).
 * Inside a tuplet, the slot position (「3連の 2 つ目」) replaces the plain
 * duration (M5): the written unit matters less than where the note sits in
 * the group.
 */
export function describeEvent(event: MelodyEvent, index: number): string {
  const head = `${index + 1}音目`;
  const length = event.tuplet
    ? tupletSlotLabel(event.tuplet)
    : durationLabel(event.ticks, event.kind === 'rest');
  if (event.kind === 'rest') return `${head}: ${length}`;
  const parts = [
    spokenPitch(event.pitch ?? '?'),
    length,
    ...(event.lyric ? [`歌詞 ${event.lyric}`] : []),
    ...(event.chord ? [`コード ${event.chord}`] : []),
  ];
  return `${head}: ${parts.join('、')}`;
}

const isRestEvent = (events: readonly MelodyEvent[]) => (i: number) =>
  events[i].kind === 'rest';

/**
 * What the aria-live region says for the current cursor / selection. Right
 * after inserting a tuplet (M5), the cursor sits at the new, all-rest
 * group's start ("fill zone") rather than past it like every other insert —
 * describing "the event before the cursor" would then name whatever comes
 * BEFORE the new group instead of announcing it, so that one case describes
 * forward (the group's first slot) instead.
 */
export function announcement(
  events: MelodyEvent[],
  cursor: number,
  selected: number | null,
): string {
  if (selected !== null && events[selected]) {
    return `選択中 ${describeEvent(events[selected], selected)}`;
  }
  if (events.length === 0) return '音符なし';
  const zone = fillZone(events, cursor, isRestEvent(events));
  if (zone && zone.start === cursor) {
    return describeEvent(events[cursor], cursor);
  }
  if (cursor <= 0) return '先頭';
  const i = Math.min(cursor, events.length) - 1;
  return describeEvent(events[i], i);
}

/**
 * Short live-region text for an input-state change that does not touch the
 * notes (M8): 「8分音符」「付点あり」「基準オクターブ 5」. Null when nothing
 * of that kind changed.
 */
export function stateChangeMessage(
  before: { duration: Duration; dotted: boolean; baseOctave: number },
  after: { duration: Duration; dotted: boolean; baseOctave: number },
): string | null {
  if (after.baseOctave !== before.baseOctave) {
    return `基準オクターブ ${after.baseOctave}`;
  }
  if (after.duration !== before.duration) {
    return durationLabel(durationTicks(after.duration, after.dotted));
  }
  if (after.dotted !== before.dotted) {
    return after.dotted ? '付点あり' : '付点なし';
  }
  return null;
}
