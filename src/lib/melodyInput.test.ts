import { describe, expect, it } from 'vitest';
import type { MelodyEvent } from './melody';
import {
  applyCommand,
  initialEditorState,
  keyToCommand,
  tupletAtCursor,
} from './melodyInput';
import type { Command, EditorState, KeyInput } from './melodyInput';
import { parseMelody } from './melodyParse';
import { serializeMelody } from './melodyTex';

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  code,
  key: '',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const n = (pitch: string, lyric?: string, ticks = 16): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
  ...(lyric !== undefined && { lyric }),
});
const r = (ticks = 16): MelodyEvent => ({ kind: 'rest', ticks });

const st = (over: Partial<EditorState> = {}): EditorState => ({
  cursor: 0,
  selected: null,
  duration: '4',
  dotted: false,
  baseOctave: 4,
  ...over,
});

const lyrics = (events: MelodyEvent[]) => events.map((e) => e.lyric ?? '');
const pitches = (events: MelodyEvent[]) => events.map((e) => e.pitch ?? 'r');

const run = (
  events: MelodyEvent[],
  state: EditorState,
  cmd: Command,
  ctx = {},
) => applyCommand(events, state, cmd, ctx);

describe('keyToCommand', () => {
  const notes: [string, number][] = [
    ['KeyA', 0],
    ['KeyW', 1],
    ['KeyS', 2],
    ['KeyE', 3],
    ['KeyD', 4],
    ['KeyF', 5],
    ['KeyT', 6],
    ['KeyG', 7],
    ['KeyY', 8],
    ['KeyH', 9],
    ['KeyU', 10],
    ['KeyJ', 11],
    ['KeyK', 12],
  ];
  it.each(notes)('%s → noteInput %i', (code, semitone) => {
    expect(keyToCommand(key(code))).toEqual({
      type: 'noteInput',
      semitone,
      octaveUp: false,
    });
    expect(keyToCommand(key(code, { shiftKey: true }))).toEqual({
      type: 'noteInput',
      semitone,
      octaveUp: true,
    });
  });

  it('uses e.code, not e.key (JIS / IME layouts)', () => {
    expect(keyToCommand(key('KeyA', { key: 'ち' }))).toEqual({
      type: 'noteInput',
      semitone: 0,
      octaveUp: false,
    });
  });

  it.each([
    ['Digit1', '1'],
    ['Digit2', '2'],
    ['Digit4', '4'],
    ['Digit8', '8'],
    ['Digit6', '16'],
    ['Numpad1', '1'],
    ['Numpad2', '2'],
    ['Numpad4', '4'],
    ['Numpad8', '8'],
    ['Numpad6', '16'],
  ])('%s → setDuration %s', (code, d) => {
    expect(keyToCommand(key(code))).toEqual({ type: 'setDuration', d });
  });

  it.each([
    ['ArrowUp', {}, 'semitoneUp'],
    ['ArrowDown', {}, 'semitoneDown'],
    ['ArrowUp', { shiftKey: true }, 'octaveUp'],
    ['ArrowDown', { shiftKey: true }, 'octaveDown'],
    ['ArrowUp', { ctrlKey: true }, 'baseOctaveUp'],
    ['ArrowDown', { ctrlKey: true }, 'baseOctaveDown'],
    ['ArrowLeft', {}, 'moveLeft'],
    ['ArrowRight', {}, 'moveRight'],
    ['Backspace', {}, 'deleteBackward'],
    ['Period', {}, 'toggleDot'],
    ['NumpadDecimal', {}, 'toggleDot'],
    ['KeyR', {}, 'rest'],
  ] as const)('%s %o → %s', (code, mods, type) => {
    expect(keyToCommand(key(code, mods))).toEqual({ type });
  });

  it.each([
    ['Tab', {}],
    ['Tab', { shiftKey: true }],
    ['KeyC', { ctrlKey: true }],
    ['KeyZ', { ctrlKey: true }],
    ['KeyA', { ctrlKey: true }],
    ['KeyF', { altKey: true }],
    ['KeyA', { metaKey: true }],
    ['Digit4', { ctrlKey: true }],
    ['Digit1', { altKey: true }],
    ['ArrowUp', { altKey: true }],
    ['ArrowUp', { metaKey: true }],
    ['ArrowUp', { ctrlKey: true, shiftKey: true }],
    ['KeyA', { isComposing: true }],
    ['KeyA', { key: 'Process' }],
    ['Digit3', {}],
    ['KeyQ', {}],
    ['Space', {}],
    ['Escape', {}],
    ['Digit8', { shiftKey: true }],
  ] as const)('%s %o → null', (code, mods) => {
    expect(keyToCommand(key(code, mods))).toBeNull();
  });

  it('Enter / NumpadEnter → selectBefore (M6); with modifiers → null', () => {
    expect(keyToCommand(key('Enter'))).toEqual({ type: 'selectBefore' });
    expect(keyToCommand(key('NumpadEnter'))).toEqual({
      type: 'selectBefore',
    });
    expect(keyToCommand(key('Enter', { shiftKey: true }))).toBeNull();
    expect(keyToCommand(key('Enter', { ctrlKey: true }))).toBeNull();
    expect(keyToCommand(key('Enter', { isComposing: true }))).toBeNull();
  });
});

