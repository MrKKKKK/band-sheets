import {
  articulationOf,
  hasHit,
  isDrumRest,
  normalizeDrums,
  setArticulation,
  toggleHit,
  type Articulation,
  type DrumEvent,
  type DrumHit,
} from './drum';
import { drumKitEntryForCode, type DrumInstrument } from './drumKit';
import {
  barTicks,
  durationTicks,
  ticksToDuration,
  type Duration,
  type TimeSig,
} from './melody';
import type { KeyInput } from './melodyInput';
import {
  fillZone,
  groupAt,
  groupsFitBars,
  insertGroup,
  removeGroup,
  type TupletGroup,
} from './tuplet';

/**
 * Drum editor input model (M5 T13, docs/m5-plan.md 設計判断 1・7, 回答
 * 2026-10-04; key map: docs/m5-decisions.md): keyboard → `DrumCommand`
 * (`keyToDrumCommand`), and `applyDrumCommand(events, state, cmd, ctx)` →
 * next `{ events, state, message? }`. Mirrors melodyInput.ts so both
 * editors feel the same.
 *
 * ## Modes
 *
 * - Input mode (`selected === null`): `cursor` is an insertion point
 *   (0..events.length).
 *   - An instrument key inserts a beat of that one instrument with the
 *     current duration/dot; R inserts a rest. Inside a tuplet ("fill zone",
 *     tuplet.ts `fillZone`: start < cursor < end, or cursor at the start of
 *     an all-rest group) the key REPLACES the slot at the cursor instead
 *     (slot length and tuplet mark kept) and the cursor moves on by one.
 *   - Shift+instrument toggles that instrument on the beat just before the
 *     cursor (cursor unchanged; removing the last hit leaves a rest; no
 *     beat before → nothing).
 *   - Duration / dot keys only change the state (next input). A tuplet's
 *     slots always keep their unit.
 *   - S (ghost on/off) and A (accent: none → accent → heavy → none; a ghost
 *     counts as none) act on the beat before the cursor.
 *   - Backspace on the beat before the cursor: outside a tuplet it deletes
 *     the beat. Inside one it never deletes a slot: a struck slot becomes a
 *     rest, a rest slot is just stepped over (cursor −1), and when the
 *     group is ALL rests (the previous slot is in it, or the cursor is at
 *     the start of an all-rest group, e.g. right after inserting it) the
 *     whole group is removed. A group never loses single slots.
 *   - Enter (`selectBefore`) selects the beat before the cursor.
 * - Select mode (`selected` = beat index; click, Enter, `addAt`):
 *   - instrument key / Shift+instrument toggle that instrument on the
 *     selected beat; R makes it a rest (length/tuplet kept);
 *   - duration / dot keys change its length (duration keeps the beat's own
 *     dot; dot toggles, ignored on a 32nd) and sync the state — refused on
 *     a tuplet slot (「連符の中の音価は変えられません」);
 *   - S / A act on the selected beat; ←→ move the selection;
 *   - Backspace = the input-mode rules applied to the selected beat, then
 *     input mode with the cursor at that index (outside a tuplet the beat is
 *     deleted; a struck slot becomes a rest; an all-rest group is removed
 *     with the cursor at its start);
 *   - `clearSelection` (Esc) → input mode, cursor right after the beat.
 *   A stale selection (≥ length) is treated as input mode, cursor at end.
 * - "Last instrument" (`state.lastInst`): every instrument key, Shift+key,
 *   pad, `placeAt`, `addAt` and `select` with `inst` (notehead click) sets
 *   it. S / A apply to that instrument on the target beat; when it is not
 *   on the beat, a beat with exactly one hit uses that hit (and it becomes
 *   the last instrument); otherwise the command is refused with a message.
 *
 * ## Tuplets (TupletPicker)
 *
 * - `insertTuplet { n }` inserts n rests with the current duration as unit
 *   (the dot is ignored) at the cursor — in select mode right after the
 *   selected beat — and leaves input mode with the cursor at the group's
 *   start (so the next keys fill it). Refused inside a group, for a whole
 *   note unit, or an invalid n (reasons from `insertGroup`).
 * - `removeTuplet` removes the group `tupletForRemoval` finds; cursor at
 *   its former start, input mode.
 *
 * ## Mouse
 *
 * - `placeAt { index, inst }` (click on empty staff at an insertion index):
 *   input mode with the cursor at `index`, then exactly the instrument key
 *   (so it fills a tuplet slot when `index` is in a fill zone).
 * - `addAt { index, inst }` (click in an existing beat's column at another
 *   height, 回答 Q6): ADDS the instrument to that beat (a rest becomes a hit;
 *   already there → events unchanged) and makes that beat the "previous"
 *   one: input mode → cursor = index + 1, select mode → selected = index.
 * - `select { index, inst? }` (click on a notehead / rest): select mode on
 *   that beat, state duration synced to it (not for 32nds); `inst` (the
 *   clicked notehead) becomes the last instrument.
 *
 * ## Every edit
 *
 * When the events change, the result must keep every tuplet inside one bar
 * (`groupsFitBars`, 回答 Q2); otherwise NOTHING changes (same events and
 * state) and `message` gives the Japanese reason. Then `normalizeDrums`
 * cuts beats that cross a barline into the struck beat + rests (回答 Q5)
 * and `cursor` / `selected` are remapped (cursor c → map[c], or the new
 * length at the end), so the editor's array equals what a write + read of
 * the section text gives back.
 *
 * ## Identity
 *
 * Inputs are never mutated. Unchanged events → the SAME array (the caller
 * skips `onChange`); an unchanged state → the SAME state object. A refused
 * command returns both unchanged plus `message`.
 */

