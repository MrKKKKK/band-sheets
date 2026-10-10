import type { MelodyEvent } from './melody';
import { splitSyllables } from './syllables';

/**
 * Lyric assignment on a melody section (M4, docs/m4-plan.md decision 5).
 *
 * ## Model
 *
 * Lyrics live on notes (`MelodyEvent.lyric`); rests never carry one. From
 * the events we derive
 * - the syllable COUNT per note: `splitSyllables(lyric ?? '').length`
 *   (0 = no lyric: a melisma continuation or simply unassigned), and
 * - the syllable STREAM: all notes' syllables concatenated in order.
 * Every operation edits the counts and re-flows the unchanged stream through
 * them ("後ろはまとめてずれる"). A note with several syllables gets them
 * joined by `joinSyllables` (no space, except between two Latin words).
 *
 * ## Decisions
 *
 * - Indexes are EVENT indexes (rests included), so the UI can pass the
 *   clicked event. (The parser merges consecutive chord-less rests, so
 *   indexes are only meaningful for the array they were taken from.)
 * - An operation that does not apply (index out of range, a rest, split on
 *   a note with < 2 syllables, ...) returns the input array itself (`===`),
 *   so the UI can skip `onChange`. Inputs are never mutated.
 * - Trailing lyric-less notes (after the last note with a lyric) are "open
 *   slots": when the stream shifts right they take one syllable each. A
 *   lyric-less note between lyric notes is a melisma and stays empty.
 * - Overflow: syllables that do not fit on the notes are DROPPED (no hidden
 *   overflow list). With the chart stream passed as the optional `chart`
 *   argument, `refill` then puts the missing tail back on trailing empty
 *   notes; without it, `lyricMismatch` reports the shortage.
 * - `split` applies only to notes with ≥ 2 syllables: the last syllable goes
 *   to the next note and the rest shifts right.
 * - Tuplet slots (M5) are ordinary events here: notes in a tuplet take
 *   syllables like any note, a slot turned into a rest drops its lyric, and
 *   every operation keeps the events' other fields (`tuplet`, `chord`).
 *   `replaceNote` (fill / empty a slot) and `deleteRange` (remove a group)
 *   are delete + insert in lyric terms.
 * - `lyricMismatch` compares text only. Trailing lyric-less notes after a
 *   complete stream are NOT a mismatch (a final melisma is legitimate), so
 *   auto-assigning onto too many notes is visible only in the
 *   「音符 N・音節 M」 counter, not in `firstMismatchNote`.
 */

const WORD_EDGE = /[A-Za-z0-9]/;

/** Joins syllables into one lyric string that re-splits into them. */
export function joinSyllables(syllables: readonly string[]): string {
  let out = '';
  for (const s of syllables) {
    const last = out.at(-1);
    if (last !== undefined && WORD_EDGE.test(last) && WORD_EDGE.test(s[0])) {
      out += ' ';
    }
    out += s;
  }
  return out;
}

function syllablesOf(e: MelodyEvent): string[] {
  return e.kind === 'note' ? splitSyllables(e.lyric ?? '') : [];
}

/** Syllables per event (rests and lyric-less notes 0). */
export function syllableCounts(events: readonly MelodyEvent[]): number[] {
  return events.map((e) => syllablesOf(e).length);
}

/** All notes' syllables in order. */
export function syllableStream(events: readonly MelodyEvent[]): string[] {
  return events.flatMap(syllablesOf);
}

function withLyric(e: MelodyEvent, syllables: string[]): MelodyEvent {
  const { lyric: _drop, ...rest } = e;
  if (e.kind !== 'note' || syllables.length === 0) return rest;
  return { ...rest, lyric: joinSyllables(syllables) };
}

/** Event indexes of the notes. */
function noteIndexes(events: readonly MelodyEvent[]): number[] {
  const out: number[] = [];
  events.forEach((e, i) => {
    if (e.kind === 'note') out.push(i);
  });
  return out;
}

/** Counts per NOTE, with trailing lyric-less notes counted as open slots (1). */
function noteCounts(events: readonly MelodyEvent[]): number[] {
  const counts = noteIndexes(events).map((i) => syllablesOf(events[i]).length);
  let lastLyric = -1;
  counts.forEach((c, k) => {
    if (c > 0) lastLyric = k;
  });
  return counts.map((c, k) => (k > lastLyric ? 1 : c));
}