describe('applyCommand — selectBefore (M6) / setPitch (M9)', () => {
  const ev = [n('C4'), r(8), n('E4', undefined, 24)];

  it('selects the event before the cursor and syncs the duration', () => {
    const out = applyCommand(ev, st({ cursor: 3 }), { type: 'selectBefore' });
    expect(out.events).toBe(ev);
    expect(out.state).toMatchObject({
      selected: 2,
      duration: '4',
      dotted: true,
    });
    // A rest can be selected too.
    expect(
      applyCommand(ev, st({ cursor: 2 }), { type: 'selectBefore' }).state
        .selected,
    ).toBe(1);
  });

  it('does nothing at the start or while something is selected', () => {
    const s0 = st({ cursor: 0 });
    expect(applyCommand(ev, s0, { type: 'selectBefore' }).state).toBe(s0);
    const s1 = st({ cursor: 3, selected: 0 });
    expect(applyCommand(ev, s1, { type: 'selectBefore' }).state).toBe(s1);
  });

  it('setPitch replaces a note pitch, keeps the selection', () => {
    const s = st({ cursor: 3, selected: 0 });
    const out = applyCommand([n('C4', 'き'), ...ev.slice(1)], s, {
      type: 'setPitch',
      index: 0,
      pitch: 'G4',
    });
    expect(out.events[0]).toEqual(n('G4', 'き'));
    expect(out.state).toBe(s);
  });

  it('setPitch ignores rests, invalid / out-of-range pitches and same pitch', () => {
    const s = st({ cursor: 3 });
    for (const cmd of [
      { type: 'setPitch', index: 1, pitch: 'G4' },
      { type: 'setPitch', index: 0, pitch: 'X9' },
      { type: 'setPitch', index: 0, pitch: 'B2' },
      { type: 'setPitch', index: 0, pitch: 'C4' },
      { type: 'setPitch', index: 7, pitch: 'C4' },
    ] as const) {
      expect(applyCommand(ev, s, cmd).events).toBe(ev);
    }
  });
});

describe('initialEditorState', () => {
  it('puts the cursor at the end in input mode, quarter, octave 4', () => {
    expect(initialEditorState([n('C4'), n('D4')])).toEqual({
      cursor: 2,
      selected: null,
      duration: '4',
      dotted: false,
      baseOctave: 4,
    });
    expect(initialEditorState([]).cursor).toBe(0);
  });
});

