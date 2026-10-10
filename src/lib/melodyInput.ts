import { barTicks, durationTicks, ticksToDuration } from './melody';
import type { Duration, MelodyEvent, TimeSig } from './melody';
import {
  deleteNote,
  deleteRange,
  insertNote,
  replaceNote,
} from './melodyLyrics';
import { mergeRests } from './melodyParse';
import {
  codeToSemitone,
  formatPitch,
  parsePitch,
  pitchToMidi,
  semitoneToPitch,
  transpose,
  transposeOctave,
} from './pitch';
import type { Pitch } from './pitch';
import {
  fillZone,
  groupAt,
  groupsFitBars,
  insertGroup,
  tupletGroups,
} from './tuplet';
import type { TupletGroup, TupletMark } from './tuplet';

/**
 * Melody editor input model (M4 task T8, docs/m4-plan.md decision 5,
 * docs/m4-decisions.md key table): keyboard → `Command`, and
 * `applyCommand(events, state, cmd, ctx)` → next `{ events, state }`.
 *
 * ## Modes
 *
 * - Input mode (`selected === null`): the cursor is an insertion point
 *   between events (0..events.length). Note / rest keys insert at the
 *   cursor with the current duration/dot; duration / dot keys only change
 *   the state (they apply to the next input). ↑↓, Shift+↑↓ and Backspace act
 *   on the event just BEFORE the cursor (↑↓ only if it is a note — a rest
 *   there is not skipped over, the key does nothing). Enter
 *   (`selectBefore`) selects the event just before the cursor (note or
 *   rest), so select mode is reachable without a mouse (M6); nothing
 *   happens at the start.
 * - Select mode (`selected` = event index, set by clicking an event or by
 *   Enter):
 *   - duration / dot keys rewrite the selected event's length (a duration
 *     key keeps the event's own dot; the dot key toggles it and is ignored
 *     on lengths that are not a single note value, e.g. merged rests) and
 *     sync `state.duration` / `state.dotted`; the lyric is untouched;
 *   - the rest key converts a selected note into a rest of the same length
 *     (chord kept). Implemented as `deleteNote` + `insertNote`, so its
 *     syllable(s) go back into the stream and flow onto the following notes
 *     ("後ろはまとめてずれる"; the tail may drop off unless `ctx.chart`
 *     refills it). A selected rest stays as is;
 *   - a note key REPLACES the selected note's pitch (duration, lyric, chord
 *     kept; Shift = +1 octave as usual). On a selected rest it turns the rest
 *     into a note of the same length (delete + insert, so the new note takes
 *     the next syllable and the rest of the lyrics shift right);
 *   - ↑↓ / Shift+↑↓ change the selected pitch (rests ignored);
 *   - ←→ move the selection (clamped to the events);
 *   - Backspace deletes the selected event and returns to input mode with
 *     the cursor where it was;
 *   - `clearSelection` (Esc / click on empty staff) returns to input mode
 *     with the cursor right after the selected event;
 *   - Enter does nothing (Esc goes back to input mode).
 *   A stale selection (index ≥ events.length) is treated as input mode with
 *   the cursor at the end.
 * - `placeAt` (mouse click on empty staff space) inserts the given pitch at
 *   the index with the current duration/dot and always leaves input mode
 *   with the cursor after the new note. The staff only sends it in input
 *   mode: while something is selected, the first click on empty space is
 *   just `clearSelection` and a second click places (M7).
 * - `setPitch` (mouse drag of the selected note, M9) sets one note's pitch
 *   (rests, invalid or out-of-range pitches are ignored); the mode and
 *   selection are unchanged.
 *
 * ## Tuplets (M5, docs/m5-plan.md 設計判断 1)
 *
 * A tuplet is n consecutive events marked `tuplet: { n, slot }` (tuplet.ts).
 * - `insertTuplet` (the TupletPicker button; no key) inserts n rests of the
 *   current note value (the dot is ignored) at the input cursor, which then
 *   sits at the group's start. In select mode it first leaves select mode
 *   like Esc (cursor after the selection). Refused inside a group, for an
 *   invalid n, or for a whole note.
 * - Fill zone (`fillZone`): with the cursor strictly inside a group, or at
 *   the start of a group whose slots are all rests, note / rest keys and
 *   `placeAt` (at such an index) REPLACE that slot (written length = the
 *   group's unit, mark and chord kept; note → note keeps the lyric, other
 *   changes re-flow lyrics as delete + insert, see `replaceNote`)
 *   and the cursor moves past it. A rest key on a rest slot only moves on.
 * - Backspace on a slot (the one before the cursor, or the selected one):
 *   a note becomes a rest (its lyric goes back to the stream); a rest moves
 *   the cursor back; once every slot is a rest the whole group is removed —
 *   also when the cursor sits at the start of an all-rest group. Select-mode
 *   Backspace does the same and leaves input mode with the cursor at the
 *   slot (or at the removed group's start). A group never loses a slot.
 * - `removeTuplet` (button) removes the group `tupletAtCursor` finds, notes
 *   included (lyrics re-flow).
 * - Duration / dot keys on a selected slot are refused.
 * - With `ctx.ts`, any edit whose result has a tuplet crossing a barline
 *   (`groupsFitBars`) is refused (docs/m5-plan.md 回答 Q2: no auto padding).
 *
 * A refused command returns the same events and state plus `message`, the
 * Japanese reason the UI shows and announces.
 *
 * ## Limits
 *
 * `baseOctave` is clamped to 3..5. Pitches stay within C3..C7 (MIDI 48..96;
 * C7 is the highest keyboard input: Shift+K at base octave 5): a transpose
 * or placement that would leave that range is ignored.
 *
 * ## Identity
 *
 * Inputs are never mutated. When the events do not change, the SAME array
 * is returned, so the caller can skip `onChange`. Commands that do nothing
 * at all also return the same state object.
 */