export interface DrumEditorState {
  /** Insertion point 0..events.length (input mode). */
  cursor: number;
  /** Selected beat index (select mode), or null (input mode). */
  selected: number | null;
  /** Next input's value ('32' is never set by keys). */
  duration: Duration;
  dotted: boolean;
  /** The last instrument input or clicked: the target of S / A. */
  lastInst: DrumInstrument | null;
}

export type DrumCommand =
  /** Instrument key / pad: insert, fill a slot, or toggle on the selection. */
  | { type: 'instInput'; inst: DrumInstrument }
  /** Shift+instrument key / Shift+pad: toggle on the previous (selected) beat. */
  | { type: 'toggleOnPrevious'; inst: DrumInstrument }
  | { type: 'rest' }
  | { type: 'setDuration'; d: Duration }
  | { type: 'toggleDot' }
  /** S */
  | { type: 'toggleGhost' }
  /** A: none → accent → heavy → none */
  | { type: 'cycleAccent' }
  | { type: 'moveLeft' }
  | { type: 'moveRight' }
  | { type: 'deleteBackward' }
  | { type: 'selectBefore' }
  | { type: 'clearSelection' }
  /** Click on a beat (`inst` = the clicked notehead, if any). */
  | { type: 'select'; index: number; inst?: DrumInstrument }
  /** Click on empty staff at an insertion index. */
  | { type: 'placeAt'; index: number; inst: DrumInstrument }
  /** Click in an existing beat's column at another instrument's height. */
  | { type: 'addAt'; index: number; inst: DrumInstrument }
  /** TupletPicker */
  | { type: 'insertTuplet'; n: number }
  | { type: 'removeTuplet' };

export interface DrumCommandContext {
  /** The section's effective time signature. */
  ts: TimeSig;
}

export interface DrumCommandResult {
  events: DrumEvent[];
  state: DrumEditorState;
  /** Japanese reason when the command was refused (nothing changed). */
  message?: string;
}