/** Distributes `stream` over the notes by per-note `counts`. */
function reflow(
  events: readonly MelodyEvent[],
  counts: readonly number[],
  stream: readonly string[],
): MelodyEvent[] {
  let pos = 0;
  let k = 0;
  return events.map((e) => {
    if (e.kind !== 'note') return withLyric(e, []);
    const take = counts[k++] ?? 0;
    const syl = stream.slice(pos, pos + take);
    pos += take;
    return withLyric(e, syl);
  });
}

function isNoteAt(events: readonly MelodyEvent[], i: number): boolean {
  return Number.isInteger(i) && events[i]?.kind === 'note';
}

/** Note ordinal of event `i` (which must be a note). */
function ordinalOf(events: readonly MelodyEvent[], i: number): number {
  return noteIndexes(events).indexOf(i);
}

/** Re-flows with new counts, then refills from `chart` (if any). */
function apply(
  events: readonly MelodyEvent[],
  counts: number[],
  chart: readonly string[] | undefined,
  protect = -1,
): MelodyEvent[] {
  const out = reflow(events, counts, syllableStream(events));
  return chart ? refill(out, chart, protect) : out;
}

/** One syllable per note left to right (rests skipped); extras are dropped. */
export function autoAssign(
  events: readonly MelodyEvent[],
  syllables: readonly string[],
): MelodyEvent[] {
  const counts = noteIndexes(events).map(() => 1);
  return reflow(events, counts, syllables);
}

/**
 * のばす: the note after `index` gets no lyric (melisma of `index`); the
 * rest of the stream shifts right by one note. No-op without a next note.
 */
export function extend(
  events: MelodyEvent[],
  index: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!isNoteAt(events, index)) return events;
  const notes = noteIndexes(events);
  const k = notes.indexOf(index);
  if (k + 1 >= notes.length) return events;
  const counts = noteCounts(events);
  counts.splice(k + 1, 0, 0);
  counts.pop();
  return apply(events, counts, chart, notes[k + 1]);
}

/** 歌詞なし: this note's syllable(s) move to the next note; rest shifts right. */
export function noLyric(
  events: MelodyEvent[],
  index: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!isNoteAt(events, index) || syllablesOf(events[index]).length === 0) {
    return events;
  }
  const counts = noteCounts(events);
  counts.splice(ordinalOf(events, index), 0, 0);
  counts.pop();
  return apply(events, counts, chart, index);
}

/** つめる: this note also takes the next syllable; the rest shifts left. */
export function merge(
  events: MelodyEvent[],
  index: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!isNoteAt(events, index)) return events;
  const used = syllableStream(events.slice(0, index + 1)).length;
  if (used >= syllableStream(events).length) return events;
  const counts = noteIndexes(events).map((i) => syllablesOf(events[i]).length);
  counts[ordinalOf(events, index)] += 1;
  return apply(events, counts, chart);
}

/**
 * 分ける: a note with ≥ 2 syllables gives its last one to the next note;
 * the rest shifts right. No-op otherwise.
 */
export function split(
  events: MelodyEvent[],
  index: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!isNoteAt(events, index) || syllablesOf(events[index]).length < 2) {
    return events;
  }
  const counts = noteCounts(events);
  counts[ordinalOf(events, index)] -= 1;
  return apply(events, counts, chart);
}

/**
 * Inserts `event` before event `index` (0..length). A note takes the next
 * syllable of the stream and the rest shifts right (its own `lyric` is
 * ignored); a rest shifts nothing.
 */
export function insertNote(
  events: MelodyEvent[],
  index: number,
  event: MelodyEvent,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!Number.isInteger(index) || index < 0 || index > events.length) {
    return events;
  }
  const counts = noteCounts(events);
  const next = [...events.slice(0, index), event, ...events.slice(index)];
  if (event.kind === 'note') {
    const k = noteIndexes(events).filter((i) => i < index).length;
    counts.splice(k, 0, 1);
  }
  const out = reflow(next, counts, syllableStream(events));
  return chart ? refill(out, chart) : out;
}