export interface EditorState {
  /** Insertion point 0..events.length (input mode). */
  cursor: number;
  /** Selected event index (select mode), or null (input mode). */
  selected: number | null;
  duration: Duration;
  dotted: boolean;
  /** 3..5: the octave of the A key's C. */
  baseOctave: number;
}

export type Command =
  | { type: 'noteInput'; semitone: number; octaveUp: boolean }
  | { type: 'rest' }
  | { type: 'setDuration'; d: Duration }
  | { type: 'toggleDot' }
  | { type: 'moveLeft' }
  | { type: 'moveRight' }
  | { type: 'semitoneUp' }
  | { type: 'semitoneDown' }
  | { type: 'octaveUp' }
  | { type: 'octaveDown' }
  | { type: 'baseOctaveUp' }
  | { type: 'baseOctaveDown' }
  | { type: 'deleteBackward' }
  | { type: 'select'; index: number }
  | { type: 'placeAt'; index: number; pitch: string }
  | { type: 'setPitch'; index: number; pitch: string }
  | { type: 'selectBefore' }
  | { type: 'clearSelection' }
  /** TupletPicker: insert an n-tuplet of rests at the cursor (M5). */
  | { type: 'insertTuplet'; n: number }
  /** TupletPicker 「連符を削除」: remove the group at the cursor (M5). */
  | { type: 'removeTuplet' };