export function initialDrumEditorState(
  events: readonly DrumEvent[],
): DrumEditorState {
  return {
    cursor: events.length,
    selected: null,
    duration: '8',
    dotted: false,
    lastInst: null,
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
 * Maps a keydown to a command by `e.code` (JIS layouts / IME state do not
 * matter). Returns null for keys the editor must not take: Tab, any
 * Ctrl/Alt/Meta combination, IME composition, keys outside the table and
 * Shift combinations other than Shift+instrument.
 */
export function keyToDrumCommand(e: KeyInput): DrumCommand | null {
  if (e.isComposing || e.key === 'Process') return null;
  if (e.altKey || e.metaKey || e.ctrlKey) return null;
  const entry = drumKitEntryForCode(e.code);
  if (entry) {
    return {
      type: e.shiftKey ? 'toggleOnPrevious' : 'instInput',
      inst: entry.id,
    };
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
    case 'KeyS':
      return { type: 'toggleGhost' };
    case 'KeyA':
      return { type: 'cycleAccent' };
    case 'Enter':
    case 'NumpadEnter':
      return { type: 'selectBefore' };
    case 'Escape':
      return { type: 'clearSelection' };
    default:
      return null;
  }
}

/**
 * The group `removeTuplet` would remove (for TupletPicker's `canRemove`):
 * select mode → the group of the selected beat; input mode → the group of
 * the beat before the cursor, else the group starting at the cursor.
 * Throws RangeError on a broken group.
 */
export function tupletForRemoval(
  events: readonly DrumEvent[],
  state: DrumEditorState,
): TupletGroup | null {
  const sel = state.selected;
  if (sel !== null && sel >= 0 && sel < events.length) {
    return groupAt(events, sel);
  }
  const cur =
    sel === null ? clamp(state.cursor, 0, events.length) : events.length;
  return (
    (cur > 0 ? groupAt(events, cur - 1) : null) ??
    (cur < events.length ? groupAt(events, cur) : null)
  );
}

export const MESSAGES = {
  tupletValue: '連符の中の音価は変えられません',
  noPrevious: '直前に拍がありません',
  restArticulation: '休符にはゴースト・アクセントを付けられません',
  whichInstrument:
    'ゴースト・アクセントを付ける楽器が決まっていません（符頭をクリックして選んでください）',
  noTuplet: '連符の中にカーソルがありません',
} as const;

/**
 * Applies a command; see the module comment for the semantics. Throws
 * RangeError on a broken tuplet group in `events` or an unsupported time
 * signature (neither happens for events from `parseDrums`).
 */
export function applyDrumCommand(
  events: DrumEvent[],
  state: DrumEditorState,
  cmd: DrumCommand,
  ctx: DrumCommandContext,
): DrumCommandResult {
  const out = applyRaw(events, state, cmd);
  if (out.message !== undefined) return { events, state, message: out.message };
  const nextState = sameState(out.state, state) ? state : out.state;
  if (out.events === events) return { events, state: nextState };

  const fit = groupsFitBars(out.events, barTicks(ctx.ts));
  if (!fit.ok) {
    return {
      events,
      state,
      message: `${fit.error}（連符は小節線をまたげないため、この操作はできません）`,
    };
  }
  const { events: norm, map } = normalizeDrums(out.events, ctx.ts);
  if (norm === out.events) return { events: norm, state: nextState };
  const len = out.events.length;
  const { cursor, selected } = nextState;
  return {
    events: norm,
    state: {
      ...nextState,
      cursor: cursor < len ? map[cursor] : norm.length,
      selected: selected === null ? null : map[selected],
    },
  };
}

interface Raw {
  events: DrumEvent[];
  state: DrumEditorState;
  message?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sameState(a: DrumEditorState, b: DrumEditorState): boolean {
  return (
    a.cursor === b.cursor &&
    a.selected === b.selected &&
    a.duration === b.duration &&
    a.dotted === b.dotted &&
    a.lastInst === b.lastInst
  );
}

function sameHit(a: DrumHit, b: DrumHit): boolean {
  return a.inst === b.inst && a.ghost === b.ghost && a.accent === b.accent;
}

function sameEvent(a: DrumEvent, b: DrumEvent): boolean {
  return (
    a.ticks === b.ticks &&
    a.tuplet?.n === b.tuplet?.n &&
    a.tuplet?.slot === b.tuplet?.slot &&
    a.hits.length === b.hits.length &&
    a.hits.every((h, i) => sameHit(h, b.hits[i]))
  );
}

/** Replaces event `i`, or returns `events` itself when it is unchanged. */
function replaceAt(
  events: DrumEvent[],
  i: number,
  next: DrumEvent,
): DrumEvent[] {
  if (sameEvent(events[i], next)) return events;
  return events.map((e, k) => (k === i ? next : e));
}

const asRest = (ev: DrumEvent): DrumEvent => ({ ...ev, hits: [] });

function isAllRest(events: readonly DrumEvent[], g: TupletGroup): boolean {
  for (let i = g.start; i < g.end; i++) {
    if (!isDrumRest(events[i])) return false;
  }
  return true;
}

const refuse = (
  events: DrumEvent[],
  state: DrumEditorState,
  message: string,
) => ({
  events,
  state,
  message,
});

/** Input-mode instrument (or rest when `inst` is null) at `s.cursor`. */
function inputAtCursor(
  events: DrumEvent[],
  s: DrumEditorState,
  inst: DrumInstrument | null,
): Raw {
  const cur = s.cursor;
  const hits: DrumHit[] = inst ? [{ inst }] : [];
  const lastInst = inst ?? s.lastInst;
  const zone = fillZone(events, cur, (i) => isDrumRest(events[i]));
  if (zone) {
    return {
      events: replaceAt(events, cur, { ...events[cur], hits }),
      state: { ...s, cursor: cur + 1, lastInst },
    };
  }
  const beat: DrumEvent = { hits, ticks: durationTicks(s.duration, s.dotted) };
  return {
    events: [...events.slice(0, cur), beat, ...events.slice(cur)],
    state: { ...s, cursor: cur + 1, lastInst },
  };
}

/** S / A on beat `i`. */
function articulate(
  events: DrumEvent[],
  s: DrumEditorState,
  i: number,
  kind: 'ghost' | 'accent',
): Raw {
  const ev = events[i];
  if (isDrumRest(ev)) return refuse(events, s, MESSAGES.restArticulation);
  let inst: DrumInstrument;
  if (s.lastInst && hasHit(ev, s.lastInst)) inst = s.lastInst;
  else if (ev.hits.length === 1) inst = ev.hits[0].inst;
  else return refuse(events, s, MESSAGES.whichInstrument);
  const cur = articulationOf(ev.hits.find((h) => h.inst === inst)!);
  let next: Articulation;
  if (kind === 'ghost') next = cur === 'ghost' ? 'none' : 'ghost';
  else next = cur === 'accent' ? 'heavy' : cur === 'heavy' ? 'none' : 'accent';
  return {
    events: replaceAt(events, i, setArticulation(ev, inst, next)),
    state: { ...s, lastInst: inst },
  };
}

function insertTupletAt(
  events: DrumEvent[],
  s: DrumEditorState,
  at: number,
  n: number,
): Raw {
  const out = insertGroup(events, at, n, s.duration, (ticks, mark) => ({
    hits: [],
    ticks,
    tuplet: mark,
  }));
  if ('error' in out) return refuse(events, s, out.error);
  return { events: out, state: { ...s, selected: null, cursor: at } };
}

function applyRaw(
  events: DrumEvent[],
  state: DrumEditorState,
  cmd: DrumCommand,
): Raw {
  const same: Raw = { events, state };

  // Mouse commands, valid in either mode.
  switch (cmd.type) {
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
          ...(cmd.inst && hasHit(e, cmd.inst) && { lastInst: cmd.inst }),
        },
      };
    }
    case 'placeAt': {
      if (
        !Number.isInteger(cmd.index) ||
        cmd.index < 0 ||
        cmd.index > events.length
      ) {
        return same;
      }
      return inputAtCursor(
        events,
        { ...state, selected: null, cursor: cmd.index },
        cmd.inst,
      );
    }
    case 'addAt': {
      const e = events[cmd.index];
      if (!Number.isInteger(cmd.index) || !e) return same;
      const next = hasHit(e, cmd.inst)
        ? events
        : replaceAt(events, cmd.index, toggleHit(e, cmd.inst));
      const sel = state.selected;
      const selecting = sel !== null && sel >= 0 && sel < events.length;
      return {
        events: next,
        state: selecting
          ? { ...state, selected: cmd.index, lastInst: cmd.inst }
          : {
              ...state,
              selected: null,
              cursor: cmd.index + 1,
              lastInst: cmd.inst,
            },
      };
    }
  }

  const sel = state.selected;
  if (sel !== null && sel >= 0 && sel < events.length) {
    return applySelected(events, state, sel, cmd);
  }
  // Input mode (also a stale selection).
  const s: DrumEditorState =
    sel === null
      ? { ...state, cursor: clamp(state.cursor, 0, events.length) }
      : { ...state, selected: null, cursor: events.length };
  const cur = s.cursor;

  switch (cmd.type) {
    case 'instInput':
      return inputAtCursor(events, s, cmd.inst);
    case 'rest':
      return inputAtCursor(events, s, null);
    case 'toggleOnPrevious':
      if (cur === 0) return { events, state: s };
      return {
        events: replaceAt(
          events,
          cur - 1,
          toggleHit(events[cur - 1], cmd.inst),
        ),
        state: { ...s, lastInst: cmd.inst },
      };
    case 'setDuration':
      return { events, state: { ...s, duration: cmd.d } };
    case 'toggleDot':
      return { events, state: { ...s, dotted: !s.dotted } };
    case 'toggleGhost':
    case 'cycleAccent':
      if (cur === 0) return refuse(events, s, MESSAGES.noPrevious);
      return articulate(
        events,
        s,
        cur - 1,
        cmd.type === 'toggleGhost' ? 'ghost' : 'accent',
      );
    case 'moveLeft':
      return { events, state: { ...s, cursor: Math.max(0, cur - 1) } };
    case 'moveRight':
      return {
        events,
        state: { ...s, cursor: Math.min(events.length, cur + 1) },
      };
    case 'selectBefore':
      if (cur === 0) return { events, state: s };
      return applyRaw(events, s, { type: 'select', index: cur - 1 });
    case 'clearSelection':
      return { events, state: s };
    case 'deleteBackward': {
      // An all-rest group starting at the cursor (e.g. just inserted).
      const atStart = cur < events.length ? groupAt(events, cur) : null;
      if (atStart && atStart.start === cur && isAllRest(events, atStart)) {
        return { events: removeGroup(events, cur).events, state: s };
      }
      if (cur === 0) return { events, state: s };
      return backspaceAt(events, s, cur - 1);
    }
    case 'insertTuplet':
      return insertTupletAt(events, s, cur, cmd.n);
    case 'removeTuplet': {
      const g = tupletForRemoval(events, s);
      if (!g) return refuse(events, state, MESSAGES.noTuplet);
      const out = removeGroup(events, g.start);
      return { events: out.events, state: { ...s, cursor: out.start } };
    }
  }
}