describe('applyCommand — input mode', () => {
  it('noteInput inserts a note at the cursor with the current value', () => {
    const ev = [n('C4'), n('D4')];
    const out = run(ev, st({ cursor: 1, duration: '8', dotted: true }), {
      type: 'noteInput',
      semitone: 7,
      octaveUp: false,
    });
    expect(out.events).toEqual([n('C4'), n('G4', undefined, 12), n('D4')]);
    expect(out.state.cursor).toBe(2);
    expect(ev).toHaveLength(2); // not mutated
  });

  it('noteInput uses the base octave, +1 with octaveUp, K = next C', () => {
    const s = st({ baseOctave: 3 });
    expect(
      run([], s, { type: 'noteInput', semitone: 12, octaveUp: false }).events[0]
        .pitch,
    ).toBe('C4');
    expect(
      run([], s, { type: 'noteInput', semitone: 4, octaveUp: true }).events[0]
        .pitch,
    ).toBe('E4');
    expect(
      run([], st({ baseOctave: 5 }), {
        type: 'noteInput',
        semitone: 12,
        octaveUp: true,
      }).events[0].pitch,
    ).toBe('C7');
  });

  it('spells black keys per ctx.key: F → Bb, G → F#, none → sharps', () => {
    const cmd = (semitone: number): Command => ({
      type: 'noteInput',
      semitone,
      octaveUp: false,
    });
    expect(run([], st(), cmd(10), { key: 'F' }).events[0].pitch).toBe('Bb4');
    expect(run([], st(), cmd(6), { key: 'G' }).events[0].pitch).toBe('F#4');
    expect(run([], st(), cmd(10)).events[0].pitch).toBe('A#4');
  });

  it('rest inserts a rest with the current value', () => {
    const out = run([n('C4')], st({ cursor: 1, duration: '2' }), {
      type: 'rest',
    });
    expect(out.events).toEqual([n('C4'), r(32)]);
    expect(out.state.cursor).toBe(2);
  });

  it('inserting a note shifts lyrics right; a rest shifts nothing', () => {
    const ev = [n('C4', 'き'), n('D4', 'ら'), n('E4', 'ほ')];
    const s = st({ cursor: 1 });
    const out = run(ev, s, { type: 'noteInput', semitone: 0, octaveUp: false });
    expect(lyrics(out.events)).toEqual(['き', 'ら', 'ほ', '']);
    const rest = run(ev, s, { type: 'rest' });
    expect(lyrics(rest.events)).toEqual(['き', '', 'ら', 'ほ']);
  });

  it('refills from ctx.chart after an insert', () => {
    const ev = [n('C4', 'き'), n('D4', 'ら')];
    const out = run(
      ev,
      st({ cursor: 2 }),
      { type: 'noteInput', semitone: 0, octaveUp: false },
      { chart: ['き', 'ら', 'ほ'] },
    );
    expect(lyrics(out.events)).toEqual(['き', 'ら', 'ほ']);
  });

  it('setDuration / toggleDot change only the state', () => {
    const ev = [n('C4')];
    const a = run(ev, st({ cursor: 1 }), { type: 'setDuration', d: '8' });
    expect(a.events).toBe(ev);
    expect(a.state.duration).toBe('8');
    const b = run(ev, a.state, { type: 'toggleDot' });
    expect(b.events).toBe(ev);
    expect(b.state.dotted).toBe(true);
    expect(run(ev, b.state, { type: 'toggleDot' }).state.dotted).toBe(false);
  });

  it('moveLeft / moveRight move the cursor, clamped', () => {
    const ev = [n('C4'), n('D4')];
    expect(run(ev, st({ cursor: 1 }), { type: 'moveLeft' }).state.cursor).toBe(
      0,
    );
    expect(run(ev, st({ cursor: 0 }), { type: 'moveLeft' }).state.cursor).toBe(
      0,
    );
    expect(run(ev, st({ cursor: 1 }), { type: 'moveRight' }).state.cursor).toBe(
      2,
    );
    const end = run(ev, st({ cursor: 2 }), { type: 'moveRight' });
    expect(end.state.cursor).toBe(2);
    expect(end.events).toBe(ev);
  });

  it('↑/↓ transpose the note before the cursor, spelled per key', () => {
    const ev = [n('A4', 'き'), n('C4')];
    const up = run(ev, st({ cursor: 1 }), { type: 'semitoneUp' }, { key: 'F' });
    expect(pitches(up.events)).toEqual(['Bb4', 'C4']);
    expect(up.events[0].lyric).toBe('き');
    const down = run(ev, st({ cursor: 1 }), { type: 'semitoneDown' });
    expect(pitches(down.events)).toEqual(['G#4', 'C4']);
  });

  it('Shift+↑/↓ move the note before the cursor by an octave', () => {
    const ev = [n('Bb4')];
    expect(
      pitches(run(ev, st({ cursor: 1 }), { type: 'octaveUp' }).events),
    ).toEqual(['Bb5']);
    expect(
      pitches(run(ev, st({ cursor: 1 }), { type: 'octaveDown' }).events),
    ).toEqual(['Bb3']);
  });

  it('↑/↓ with no note before the cursor (start, or a rest) do nothing', () => {
    const ev = [n('C4'), r()];
    expect(run(ev, st({ cursor: 0 }), { type: 'semitoneUp' }).events).toBe(ev);
    expect(run(ev, st({ cursor: 2 }), { type: 'octaveUp' }).events).toBe(ev);
  });

  it('pitch moves beyond C3..C7 are ignored', () => {
    expect(
      run([n('C3')], st({ cursor: 1 }), { type: 'semitoneDown' }).events,
    ).toEqual([n('C3')]);
    const low = [n('B3')];
    expect(run(low, st({ cursor: 1 }), { type: 'octaveDown' }).events).toBe(
      low,
    );
    const high = [n('C7')];
    expect(run(high, st({ cursor: 1 }), { type: 'semitoneUp' }).events).toBe(
      high,
    );
    const g6 = [n('G6')];
    expect(run(g6, st({ cursor: 1 }), { type: 'octaveUp' }).events).toBe(g6);
  });

  it('Backspace deletes the event before the cursor; lyrics shift left', () => {
    const ev = [n('C4', 'き'), n('D4', 'ら'), n('E4', 'ほ')];
    const out = run(ev, st({ cursor: 1 }), { type: 'deleteBackward' });
    expect(pitches(out.events)).toEqual(['D4', 'E4']);
    expect(lyrics(out.events)).toEqual(['き', 'ら']);
    expect(out.state.cursor).toBe(0);
    const none = run(ev, st({ cursor: 0 }), { type: 'deleteBackward' });
    expect(none.events).toBe(ev);
    expect(none.state.cursor).toBe(0);
  });

  it('Backspace also deletes a rest before the cursor', () => {
    const out = run([n('C4'), r()], st({ cursor: 2 }), {
      type: 'deleteBackward',
    });
    expect(out.events).toEqual([n('C4')]);
    expect(out.state.cursor).toBe(1);
  });

  it('baseOctave is clamped to 3..5', () => {
    const ev: MelodyEvent[] = [];
    expect(
      run(ev, st({ baseOctave: 4 }), { type: 'baseOctaveUp' }).state.baseOctave,
    ).toBe(5);
    expect(
      run(ev, st({ baseOctave: 5 }), { type: 'baseOctaveUp' }).state.baseOctave,
    ).toBe(5);
    expect(
      run(ev, st({ baseOctave: 3 }), { type: 'baseOctaveDown' }).state
        .baseOctave,
    ).toBe(3);
    expect(
      run(ev, st({ baseOctave: 3 }), { type: 'baseOctaveUp' }).events,
    ).toBe(ev);
  });

  it('clearSelection in input mode changes nothing', () => {
    const ev = [n('C4')];
    const s = st({ cursor: 1 });
    const out = run(ev, s, { type: 'clearSelection' });
    expect(out.events).toBe(ev);
    expect(out.state).toEqual(s);
  });
});