export interface KeyInput {
  code: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export interface CommandContext {
  /** Song key (e.g. 'F', 'Am') for spelling black keys. */
  key?: string;
  /** Chart syllables of the section, to refill lyrics after insert/delete. */
  chart?: string[];
  /**
   * The section's time signature. When given, edits that would make a
   * tuplet cross a barline are refused (M5). Always pass it: without it the
   * result may not be serializable (`serializeMelody` throws on such groups).
   */
  ts?: TimeSig;
}

export const MIN_BASE_OCTAVE = 3;
export const MAX_BASE_OCTAVE = 5;
/** C3 */
export const MIN_MIDI = 48;
/** C7 */
export const MAX_MIDI = 96;

export function initialEditorState(
  events: readonly MelodyEvent[],
): EditorState {
  return {
    cursor: events.length,
    selected: null,
    duration: '4',
    dotted: false,
    baseOctave: 4,
  };
}

const DURATION_CODES: Record<string, Duration> = {
  Digit1: '1',
  Digit2: '2',
  Digit4: '4',
  Digit8: '8',
  Digit6: '16',
  Numpad1: '1',
  Numpad2: '2',
  Numpad4: '4',
  Numpad8: '8',
  Numpad6: '16',
};

/**
 * Maps a keydown to a command (by `e.code`, so JIS layouts and IME state do
 * not matter). Returns null for keys the editor must not take: Tab, any
 * Alt/Meta combination, Ctrl with anything but ↑↓, IME composition, keys
 * outside the table and Shift combinations not in the table.
 */
export function keyToCommand(e: KeyInput): Command | null {
  if (e.isComposing || e.key === 'Process') return null;
  if (e.altKey || e.metaKey) return null;
  if (e.ctrlKey) {
    if (e.shiftKey) return null;
    if (e.code === 'ArrowUp') return { type: 'baseOctaveUp' };
    if (e.code === 'ArrowDown') return { type: 'baseOctaveDown' };
    return null;
  }
  const semitone = codeToSemitone(e.code);
  if (semitone !== null) {
    return { type: 'noteInput', semitone, octaveUp: e.shiftKey };
  }
  if (e.code === 'ArrowUp') {
    return { type: e.shiftKey ? 'octaveUp' : 'semitoneUp' };
  }
  if (e.code === 'ArrowDown') {
    return { type: e.shiftKey ? 'octaveDown' : 'semitoneDown' };
  }
  if (e.shiftKey) return null;
  if (e.code in DURATION_CODES) {
    return { type: 'setDuration', d: DURATION_CODES[e.code] };
  }
  switch (e.code) {
    case 'ArrowLeft':
      return { type: 'moveLeft' };
    case 'ArrowRight':
      return { type: 'moveRight' };
    case 'Backspace':
      return { type: 'deleteBackward' };
    case 'Period':
    case 'NumpadDecimal':
      return { type: 'toggleDot' };
    case 'KeyR':
      return { type: 'rest' };
    case 'Enter':
    case 'NumpadEnter':
      return { type: 'selectBefore' };
    default:
      return null;
  }
}

export interface CommandResult {
  events: MelodyEvent[];
  state: EditorState;
  /**
   * Set when the command was refused (events and state are then returned
   * unchanged): the reason in Japanese, to show and announce (M5).
   */
  message?: string;
}

type Result = CommandResult;

const refuse = (
  events: MelodyEvent[],
  state: EditorState,
  message: string,
) => ({
  events,
  state,
  message,
});

const NO_TUPLET_HERE = 'カーソルの位置に連符がありません';
const TUPLET_LENGTH_FIXED = '連符の中の音価は変えられません';

/**
 * The tuplet the 「連符を削除」 button acts on (null = disable it): the
 * selected event's group in select mode; in input mode the fill-zone group
 * at the cursor (inside, or at the start of an all-rest group), else the
 * group ending right before the cursor.
 */
export function tupletAtCursor(
  events: readonly MelodyEvent[],
  state: EditorState,
): TupletGroup | null {
  const sel = state.selected;
  if (sel !== null && sel >= 0 && sel < events.length) {
    return groupAt(events, sel);
  }
  const cur =
    sel === null ? clamp(state.cursor, 0, events.length) : events.length;
  return (
    fillZone(events, cur, (i) => events[i].kind === 'rest') ??
    (cur > 0 ? groupAt(events, cur - 1) : null)
  );
}

/** A slot event: a rest or a note in place of `slot` (mark, length, chord kept). */
function slotEvent(slot: MelodyEvent, pitch?: string): MelodyEvent {
  return {
    kind: pitch === undefined ? 'rest' : 'note',
    ...(pitch !== undefined && { pitch }),
    ticks: slot.ticks,
    ...(slot.chord !== undefined && { chord: slot.chord }),
    ...(slot.tuplet && { tuplet: slot.tuplet }),
  };
}

/**
 * Fills slot `i` with a note (`pitch`) or a rest; returns the events itself
 * when a rest replaces a rest.
 */
function fillSlot(
  events: MelodyEvent[],
  i: number,
  pitch: string | undefined,
  chart: string[] | undefined,
): MelodyEvent[] {
  if (pitch === undefined && events[i].kind === 'rest') return events;
  return replaceNote(events, i, slotEvent(events[i], pitch), chart);
}

/**
 * Backspace on slot `i` of group `g`: note → rest; else remove the group
 * when all slots are rests; else nothing. `cursor` = the input cursor after.
 */
function backspaceSlot(
  events: MelodyEvent[],
  g: TupletGroup,
  i: number,
  chart: string[] | undefined,
): { events: MelodyEvent[]; cursor: number } {
  if (events[i].kind === 'note') {
    return { events: fillSlot(events, i, undefined, chart), cursor: i };
  }
  if (allRests(events, g)) {
    return {
      events: deleteRange(events, g.start, g.end, chart),
      cursor: g.start,
    };
  }
  return { events, cursor: i };
}

function allRests(events: readonly MelodyEvent[], g: TupletGroup): boolean {
  return events.slice(g.start, g.end).every((e) => e.kind === 'rest');
}

const restAt = (events: readonly MelodyEvent[]) => (i: number) =>
  events[i].kind === 'rest';

const makeRest = (ticks: number, tuplet: TupletMark): MelodyEvent => ({
  kind: 'rest',
  ticks,
  tuplet,
});

function inRange(p: Pitch): boolean {
  const m = pitchToMidi(p);
  return m >= MIN_MIDI && m <= MAX_MIDI;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Replaces event `i`, or returns `events` itself when it is unchanged. */
function replaceAt(
  events: MelodyEvent[],
  i: number,
  next: MelodyEvent,
): MelodyEvent[] {
  const cur = events[i];
  if (
    cur.kind === next.kind &&
    cur.pitch === next.pitch &&
    cur.ticks === next.ticks &&
    cur.lyric === next.lyric &&
    cur.chord === next.chord
  ) {
    return events;
  }
  return events.map((e, k) => (k === i ? next : e));
}

/** The transposed pitch string of a note, or null if not applicable. */
function movedPitch(
  e: MelodyEvent | undefined,
  cmd: Command,
  key: string | undefined,
): string | null {
  if (e?.kind !== 'note' || !e.pitch) return null;
  const p = parsePitch(e.pitch);
  if (!p) return null;
  let q: Pitch;
  switch (cmd.type) {
    case 'semitoneUp':
      q = transpose(p, 1, key);
      break;
    case 'semitoneDown':
      q = transpose(p, -1, key);
      break;
    case 'octaveUp':
      q = transposeOctave(p, 1);
      break;
    case 'octaveDown':
      q = transposeOctave(p, -1);
      break;
    default:
      return null;
  }
  return inRange(q) ? formatPitch(q) : null;
}

function inputPitch(
  state: EditorState,
  semitone: number,
  octaveUp: boolean,
  key: string | undefined,
): string | null {
  const p = semitoneToPitch(
    state.baseOctave + (octaveUp ? 1 : 0),
    semitone,
    key,
  );
  return inRange(p) ? formatPitch(p) : null;
}

/** Replaces event `i` by `event` through delete + insert (lyrics re-flow). */
function convertAt(
  events: MelodyEvent[],
  i: number,
  event: MelodyEvent,
  chart: string[] | undefined,
): MelodyEvent[] {
  return replaceNote(events, i, event, chart);
}

function withoutLyric(e: MelodyEvent): MelodyEvent {
  const { lyric: _drop, ...rest } = e;
  return rest;
}

/**
 * Applies a command; see the module comment for the semantics.
 *
 * Whenever the events change, the result is normalized with `mergeRests`
 * (the parser's rule: a chordless rest right after a rest merges into it),
 * and `cursor` / `selected` are remapped onto the merged indexes — a cursor
 * between two rests that merged ends up right after the merged rest, a
 * selection on a merged-away rest moves to the rest it merged into. So
 * `parseMelody(serializeMelody(out.events, ts), ts).events` deep-equals
 * `out.events` and the cursor/selection stay where the user sees them after
 * the section text is written and read back (M1). Tuplet slots never merge,
 * so the map is 1:1 inside groups.
 *
 * Changed events are then checked: a broken tuplet group (a bug guard) or,
 * with `ctx.ts`, a tuplet crossing a barline refuses the whole command.
 */
export function applyCommand(
  events: MelodyEvent[],
  state: EditorState,
  cmd: Command,
  ctx: CommandContext = {},
): CommandResult {
  const out = applyRaw(events, state, cmd, ctx);
  if (out.message !== undefined || out.events === events) return out;
  const reason = tupletProblem(out.events, ctx.ts);
  if (reason !== null) {
    return refuse(events, state, `この操作はできません（${reason}）`);
  }
  const { events: merged, map } = mergeRests(out.events);
  if (merged === out.events) return out;
  const { cursor, selected } = out.state;
  return {
    events: merged,
    state: {
      ...out.state,
      cursor: cursor <= 0 ? 0 : map[Math.min(cursor, map.length) - 1] + 1,
      selected: selected === null ? null : (map[selected] ?? null),
    },
  };
}

/** Why `events` cannot be written (Japanese), or null. */
function tupletProblem(
  events: readonly MelodyEvent[],
  ts: TimeSig | undefined,
): string | null {
  if (ts) {
    const fit = groupsFitBars(events, barTicks(ts));
    return fit.ok ? null : fit.error;
  }
  const groups = tupletGroups(events);
  return 'error' in groups ? groups.error : null;
}

function applyRaw(
  events: MelodyEvent[],
  state: EditorState,
  cmd: Command,
  ctx: CommandContext,
): Result {
  const same: Result = { events, state };
  const { key, chart } = ctx;

  // Mode-independent commands.
  switch (cmd.type) {
    case 'baseOctaveUp':
    case 'baseOctaveDown': {
      const baseOctave = clamp(
        state.baseOctave + (cmd.type === 'baseOctaveUp' ? 1 : -1),
        MIN_BASE_OCTAVE,
        MAX_BASE_OCTAVE,
      );
      return baseOctave === state.baseOctave
        ? same
        : { events, state: { ...state, baseOctave } };
    }
    case 'select': {
      const e = events[cmd.index];
      if (!Number.isInteger(cmd.index) || !e) return same;
      const value = ticksToDuration(e.ticks);
      return {
        events,
        state: {
          ...state,
          selected: cmd.index,
          ...(value &&
            value.d !== '32' && { duration: value.d, dotted: value.dotted }),
        },
      };
    }
    case 'setPitch': {
      const e = events[cmd.index];
      const p = parsePitch(cmd.pitch);
      if (e?.kind !== 'note' || !p || !inRange(p)) return same;
      return {
        events: replaceAt(events, cmd.index, { ...e, pitch: cmd.pitch }),
        state,
      };
    }
    case 'placeAt': {
      const p = parsePitch(cmd.pitch);
      if (
        !p ||
        !inRange(p) ||
        !Number.isInteger(cmd.index) ||
        cmd.index < 0 ||
        cmd.index > events.length
      ) {
        return same;
      }
      const zone = fillZone(events, cmd.index, restAt(events));
      if (zone) {
        return {
          events: fillSlot(events, cmd.index, cmd.pitch, chart),
          state: { ...state, selected: null, cursor: cmd.index + 1 },
        };
      }
      const ticks = durationTicks(state.duration, state.dotted);
      const note: MelodyEvent = { kind: 'note', pitch: cmd.pitch, ticks };
      return {
        events: insertNote(events, cmd.index, note, chart),
        state: { ...state, selected: null, cursor: cmd.index + 1 },
      };
    }
  }

  const sel = state.selected;
  if (sel !== null && sel >= 0 && sel < events.length) {
    if (cmd.type === 'insertTuplet') {
      // Leave select mode like Esc, then insert at the input cursor.
      const out = applyRaw(
        events,
        { ...state, selected: null, cursor: sel + 1 },
        cmd,
        ctx,
      );
      return out.message === undefined
        ? out
        : refuse(events, state, out.message);
    }
    return applySelected(events, state, sel, cmd, ctx);
  }
  // Input mode (also a stale selection).
  const s: EditorState =
    sel === null
      ? { ...state, cursor: clamp(state.cursor, 0, events.length) }
      : { ...state, selected: null, cursor: events.length };
  const stateOrSame = (next: EditorState) =>
    next.cursor === state.cursor && next.selected === state.selected
      ? state
      : next;
  const cur = s.cursor;
  const ticks = durationTicks(s.duration, s.dotted);
  const zone = fillZone(events, cur, restAt(events));

  switch (cmd.type) {
    case 'noteInput': {
      const pitch = inputPitch(s, cmd.semitone, cmd.octaveUp, key);
      if (!pitch) return same;
      return {
        events: zone
          ? fillSlot(events, cur, pitch, chart)
          : insertNote(events, cur, { kind: 'note', pitch, ticks }, chart),
        state: { ...s, cursor: cur + 1 },
      };
    }
    case 'rest':
      return {
        events: zone
          ? fillSlot(events, cur, undefined, chart)
          : insertNote(events, cur, { kind: 'rest', ticks }, chart),
        state: { ...s, cursor: cur + 1 },
      };
    case 'insertTuplet': {
      const next = insertGroup(events, cur, cmd.n, s.duration, makeRest);
      if ('error' in next) return refuse(events, state, next.error);
      return { events: next, state: s };
    }
    case 'removeTuplet': {
      const g = tupletAtCursor(events, s);
      if (!g) return refuse(events, state, NO_TUPLET_HERE);
      return {
        events: deleteRange(events, g.start, g.end, chart),
        state: { ...s, cursor: g.start },
      };
    }
    case 'setDuration':
      return { events, state: { ...s, duration: cmd.d } };
    case 'toggleDot':
      return { events, state: { ...s, dotted: !s.dotted } };
    case 'moveLeft':
      return {
        events,
        state: stateOrSame({ ...s, cursor: Math.max(0, cur - 1) }),
      };
    case 'moveRight':
      return {
        events,
        state: stateOrSame({ ...s, cursor: Math.min(events.length, cur + 1) }),
      };
    case 'semitoneUp':
    case 'semitoneDown':
    case 'octaveUp':
    case 'octaveDown': {
      const e = events[cur - 1];
      const pitch = movedPitch(e, cmd, key);
      if (!pitch) return { events, state: stateOrSame(s) };
      return {
        events: replaceAt(events, cur - 1, { ...e, pitch }),
        state: stateOrSame(s),
      };
    }
    case 'selectBefore':
      if (cur === 0) return { events, state: stateOrSame(s) };
      return applyRaw(events, s, { type: 'select', index: cur - 1 }, ctx);
    case 'deleteBackward': {
      if (zone && zone.start === cur) {
        // At the start of an all-rest group: remove it.
        return {
          events: deleteRange(events, zone.start, zone.end, chart),
          state: stateOrSame(s),
        };
      }
      if (cur === 0) return { events, state: stateOrSame(s) };
      const g = groupAt(events, cur - 1);
      if (g) {
        const out = backspaceSlot(events, g, cur - 1, chart);
        return { events: out.events, state: { ...s, cursor: out.cursor } };
      }
      return {
        events: deleteNote(events, cur - 1, chart),
        state: { ...s, cursor: cur - 1 },
      };
    }
    case 'clearSelection':
      return { events, state: stateOrSame(s) };
  }
}

function applySelected(
  events: MelodyEvent[],
  state: EditorState,
  sel: number,
  cmd: Command,
  { key, chart }: CommandContext,
): Result {
  const same: Result = { events, state };
  const e = events[sel];
  const group = groupAt(events, sel);

  switch (cmd.type) {
    case 'setDuration': {
      if (group) return refuse(events, state, TUPLET_LENGTH_FIXED);
      const dotted = ticksToDuration(e.ticks)?.dotted ?? false;
      const ticks = durationTicks(cmd.d, dotted);
      return {
        events: replaceAt(events, sel, { ...e, ticks }),
        state: { ...state, duration: cmd.d, dotted },
      };
    }
    case 'toggleDot': {
      if (group) return refuse(events, state, TUPLET_LENGTH_FIXED);
      const value = ticksToDuration(e.ticks);
      if (!value || value.d === '32') return same;
      const dotted = !value.dotted;
      return {
        events: replaceAt(events, sel, {
          ...e,
          ticks: durationTicks(value.d, dotted),
        }),
        state: { ...state, duration: value.d, dotted },
      };
    }
    case 'rest': {
      if (e.kind === 'rest') return same;
      return {
        events: convertAt(events, sel, slotEvent(e), chart),
        state,
      };
    }
    case 'noteInput': {
      const pitch = inputPitch(state, cmd.semitone, cmd.octaveUp, key);
      if (!pitch) return same;
      if (e.kind === 'note') {
        return { events: replaceAt(events, sel, { ...e, pitch }), state };
      }
      const note: MelodyEvent = { ...withoutLyric(e), kind: 'note', pitch };
      return { events: convertAt(events, sel, note, chart), state };
    }
    case 'semitoneUp':
    case 'semitoneDown':
    case 'octaveUp':
    case 'octaveDown': {
      const pitch = movedPitch(e, cmd, key);
      if (!pitch) return same;
      return { events: replaceAt(events, sel, { ...e, pitch }), state };
    }
    case 'moveLeft':
    case 'moveRight': {
      const selected = clamp(
        sel + (cmd.type === 'moveLeft' ? -1 : 1),
        0,
        events.length - 1,
      );
      return selected === sel
        ? same
        : { events, state: { ...state, selected } };
    }
    case 'deleteBackward': {
      if (group) {
        const out = backspaceSlot(events, group, sel, chart);
        return {
          events: out.events,
          state: { ...state, selected: null, cursor: out.cursor },
        };
      }
      return {
        events: deleteNote(events, sel, chart),
        state: { ...state, selected: null, cursor: sel },
      };
    }
    case 'removeTuplet': {
      if (!group) return refuse(events, state, NO_TUPLET_HERE);
      return {
        events: deleteRange(events, group.start, group.end, chart),
        state: { ...state, selected: null, cursor: group.start },
      };
    }
    case 'clearSelection':
      return { events, state: { ...state, selected: null, cursor: sel + 1 } };
    default:
      // baseOctave / select / placeAt are handled by applyCommand.
      return same;
  }
}