/**
 * Backspace on beat `i` (input mode: the beat before the cursor; select
 * mode: the selected beat). Leaves input mode with the cursor at `i`, or at
 * the group's start when a whole group goes.
 */
function backspaceAt(events: DrumEvent[], s: DrumEditorState, i: number): Raw {
  const state = { ...s, selected: null, cursor: i };
  const g = groupAt(events, i);
  if (!g) {
    return {
      events: [...events.slice(0, i), ...events.slice(i + 1)],
      state,
    };
  }
  if (isAllRest(events, g)) {
    const out = removeGroup(events, i);
    return { events: out.events, state: { ...state, cursor: out.start } };
  }
  return { events: replaceAt(events, i, asRest(events[i])), state };
}

function applySelected(
  events: DrumEvent[],
  state: DrumEditorState,
  sel: number,
  cmd: DrumCommand,
): Raw {
  const same: Raw = { events, state };
  const e = events[sel];

  switch (cmd.type) {
    case 'instInput':
    case 'toggleOnPrevious':
      return {
        events: replaceAt(events, sel, toggleHit(e, cmd.inst)),
        state: { ...state, lastInst: cmd.inst },
      };
    case 'rest':
      return { events: replaceAt(events, sel, asRest(e)), state };
    case 'setDuration': {
      if (e.tuplet) return refuse(events, state, MESSAGES.tupletValue);
      const dotted = ticksToDuration(e.ticks)?.dotted ?? false;
      return {
        events: replaceAt(events, sel, {
          ...e,
          ticks: durationTicks(cmd.d, dotted),
        }),
        state: { ...state, duration: cmd.d, dotted },
      };
    }
    case 'toggleDot': {
      if (e.tuplet) return refuse(events, state, MESSAGES.tupletValue);
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
    case 'toggleGhost':
    case 'cycleAccent':
      return articulate(
        events,
        state,
        sel,
        cmd.type === 'toggleGhost' ? 'ghost' : 'accent',
      );
    case 'moveLeft':
    case 'moveRight': {
      const selected = clamp(
        sel + (cmd.type === 'moveLeft' ? -1 : 1),
        0,
        events.length - 1,
      );
      return { events, state: { ...state, selected } };
    }
    case 'deleteBackward':
      return backspaceAt(events, state, sel);
    case 'clearSelection':
      return { events, state: { ...state, selected: null, cursor: sel + 1 } };
    case 'insertTuplet':
      return insertTupletAt(events, state, sel + 1, cmd.n);
    case 'removeTuplet': {
      const g = groupAt(events, sel);
      if (!g) return refuse(events, state, MESSAGES.noTuplet);
      const out = removeGroup(events, sel);
      return {
        events: out.events,
        state: { ...state, selected: null, cursor: out.start },
      };
    }
    default:
      // selectBefore does nothing in select mode (Esc returns to input).
      return same;
  }
}