describe('applyCommand — select / placeAt', () => {
  const ev = () => [n('C4', 'き'), n('D4', 'ら'), n('E4', 'ほ')];

  it('select enters select mode and syncs the duration palette', () => {
    const e = [n('C4'), n('D4', undefined, 12)];
    const out = run(e, st(), { type: 'select', index: 1 });
    expect(out.events).toBe(e);
    expect(out.state).toMatchObject({
      selected: 1,
      duration: '8',
      dotted: true,
    });
  });

  it('select with an out-of-range index is ignored', () => {
    const s = st();
    expect(run(ev(), s, { type: 'select', index: 3 }).state).toEqual(s);
    expect(run(ev(), s, { type: 'select', index: -1 }).state).toEqual(s);
  });

  it('setDuration rewrites the selected event, keeping its dot and lyric', () => {
    const e = [n('C4', 'き', 24), n('D4')];
    const out = run(e, st({ selected: 0, dotted: true }), {
      type: 'setDuration',
      d: '8',
    });
    expect(out.events[0]).toEqual(n('C4', 'き', 12));
    expect(out.events[1]).toBe(e[1]);
    expect(out.state).toMatchObject({ selected: 0, duration: '8' });
  });

  it('setDuration to the same value returns the same array', () => {
    const e = ev();
    expect(
      run(e, st({ selected: 0 }), { type: 'setDuration', d: '4' }).events,
    ).toBe(e);
  });

  it('toggleDot toggles the selected event dot', () => {
    const e = [n('C4'), r(8)];
    const a = run(e, st({ selected: 1 }), { type: 'toggleDot' });
    expect(a.events[1]).toEqual(r(12));
    expect(a.state.dotted).toBe(true);
    const b = run(a.events, a.state, { type: 'toggleDot' });
    expect(b.events[1]).toEqual(r(8));
  });

  it('toggleDot on a non-single-value event (merged rests) is ignored', () => {
    const e = [r(40)];
    expect(run(e, st({ selected: 0 }), { type: 'toggleDot' }).events).toBe(e);
  });

  it('rest converts the selected note; its lyric flows to the next notes', () => {
    const e = [{ ...n('C4', 'き'), chord: 'C' }, n('D4', 'ら'), n('E4', 'ほ')];
    const out = run(e, st({ selected: 0 }), { type: 'rest' });
    expect(out.events[0]).toEqual({ kind: 'rest', ticks: 16, chord: 'C' });
    expect(lyrics(out.events)).toEqual(['', 'き', 'ら']);
    expect(out.state.selected).toBe(0);
  });

  it('rest on a selected rest does nothing', () => {
    const e = [r(), n('C4')];
    expect(run(e, st({ selected: 0 }), { type: 'rest' }).events).toBe(e);
  });

  it('noteInput replaces the selected note pitch, keeping duration/lyric', () => {
    const e = [n('C4', 'き', 8), n('D4', 'ら')];
    const out = run(
      e,
      st({ selected: 0, baseOctave: 4 }),
      { type: 'noteInput', semitone: 10, octaveUp: true },
      { key: 'F' },
    );
    expect(out.events[0]).toEqual(n('Bb5', 'き', 8));
    expect(out.state.selected).toBe(0);
  });

  it('noteInput on a selected rest turns it into a note taking a syllable', () => {
    const e = [n('C4', 'き'), { ...r(8), chord: 'G' }, n('D4', 'ら')];
    const out = run(e, st({ selected: 1 }), {
      type: 'noteInput',
      semitone: 4,
      octaveUp: false,
    });
    expect(out.events[1]).toEqual({
      kind: 'note',
      pitch: 'E4',
      ticks: 8,
      lyric: 'ら',
      chord: 'G',
    });
    expect(lyrics(out.events)).toEqual(['き', 'ら', '']);
  });

  it('↑/↓/Shift change the selected pitch; rests are ignored', () => {
    const e = [n('E4', 'き'), r()];
    expect(
      pitches(run(e, st({ selected: 0 }), { type: 'semitoneUp' }).events),
    ).toEqual(['F4', 'r']);
    expect(
      pitches(run(e, st({ selected: 0 }), { type: 'octaveDown' }).events),
    ).toEqual(['E3', 'r']);
    expect(run(e, st({ selected: 1 }), { type: 'semitoneUp' }).events).toBe(e);
  });

  it('←/→ move the selection, clamped', () => {
    const e = ev();
    expect(
      run(e, st({ selected: 1 }), { type: 'moveLeft' }).state.selected,
    ).toBe(0);
    expect(
      run(e, st({ selected: 0 }), { type: 'moveLeft' }).state.selected,
    ).toBe(0);
    expect(
      run(e, st({ selected: 2 }), { type: 'moveRight' }).state.selected,
    ).toBe(2);
    expect(
      run(e, st({ selected: 1 }), { type: 'moveRight' }).state.selected,
    ).toBe(2);
  });

  it('Backspace deletes the selected event and returns to input mode', () => {
    const out = run(ev(), st({ selected: 1 }), { type: 'deleteBackward' });
    expect(pitches(out.events)).toEqual(['C4', 'E4']);
    expect(lyrics(out.events)).toEqual(['き', 'ら']);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('clearSelection returns to input mode with the cursor after it', () => {
    const e = ev();
    const out = run(e, st({ selected: 1 }), { type: 'clearSelection' });
    expect(out.events).toBe(e);
    expect(out.state).toMatchObject({ selected: null, cursor: 2 });
  });

  it('baseOctave keys work in select mode too (state only)', () => {
    const e = ev();
    const out = run(e, st({ selected: 0 }), { type: 'baseOctaveDown' });
    expect(out.events).toBe(e);
    expect(out.state).toMatchObject({ selected: 0, baseOctave: 3 });
  });

  it('placeAt inserts the pitch at index with the current value', () => {
    const e = ev();
    const out = run(e, st({ selected: 2, duration: '8' }), {
      type: 'placeAt',
      index: 1,
      pitch: 'F#4',
    });
    expect(pitches(out.events)).toEqual(['C4', 'F#4', 'D4', 'E4']);
    expect(out.events[1].ticks).toBe(8);
    expect(lyrics(out.events)).toEqual(['き', 'ら', 'ほ', '']);
    expect(out.state).toMatchObject({ selected: null, cursor: 2 });
  });

  it('placeAt with an invalid pitch, out-of-range pitch or index is ignored', () => {
    const e = ev();
    const s = st({ cursor: 3 });
    for (const cmd of [
      { type: 'placeAt', index: 0, pitch: 'H4' },
      { type: 'placeAt', index: 0, pitch: 'C2' },
      { type: 'placeAt', index: 4, pitch: 'C4' },
    ] as const) {
      const out = run(e, s, cmd);
      expect(out.events).toBe(e);
      expect(out.state).toBe(s);
    }
  });

  it('a stale selection index (beyond events) falls back to input mode', () => {
    const e = [n('C4')];
    const out = run(e, st({ selected: 5 }), { type: 'rest' });
    expect(out.events).toEqual([n('C4'), r()]);
    expect(out.state).toMatchObject({ selected: null, cursor: 2 });
  });
});

describe('applyCommand — rests are merged like a round trip (M1)', () => {
  const FOUR = { num: 4, den: 4 };
  const roundTrip = (events: MelodyEvent[]) => {
    const res = parseMelody(serializeMelody(events, FOUR), FOUR);
    if (!res.ok) throw new Error(res.reason);
    return res.events;
  };
  const press = (
    events: MelodyEvent[],
    state: EditorState,
    ...cmds: Command[]
  ) => {
    let out = { events, state };
    for (const cmd of cmds) out = applyCommand(out.events, out.state, cmd);
    return out;
  };

  it('R after a rest merges; the next note lands right after the rests', () => {
    // `:4 C4 r E4 F4`, cursor after the rest, press R then A.
    const e = [n('C4'), r(), n('E4'), n('F4')];
    const out = press(
      e,
      st({ cursor: 2 }),
      { type: 'rest' },
      { type: 'noteInput', semitone: 0, octaveUp: false },
    );
    expect(pitches(out.events)).toEqual(['C4', 'r', 'C4', 'E4', 'F4']);
    expect(out.events[1].ticks).toBe(32);
    expect(out.state.cursor).toBe(3);
    expect(roundTrip(out.events)).toEqual(out.events);
  });

  it('a note turned into a rest next to a rest keeps the selection on it', () => {
    const e = [r(), n('C4'), n('E4')];
    const out = press(e, st({ selected: 1 }), { type: 'rest' });
    expect(out.events).toEqual([r(32), n('E4')]);
    expect(out.state.selected).toBe(0);
  });

  it('a following chordless rest merges into the converted note', () => {
    const e = [n('C4'), r(), n('E4')];
    const out = press(e, st({ selected: 0 }), { type: 'rest' });
    expect(out.events).toEqual([r(32), n('E4')]);
    expect(out.state.selected).toBe(0);
  });

  it('deleting a note between two rests merges them; cursor after them', () => {
    const e = [r(), n('C4'), r(), n('E4')];
    const out = press(e, st({ cursor: 2 }), { type: 'deleteBackward' });
    expect(out.events).toEqual([r(32), n('E4')]);
    expect(out.state.cursor).toBe(1);
  });

  it('property: output always equals its own round trip; cursor/selection in range', () => {
    const CMDS: Command[] = [
      { type: 'noteInput', semitone: 0, octaveUp: false },
      { type: 'noteInput', semitone: 4, octaveUp: true },
      { type: 'rest' },
      { type: 'rest' },
      { type: 'setDuration', d: '8' },
      { type: 'setDuration', d: '2' },
      { type: 'setDuration', d: '16' },
      { type: 'toggleDot' },
      { type: 'moveLeft' },
      { type: 'moveRight' },
      { type: 'semitoneUp' },
      { type: 'octaveDown' },
      { type: 'deleteBackward' },
      { type: 'clearSelection' },
      { type: 'insertTuplet', n: 3 },
      { type: 'insertTuplet', n: 5 },
      { type: 'removeTuplet' },
    ];
    const chart = ['あ', 'い', 'う', 'え', 'お', 'か', 'き'];
    let seed = 20261004;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 200; run++) {
      let events: MelodyEvent[] = [];
      let state = initialEditorState(events);
      const log: string[] = [];
      for (let step = 0; step < 30; step++) {
        const k = Math.floor(rand() * (CMDS.length + 2));
        let cmd: Command;
        if (k === CMDS.length) {
          cmd = {
            type: 'select',
            index: Math.floor(rand() * (events.length + 1)),
          };
        } else if (k === CMDS.length + 1) {
          cmd = {
            type: 'placeAt',
            index: Math.floor(rand() * (events.length + 1)),
            pitch: 'G4',
          };
        } else {
          cmd = CMDS[k];
        }
        log.push(JSON.stringify(cmd));
        ({ events, state } = applyCommand(events, state, cmd, {
          chart,
          ts: FOUR,
        }));
        const msg = `run ${run}: ${log.join(' ')}`;
        expect(roundTrip(events), msg).toEqual(events);
        expect(state.cursor, msg).toBeLessThanOrEqual(events.length);
        expect(state.cursor, msg).toBeGreaterThanOrEqual(0);
        if (state.selected !== null) {
          expect(state.selected, msg).toBeLessThan(events.length);
        }
      }
    }
  });
});

describe('applyCommand — tuplets (M5)', () => {
  const FOUR = { num: 4, den: 4 };
  /** Tuplet slot: a rest (pitch undefined) or a note, 8th by default. */
  const tr = (slot: number, count = 3, ticks = 8): MelodyEvent => ({
    kind: 'rest',
    ticks,
    tuplet: { n: count, slot },
  });
  const tn = (
    pitch: string,
    slot: number,
    lyric?: string,
    count = 3,
    ticks = 8,
  ): MelodyEvent => ({ ...n(pitch, lyric, ticks), tuplet: { n: count, slot } });
  const A: Command = { type: 'noteInput', semitone: 0, octaveUp: false };
  const D: Command = { type: 'noteInput', semitone: 2, octaveUp: false };
  const E: Command = { type: 'noteInput', semitone: 4, octaveUp: false };
  const R: Command = { type: 'rest' };
  const BS: Command = { type: 'deleteBackward' };
  const press = (
    events: MelodyEvent[],
    state: EditorState,
    ctx: Parameters<typeof applyCommand>[3],
    ...cmds: Command[]
  ) => {
    let out: ReturnType<typeof applyCommand> = { events, state };
    for (const cmd of cmds) out = applyCommand(out.events, out.state, cmd, ctx);
    return out;
  };
  const roundTrip = (events: MelodyEvent[]) => {
    const res = parseMelody(serializeMelody(events, FOUR), FOUR);
    if (!res.ok) throw new Error(res.reason);
    return res.events;
  };

  describe('insertTuplet', () => {
    it('inserts n rests of the current (undotted) value at the cursor; cursor at its start', () => {
      const ev = [n('C4'), n('D4')];
      const s = st({ cursor: 1, duration: '8', dotted: true });
      const out = run(ev, s, { type: 'insertTuplet', n: 3 }, { ts: FOUR });
      expect(out.events).toEqual([n('C4'), tr(0), tr(1), tr(2), n('D4')]);
      expect(out.state).toEqual({ ...s, cursor: 1 });
      expect(out.message).toBeUndefined();
      expect(roundTrip(out.events)).toEqual(out.events);
    });

    it('does not merge with neighbouring rests', () => {
      const out = run([r()], st({ cursor: 1, duration: '8' }), {
        type: 'insertTuplet',
        n: 3,
      });
      expect(out.events).toEqual([r(), tr(0), tr(1), tr(2)]);
      expect(out.state.cursor).toBe(1);
      expect(roundTrip(out.events)).toEqual(out.events);
    });

    it('refuses with a reason: whole notes, invalid n, inside a group', () => {
      const ev = [n('C4')];
      const s = st({ cursor: 1, duration: '1' });
      const whole = run(ev, s, { type: 'insertTuplet', n: 3 });
      expect(whole.events).toBe(ev);
      expect(whole.state).toBe(s);
      expect(whole.message).toBe('連符の単位は 2分〜32分の音符だけです');

      const four = run(ev, st({ cursor: 1 }), { type: 'insertTuplet', n: 4 });
      expect(four.events).toBe(ev);
      expect(four.message).toMatch(/4 連符は作れません/);

      const g = [tn('C4', 0), tr(1), tr(2)];
      const inside = run(g, st({ cursor: 2, duration: '8' }), {
        type: 'insertTuplet',
        n: 3,
      });
      expect(inside.events).toBe(g);
      expect(inside.message).toBe('連符の中に連符は入れられません');
    });

    it('refuses a tuplet that would cross a barline (with ts)', () => {
      const ev = [n('C4', undefined, 48)];
      const s = st({ cursor: 1, duration: '4' });
      const out = run(ev, s, { type: 'insertTuplet', n: 3 }, { ts: FOUR });
      expect(out.events).toBe(ev);
      expect(out.state).toBe(s);
      expect(out.message).toMatch(/小節線をまたぎ/);
      expect(out.message).toMatch(/できません/);
      // A quarter-note triplet fits after a half note.
      const ok = run(
        [n('C4', undefined, 32)],
        s,
        { type: 'insertTuplet', n: 3 },
        {
          ts: FOUR,
        },
      );
      expect(ok.events).toHaveLength(4);
    });

    it('in select mode inserts after the selected event (like Esc first)', () => {
      const ev = [n('C4'), n('D4')];
      const out = run(ev, st({ selected: 0, duration: '8' }), {
        type: 'insertTuplet',
        n: 3,
      });
      expect(pitches(out.events)).toEqual(['C4', 'r', 'r', 'r', 'D4']);
      expect(out.state.selected).toBeNull();
      expect(out.state.cursor).toBe(1);
    });
  });

  describe('filling the slots', () => {
    it('notes and rests fill the slots in order, then input continues after the group', () => {
      const s = st({ duration: '8', dotted: true });
      const out = press(
        [],
        s,
        { ts: FOUR },
        { type: 'insertTuplet', n: 3 },
        A,
        R,
        E,
      );
      expect(out.events).toEqual([tn('C4', 0), tr(1), tn('E4', 2)]);
      expect(out.state.cursor).toBe(3);
      const after = applyCommand(out.events, out.state, D, { ts: FOUR });
      expect(after.events[3]).toEqual(n('D4', undefined, 12));
      expect(after.state.cursor).toBe(4);
      expect(roundTrip(after.events)).toEqual(after.events);
    });

    it('at the start of a group that has a note, input inserts before it', () => {
      const ev = [tn('C4', 0), tr(1), tr(2)];
      const out = run(ev, st({ cursor: 0, duration: '4' }), D);
      expect(pitches(out.events)).toEqual(['D4', 'C4', 'r', 'r']);
      expect(out.events[0].tuplet).toBeUndefined();
      expect(out.state.cursor).toBe(1);
    });

    it('inside a filled group a key replaces the slot; lyrics re-flow', () => {
      const ev = [tn('C4', 0, 'a'), tn('D4', 1, 'b'), tn('E4', 2, 'c')];
      const rest = run(ev, st({ cursor: 1 }), R);
      expect(rest.events).toEqual([tn('C4', 0, 'a'), tr(1), tn('E4', 2, 'b')]);
      expect(rest.state.cursor).toBe(2);
      const note = run(ev, st({ cursor: 1 }), E);
      expect(pitches(note.events)).toEqual(['C4', 'E4', 'E4']);
      expect(lyrics(note.events)).toEqual(['a', 'b', 'c']);
      expect(note.events[1].tuplet).toEqual({ n: 3, slot: 1 });
    });

    it('a slot keeps its chord when filled', () => {
      const ev = [{ ...tr(0), chord: 'Am' }, tr(1), tr(2)];
      const out = run(ev, st({ cursor: 0 }), A);
      expect(out.events[0]).toEqual({ ...tn('C4', 0), chord: 'Am' });
    });

    it('a rest key on a rest slot only advances the cursor', () => {
      const ev = [tr(0), tr(1), tr(2)];
      const out = run(ev, st({ cursor: 1 }), R);
      expect(out.events).toBe(ev);
      expect(out.state.cursor).toBe(2);
    });

    it('placeAt in a fill zone replaces that slot', () => {
      const ev = [tr(0), tr(1), tr(2)];
      const out = run(ev, st({ cursor: 3 }), {
        type: 'placeAt',
        index: 1,
        pitch: 'G4',
      });
      expect(out.events).toEqual([tr(0), tn('G4', 1), tr(2)]);
      expect(out.state.cursor).toBe(2);
    });
  });

  describe('Backspace', () => {
    it('turns slots back into rests, then removes the all-rest group', () => {
      const ev = [n('F4'), tn('C4', 0), tn('D4', 1), tn('E4', 2)];
      let out = run(ev, st({ cursor: 4 }), BS);
      expect(out.events).toEqual([n('F4'), tn('C4', 0), tn('D4', 1), tr(2)]);
      expect(out.state.cursor).toBe(3);
      out = press(out.events, out.state, {}, BS, BS);
      expect(out.events).toEqual([n('F4'), tr(0), tr(1), tr(2)]);
      expect(out.state.cursor).toBe(1);
      out = run(out.events, out.state, BS);
      expect(out.events).toEqual([n('F4')]);
      expect(out.state.cursor).toBe(1);
    });

    it('a rest slot in a group that still has a note only moves the cursor', () => {
      const ev = [tn('C4', 0), tr(1), tr(2)];
      const out = run(ev, st({ cursor: 3 }), BS);
      expect(out.events).toBe(ev);
      expect(out.state.cursor).toBe(2);
    });

    it('a slot turned into a rest drops its lyric; the rest shifts left', () => {
      const ev = [tn('C4', 0, 'a'), tn('D4', 1, 'b'), tn('E4', 2, 'c')];
      const out = run(ev, st({ cursor: 2 }), BS);
      expect(lyrics(out.events)).toEqual(['a', '', 'b']);
    });

    it('in select mode: a note slot becomes a rest, input mode at that slot', () => {
      const ev = [tn('C4', 0), tn('D4', 1), tr(2)];
      const out = run(ev, st({ selected: 1 }), BS);
      expect(out.events).toEqual([tn('C4', 0), tr(1), tr(2)]);
      expect(out.state.selected).toBeNull();
      expect(out.state.cursor).toBe(1);
    });

    it('in select mode: a rest slot of an all-rest group removes the group', () => {
      const ev = [n('F4'), tr(0), tr(1), tr(2), n('G4')];
      const out = run(ev, st({ selected: 2 }), BS);
      expect(out.events).toEqual([n('F4'), n('G4')]);
      expect(out.state).toMatchObject({ selected: null, cursor: 1 });
    });

    it('in select mode: a rest slot with notes left only leaves select mode', () => {
      const ev = [tn('C4', 0), tr(1), tr(2)];
      const out = run(ev, st({ selected: 2 }), BS);
      expect(out.events).toBe(ev);
      expect(out.state).toMatchObject({ selected: null, cursor: 2 });
    });
  });

  describe('select mode on a slot', () => {
    it('duration and dot keys are refused with a reason', () => {
      const ev = [tn('C4', 0), tr(1), tr(2)];
      const s = st({ selected: 0, duration: '8' });
      for (const cmd of [
        { type: 'setDuration', d: '4' },
        { type: 'toggleDot' },
      ] as Command[]) {
        const out = run(ev, s, cmd);
        expect(out.events).toBe(ev);
        expect(out.state).toBe(s);
        expect(out.message).toBe('連符の中の音価は変えられません');
      }
    });

    it('the rest key keeps the slot mark; a note key fills a rest slot', () => {
      const ev = [tn('C4', 0, 'a'), tr(1), tr(2)];
      const rest = run(ev, st({ selected: 0 }), R);
      expect(rest.events).toEqual([tr(0), tr(1), tr(2)]);
      expect(rest.state.selected).toBe(0);
      const note = run(ev, st({ selected: 2 }), D);
      expect(note.events).toEqual([tn('C4', 0, 'a'), tr(1), tn('D4', 2)]);
    });

    it('selecting a slot syncs the duration to its unit', () => {
      const out = run([tr(0), tr(1), tr(2)], st({ duration: '2' }), {
        type: 'select',
        index: 1,
      });
      expect(out.state).toMatchObject({ selected: 1, duration: '8' });
    });
  });

  describe('removeTuplet / tupletAtCursor', () => {
    const ev = [
      n('F4', 'x'),
      tn('C4', 0, 'a'),
      tr(1),
      tn('E4', 2, 'b'),
      n('G4', 'c'),
    ];

    it('finds the group around the cursor or the selection', () => {
      const g = { start: 1, end: 4, n: 3, unitTicks: 8, span: 16 };
      expect(tupletAtCursor(ev, st({ cursor: 2 }))).toEqual(g);
      expect(tupletAtCursor(ev, st({ cursor: 4 }))).toEqual(g); // just after
      expect(tupletAtCursor(ev, st({ cursor: 1 }))).toBeNull(); // before, filled
      expect(tupletAtCursor(ev, st({ cursor: 5 }))).toBeNull();
      expect(tupletAtCursor(ev, st({ selected: 3 }))).toEqual(g);
      expect(tupletAtCursor(ev, st({ selected: 0 }))).toBeNull();
      // A fresh (all-rest) group at the cursor counts as "in" it.
      const fresh = [n('F4'), tr(0), tr(1), tr(2)];
      expect(tupletAtCursor(fresh, st({ cursor: 1 }))?.start).toBe(1);
    });

    it('removes the whole group; its lyrics go back to the stream', () => {
      const out = run(ev, st({ cursor: 2 }), { type: 'removeTuplet' });
      expect(pitches(out.events)).toEqual(['F4', 'G4']);
      expect(lyrics(out.events)).toEqual(['x', 'a']);
      expect(out.state.cursor).toBe(1);
      const sel = run(ev, st({ selected: 2 }), { type: 'removeTuplet' });
      expect(pitches(sel.events)).toEqual(['F4', 'G4']);
      expect(sel.state).toMatchObject({ selected: null, cursor: 1 });
    });

    it('without a group at the cursor it is refused with a reason', () => {
      const s = st({ cursor: 0 });
      const out = run(ev, s, { type: 'removeTuplet' });
      expect(out.events).toBe(ev);
      expect(out.state).toBe(s);
      expect(out.message).toBe('カーソルの位置に連符がありません');
    });
  });

  describe('barlines (ts given)', () => {
    // :4 C4 D4 E4 :8 r{tu 3} r{tu 3} r{tu 3} — one full 4/4 bar.
    const bar = [n('C4'), n('D4'), n('E4'), tr(0), tr(1), tr(2)];
    const ctx = { ts: FOUR };

    it('refuses an insert that pushes a later tuplet across the barline', () => {
      const s = st({ cursor: 0, duration: '16' });
      for (const cmd of [
        A,
        R,
        { type: 'placeAt', index: 0, pitch: 'G4' },
        { type: 'insertTuplet', n: 3 },
      ] as Command[]) {
        const out = run(bar, s, cmd, ctx);
        expect(out.events).toBe(bar);
        expect(out.state).toBe(s);
        expect(out.message).toBe(
          'この操作はできません（1 小節目の 3 連符が小節線をまたぎます）',
        );
      }
    });

    it('refuses lengthening an event before a tuplet; allows deleting it', () => {
      const s = st({ selected: 0 });
      const longer = run(bar, s, { type: 'toggleDot' }, ctx);
      expect(longer.events).toBe(bar);
      expect(longer.message).toMatch(/小節線をまたぎます/);
      const del = run(bar, st({ cursor: 1 }), BS, ctx);
      expect(pitches(del.events)).toEqual(['D4', 'E4', 'r', 'r', 'r']);
      expect(del.message).toBeUndefined();
    });

    it('refuses removing a group when a later group would cross', () => {
      // :4 C4 D4 :8 3-tuplet :4 r | then a quarter-note triplet in bar 2
      // fits; removing the first triplet shifts the second by a quarter
      // into a position where it crosses bar 1→2.
      const ev = [
        n('C4'),
        n('D4'),
        tr(0),
        tr(1),
        tr(2),
        n('E4'),
        tr(0, 3, 16),
        tr(1, 3, 16),
        tr(2, 3, 16),
        n('F4', undefined, 32),
      ];
      const out = run(ev, st({ cursor: 3 }), { type: 'removeTuplet' }, ctx);
      expect(out.events).toBe(ev);
      expect(out.message).toMatch(/小節線をまたぎます/);
    });
  });
});