/** Deletes event `index`; a note's syllables go back to the stream (shift left). */
export function deleteNote(
  events: MelodyEvent[],
  index: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    return events;
  }
  const counts = noteIndexes(events).map((i) => syllablesOf(events[i]).length);
  if (events[index].kind === 'note') counts.splice(ordinalOf(events, index), 1);
  const next = events.filter((_, i) => i !== index);
  const out = reflow(next, counts, syllableStream(events));
  return chart ? refill(out, chart) : out;
}

/**
 * Replaces event `index` by `event` (M5: filling or emptying a tuplet slot,
 * converting a note to a rest). Note → note keeps the old note's lyric
 * (nothing shifts); otherwise it is delete + insert: the old note's
 * syllables go back to the stream, a new note takes the next one, a rest
 * takes none. Other fields of `event` (e.g. `tuplet`, `chord`) are kept as
 * given. A bad index is a no-op.
 */
export function replaceNote(
  events: MelodyEvent[],
  index: number,
  event: MelodyEvent,
  chart?: readonly string[],
): MelodyEvent[] {
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    return events;
  }
  const old = events[index];
  if (old.kind === 'note' && event.kind === 'note') {
    const next = withLyric(event, syllablesOf(old));
    return events.map((e, i) => (i === index ? next : e));
  }
  return insertNote(deleteNote(events, index), index, event, chart);
}

/**
 * Deletes events [start, end) (M5: a whole tuplet); the notes' syllables go
 * back to the stream (shift left), like `deleteNote` for each. An empty or
 * out-of-range span is a no-op.
 */
export function deleteRange(
  events: MelodyEvent[],
  start: number,
  end: number,
  chart?: readonly string[],
): MelodyEvent[] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > events.length ||
    start >= end
  ) {
    return events;
  }
  const counts = noteIndexes(events)
    .filter((i) => i < start || i >= end)
    .map((i) => syllablesOf(events[i]).length);
  const next = [...events.slice(0, start), ...events.slice(end)];
  const out = reflow(next, counts, syllableStream(events));
  return chart ? refill(out, chart) : out;
}

/**
 * If the placed stream is a prefix of `chart`, gives the remaining chart
 * syllables, one each, to the lyric-less notes after the last lyric note
 * (and after event `protect`, e.g. a note just emptied by のばす).
 * Returns `events` itself when nothing changes.
 */
export function refill(
  events: MelodyEvent[],
  chart: readonly string[],
  protect = -1,
): MelodyEvent[] {
  const stream = syllableStream(events);
  if (stream.length >= chart.length) return events;
  if (stream.some((s, i) => s !== chart[i])) return events;
  let lastLyric = -1;
  events.forEach((e, i) => {
    if (syllablesOf(e).length > 0) lastLyric = i;
  });
  const from = Math.max(lastLyric, protect);
  let pos = stream.length;
  let changed = false;
  const out = events.map((e, i) => {
    if (i <= from || e.kind !== 'note' || pos >= chart.length) return e;
    changed = true;
    return withLyric(e, [chart[pos++]]);
  });
  return changed ? out : events;
}

export interface LyricMismatch {
  /** Syllables placed on notes. */
  placed: number;
  /** Syllables in the chart section. */
  expected: number;
  /**
   * Event index of the first note whose syllable differs from the chart
   * stream at that position (or carries one beyond its end); if the placed
   * stream is a shorter prefix, the first note after the last lyric note
   * (null when there is none). null when everything matches.
   */
  firstMismatchNote: number | null;
}

export function lyricMismatch(
  events: readonly MelodyEvent[],
  chart: readonly string[],
): LyricMismatch {
  let pos = 0;
  let lastLyric = -1;
  let first: number | null = null;
  events.forEach((e, i) => {
    const syl = syllablesOf(e);
    if (syl.length > 0) lastLyric = i;
    for (const s of syl) {
      if (first === null && s !== chart[pos]) first = i;
      pos++;
    }
  });
  if (first === null && pos < chart.length) {
    const next = events.findIndex((e, i) => i > lastLyric && e.kind === 'note');
    first = next === -1 ? null : next;
  }
  return { placed: pos, expected: chart.length, firstMismatchNote: first };
}
