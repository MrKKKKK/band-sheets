import { describe, expect, it } from 'vitest';
import type { DrumEvent, DrumHit } from './drum';
import { DRUM_KIT, type DrumInstrument } from './drumKit';
import {
  applyDrumCommand,
  initialDrumEditorState,
  keyToDrumCommand,
  MESSAGES,
  tupletForRemoval,
  type DrumCommand,
  type DrumEditorState,
} from './drumInput';
import type { TimeSig } from './melody';
import type { KeyInput } from './melodyInput';

const key = (code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  code,
  key: '',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

/** A beat of `ticks` with plain hits. */
const b = (ticks: number, ...insts: DrumInstrument[]): DrumEvent => ({
  hits: insts.map((inst) => ({ inst })),
  ticks,
});
const r = (ticks = 8): DrumEvent => ({ hits: [], ticks });
/** Tuplet slot. */
const t = (
  n: number,
  slot: number,
  ticks: number,
  ...insts: DrumInstrument[]
): DrumEvent => ({ ...b(ticks, ...insts), tuplet: { n, slot } });
/** An n-tuplet of rests of `ticks`. */
const restGroup = (n: number, ticks = 8): DrumEvent[] =>
  Array.from({ length: n }, (_, slot) => t(n, slot, ticks));

const st = (over: Partial<DrumEditorState> = {}): DrumEditorState => ({
  cursor: 0,
  selected: null,
  duration: '8',
  dotted: false,
  lastInst: null,
  ...over,
});

const TS: TimeSig = { num: 4, den: 4 };
const run = (
  events: DrumEvent[],
  state: DrumEditorState,
  cmd: DrumCommand,
  ts: TimeSig = TS,
) => applyDrumCommand(events, state, cmd, { ts });

/** Compact view: 'HH+BD', 'r', with ticks and tuplet slot. */
const show = (events: DrumEvent[]) =>
  events.map(
    (e) =>
      `${e.hits.length ? e.hits.map(hitText).join('+') : 'r'}/${e.ticks}` +
      (e.tuplet ? `@${e.tuplet.n}.${e.tuplet.slot}` : ''),
  );
function hitText(h: DrumHit): string {
  const art = h.ghost
    ? '(g)'
    : h.accent === 'heavy'
      ? '^'
      : h.accent
        ? '>'
        : '';
  return h.inst + art;
}

describe('keyToDrumCommand', () => {
  it.each(DRUM_KIT.map((e) => [e.code, e.id] as const))(
    '%s → instInput %s, Shift → toggleOnPrevious',
    (code, inst) => {
      expect(keyToDrumCommand(key(code))).toEqual({ type: 'instInput', inst });
      expect(keyToDrumCommand(key(code, { shiftKey: true }))).toEqual({
        type: 'toggleOnPrevious',
        inst,
      });
    },
  );

  it('matches the approved key map (F J H G K L ; U I)', () => {
    const m: Record<string, string> = {
      KeyF: 'SD',
      KeyJ: 'BD',
      KeyH: 'HH',
      KeyG: 'HO',
      KeyK: 'T1',
      KeyL: 'T2',
      Semicolon: 'FT',
      KeyU: 'CR',
      KeyI: 'RD',
    };
    for (const [code, inst] of Object.entries(m)) {
      expect(keyToDrumCommand(key(code))).toEqual({ type: 'instInput', inst });
    }
  });

  it('uses e.code, not e.key (JIS / IME layouts)', () => {
    expect(keyToDrumCommand(key('KeyF', { key: 'は' }))).toEqual({
      type: 'instInput',
      inst: 'SD',
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
    expect(keyToDrumCommand(key(code))).toEqual({ type: 'setDuration', d });
  });

  it('has no 32nd key (Digit3 / Digit5 / Digit7 / Digit9 / Digit0 ignored)', () => {
    for (const code of ['Digit3', 'Digit5', 'Digit7', 'Digit9', 'Digit0']) {
      expect(keyToDrumCommand(key(code))).toBeNull();
    }
  });

  it.each([
    ['Period', 'toggleDot'],
    ['NumpadDecimal', 'toggleDot'],
    ['KeyR', 'rest'],
    ['KeyS', 'toggleGhost'],
    ['KeyA', 'cycleAccent'],
    ['ArrowLeft', 'moveLeft'],
    ['ArrowRight', 'moveRight'],
    ['Backspace', 'deleteBackward'],
    ['Enter', 'selectBefore'],
    ['NumpadEnter', 'selectBefore'],
    ['Escape', 'clearSelection'],
  ])('%s → %s', (code, type) => {
    expect(keyToDrumCommand(key(code))).toEqual({ type });
  });

  it('leaves Tab, modifiers, IME and Shift+non-instrument keys alone', () => {
    expect(keyToDrumCommand(key('Tab'))).toBeNull();
    expect(keyToDrumCommand(key('KeyF', { ctrlKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('KeyF', { altKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('KeyF', { metaKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('ArrowUp', { ctrlKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('KeyF', { isComposing: true }))).toBeNull();
    expect(keyToDrumCommand(key('KeyF', { key: 'Process' }))).toBeNull();
    expect(keyToDrumCommand(key('KeyR', { shiftKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('Digit8', { shiftKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('KeyS', { shiftKey: true }))).toBeNull();
    expect(keyToDrumCommand(key('ArrowUp'))).toBeNull();
    expect(keyToDrumCommand(key('KeyZ'))).toBeNull();
  });
});

describe('initialDrumEditorState', () => {
  it('starts in input mode at the end with 8th notes', () => {
    expect(initialDrumEditorState([r(), r()])).toEqual(
      st({ cursor: 2, duration: '8' }),
    );
  });
});

describe('instInput (input mode)', () => {
  it('inserts a beat with the current duration at the start / middle / end', () => {
    const ev = [b(8, 'HH'), b(8, 'SD')];
    const start = run(ev, st({ cursor: 0 }), { type: 'instInput', inst: 'BD' });
    expect(show(start.events)).toEqual(['BD/8', 'HH/8', 'SD/8']);
    expect(start.state).toMatchObject({ cursor: 1, lastInst: 'BD' });
    const mid = run(ev, st({ cursor: 1 }), { type: 'instInput', inst: 'BD' });
    expect(show(mid.events)).toEqual(['HH/8', 'BD/8', 'SD/8']);
    expect(mid.state.cursor).toBe(2);
    const end = run(ev, st({ cursor: 2, duration: '4', dotted: true }), {
      type: 'instInput',
      inst: 'CR',
    });
    expect(show(end.events)).toEqual(['HH/8', 'SD/8', 'CR/24']);
    expect(end.state.cursor).toBe(3);
    expect(end.message).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const ev = [b(8, 'HH')];
    const s = st({ cursor: 1 });
    run(ev, s, { type: 'instInput', inst: 'SD' });
    expect(show(ev)).toEqual(['HH/8']);
    expect(s.cursor).toBe(1);
  });

  it('clamps an out-of-range cursor', () => {
    const out = run([b(8, 'HH')], st({ cursor: 9 }), {
      type: 'instInput',
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['HH/8', 'SD/8']);
    expect(out.state.cursor).toBe(2);
  });

  it('fills slot 0 of an all-rest tuplet at the cursor, then the next slots', () => {
    let ev = restGroup(3);
    let s = st({ cursor: 0 });
    for (const inst of ['SD', 'SD', 'BD'] as const) {
      const out = run(ev, s, { type: 'instInput', inst });
      ev = out.events;
      s = out.state;
    }
    expect(show(ev)).toEqual(['SD/8@3.0', 'SD/8@3.1', 'BD/8@3.2']);
    expect(s.cursor).toBe(3);
    // At the end of the group: insert after it.
    const after = run(ev, s, { type: 'instInput', inst: 'HH' });
    expect(show(after.events)).toEqual([
      'SD/8@3.0',
      'SD/8@3.1',
      'BD/8@3.2',
      'HH/8',
    ]);
  });

  it('fills with the slot length, not the current duration', () => {
    const out = run(
      restGroup(3),
      st({ cursor: 1, duration: '2', dotted: true }),
      {
        type: 'instInput',
        inst: 'SD',
      },
    );
    expect(show(out.events)).toEqual(['r/8@3.0', 'SD/8@3.1', 'r/8@3.2']);
    expect(out.state.cursor).toBe(2);
  });

  it('replaces a filled slot inside a group (all hits overwritten)', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8, 'HH', 'BD'), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 1 }), { type: 'instInput', inst: 'T1' });
    expect(show(out.events)).toEqual(['SD/8@3.0', 'T1/8@3.1', 'r/8@3.2']);
  });

  it('inserts before a partly filled group when the cursor is at its start', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 0 }), { type: 'instInput', inst: 'BD' });
    expect(show(out.events)).toEqual([
      'BD/8',
      'SD/8@3.0',
      'r/8@3.1',
      'r/8@3.2',
    ]);
    expect(out.state.cursor).toBe(1);
  });

  it('cuts a beat that crosses the barline into beat + rests and keeps the cursor after it', () => {
    // 3/4 of a bar filled; a half note crosses → 4th + rest 4th.
    const ev = [b(16, 'BD'), b(16, 'SD'), b(16, 'BD')];
    const out = run(ev, st({ cursor: 3, duration: '2' }), {
      type: 'instInput',
      inst: 'CR',
    });
    expect(show(out.events)).toEqual([
      'BD/16',
      'SD/16',
      'BD/16',
      'CR/16',
      'r/16',
    ]);
    expect(out.state.cursor).toBe(5);
  });

  it('remaps the cursor when a later beat is cut by an insertion before it', () => {
    // 4 4 2 | 2 2; an 8th inserted at 0 shifts everything by 8.
    const ev = [
      b(16, 'BD'),
      b(16, 'SD'),
      b(32, 'HH'),
      b(32, 'BD'),
      b(32, 'SD'),
    ];
    const out = run(ev, st({ cursor: 0 }), { type: 'instInput', inst: 'CR' });
    expect(show(out.events)).toEqual([
      'CR/8',
      'BD/16',
      'SD/16',
      'HH/24',
      'r/8',
      'BD/32',
      'SD/24',
      'r/8',
    ]);
    expect(out.state.cursor).toBe(1);
    expect(out.events[1]).toBe(ev[0]);
  });

  it('refuses an insertion that pushes a tuplet across the barline', () => {
    // 4 4 4 + 8th triplet (span 16) = full bar; inserting shifts it.
    const ev = [b(16, 'BD'), b(16, 'SD'), b(16, 'BD'), ...restGroup(3)];
    const s = st({ cursor: 0 });
    const out = run(ev, s, { type: 'instInput', inst: 'HH' });
    expect(out.events).toBe(ev);
    expect(out.state).toBe(s);
    expect(out.message).toContain('1 小節目の 3 連符が小節線をまたぎます');
    expect(out.message).toContain('この操作はできません');
  });

  it('works with another time signature (3/4)', () => {
    const ev = [b(16, 'BD'), b(16, 'SD')];
    const out = run(
      ev,
      st({ cursor: 2, duration: '2' }),
      { type: 'instInput', inst: 'BD' },
      { num: 3, den: 4 },
    );
    expect(show(out.events)).toEqual(['BD/16', 'SD/16', 'BD/16', 'r/16']);
  });
});

describe('rest (input mode)', () => {
  it('inserts a rest with the current duration', () => {
    const out = run([b(8, 'HH')], st({ cursor: 1, duration: '16' }), {
      type: 'rest',
    });
    expect(show(out.events)).toEqual(['HH/8', 'r/4']);
    expect(out.state.cursor).toBe(2);
  });

  it('keeps lastInst', () => {
    const out = run([], st({ lastInst: 'SD' }), { type: 'rest' });
    expect(out.state.lastInst).toBe('SD');
  });

  it('inside a tuplet turns the slot into a rest and moves on', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8, 'SD'), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 1 }), { type: 'rest' });
    expect(show(out.events)).toEqual(['SD/8@3.0', 'r/8@3.1', 'r/8@3.2']);
    expect(out.state.cursor).toBe(2);
  });

  it('at the start of an all-rest tuplet only moves the cursor (same events)', () => {
    const ev = restGroup(3);
    const out = run(ev, st({ cursor: 0 }), { type: 'rest' });
    expect(out.events).toBe(ev);
    expect(out.state.cursor).toBe(1);
  });
});

describe('toggleOnPrevious (Shift+key, input mode)', () => {
  it('adds the instrument to the beat before the cursor, cursor unchanged', () => {
    const ev = [b(8, 'HH'), b(8, 'HH')];
    const out = run(ev, st({ cursor: 1 }), {
      type: 'toggleOnPrevious',
      inst: 'BD',
    });
    expect(show(out.events)).toEqual(['HH+BD/8', 'HH/8']);
    expect(out.state).toMatchObject({ cursor: 1, lastInst: 'BD' });
  });

  it('removes it again; the last one leaves a rest', () => {
    const ev = [b(8, 'SD')];
    const out = run(ev, st({ cursor: 1 }), {
      type: 'toggleOnPrevious',
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['r/8']);
  });

  it('HH and HO exclude each other', () => {
    const out = run([b(8, 'HH', 'BD')], st({ cursor: 1 }), {
      type: 'toggleOnPrevious',
      inst: 'HO',
    });
    expect(show(out.events)).toEqual(['HO+BD/8']);
  });

  it('does nothing at the start (same events and state)', () => {
    const ev = [b(8, 'HH')];
    const s = st({ cursor: 0 });
    const out = run(ev, s, { type: 'toggleOnPrevious', inst: 'BD' });
    expect(out.events).toBe(ev);
    expect(out.state).toBe(s);
  });

  it('works on a tuplet slot (tuplet mark kept)', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 1 }), {
      type: 'toggleOnPrevious',
      inst: 'BD',
    });
    expect(show(out.events)).toEqual(['SD+BD/8@3.0', 'r/8@3.1', 'r/8@3.2']);
  });
});

describe('setDuration / toggleDot', () => {
  it('input mode: change only the state (also inside a tuplet)', () => {
    const ev = restGroup(3);
    const out = run(ev, st({ cursor: 1 }), { type: 'setDuration', d: '16' });
    expect(out.events).toBe(ev);
    expect(out.state).toMatchObject({ duration: '16', cursor: 1 });
    const dot = run(ev, out.state, { type: 'toggleDot' });
    expect(dot.state.dotted).toBe(true);
    expect(dot.message).toBeUndefined();
  });

  it('select mode: rewrites the selected beat, keeping its own dot', () => {
    const ev = [b(12, 'SD'), b(8, 'BD')];
    const out = run(ev, st({ selected: 0 }), { type: 'setDuration', d: '4' });
    expect(show(out.events)).toEqual(['SD/24', 'BD/8']);
    expect(out.state).toMatchObject({
      duration: '4',
      dotted: true,
      selected: 0,
    });
    const out2 = run([b(24, 'SD')], st({ selected: 0 }), {
      type: 'setDuration',
      d: '8',
    });
    expect(show(out2.events)).toEqual(['SD/12']);
    expect(out2.state).toMatchObject({
      duration: '8',
      dotted: true,
      selected: 0,
    });
  });

  it('select mode: toggleDot toggles the selected beat', () => {
    const out = run([b(8, 'SD')], st({ selected: 0 }), { type: 'toggleDot' });
    expect(show(out.events)).toEqual(['SD/12']);
    expect(out.state).toMatchObject({ duration: '8', dotted: true });
    const back = run(out.events, out.state, { type: 'toggleDot' });
    expect(show(back.events)).toEqual(['SD/8']);
  });

  it('select mode: toggleDot ignores a 32nd', () => {
    const ev = [b(2, 'SD')];
    const s = st({ selected: 0 });
    const out = run(ev, s, { type: 'toggleDot' });
    expect(out.events).toBe(ev);
    expect(out.state).toBe(s);
  });

  it('select mode: the same value returns the same events', () => {
    const ev = [b(8, 'SD')];
    const out = run(ev, st({ selected: 0, duration: '8' }), {
      type: 'setDuration',
      d: '8',
    });
    expect(out.events).toBe(ev);
  });

  it('select mode: refused on a tuplet slot', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const s = st({ selected: 1 });
    for (const cmd of [
      { type: 'setDuration', d: '4' },
      { type: 'toggleDot' },
    ] as const) {
      const out = run(ev, s, cmd);
      expect(out.events).toBe(ev);
      expect(out.state).toBe(s);
      expect(out.message).toBe(MESSAGES.tupletValue);
    }
  });

  it('select mode: lengthening a beat cuts it at the barline, selection follows', () => {
    const ev = [b(16, 'BD'), b(16, 'SD'), b(16, 'BD'), b(16, 'SD'), b(8, 'HH')];
    const out = run(ev, st({ selected: 4 }), { type: 'setDuration', d: '1' });
    expect(show(out.events)).toEqual([
      'BD/16',
      'SD/16',
      'BD/16',
      'SD/16',
      'HH/64',
    ]);
    const out2 = run(ev, st({ selected: 3 }), { type: 'setDuration', d: '2' });
    expect(show(out2.events)).toEqual([
      'BD/16',
      'SD/16',
      'BD/16',
      'SD/16',
      'r/16',
      'HH/8',
    ]);
    expect(out2.state.selected).toBe(3);
  });

  it('select mode: refused when lengthening pushes a tuplet across the barline', () => {
    // 4 4 + an 8th quintuplet (span 32); a half note moves it to 48.
    const ev = [b(16, 'BD'), b(16, 'SD'), ...restGroup(5)];
    const s = st({ selected: 0 });
    const out = run(ev, s, { type: 'setDuration', d: '2' });
    expect(out.events).toBe(ev);
    expect(out.state).toBe(s);
    expect(out.message).toContain('小節線をまたぎます');
  });
});

describe('deleteBackward', () => {
  it('input mode: deletes the beat before the cursor (start / middle / end)', () => {
    const ev = [b(8, 'HH'), b(8, 'SD'), b(8, 'BD')];
    const s0 = st({ cursor: 0 });
    const atStart = run(ev, s0, { type: 'deleteBackward' });
    expect(atStart.events).toBe(ev);
    expect(atStart.state).toBe(s0);
    const mid = run(ev, st({ cursor: 2 }), { type: 'deleteBackward' });
    expect(show(mid.events)).toEqual(['HH/8', 'BD/8']);
    expect(mid.state.cursor).toBe(1);
    const end = run(ev, st({ cursor: 3 }), { type: 'deleteBackward' });
    expect(show(end.events)).toEqual(['HH/8', 'SD/8']);
    expect(end.state.cursor).toBe(2);
  });

  it('input mode: a struck slot becomes a rest, cursor −1', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8, 'SD'), t(3, 2, 8, 'BD')];
    const out = run(ev, st({ cursor: 3 }), { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['SD/8@3.0', 'SD/8@3.1', 'r/8@3.2']);
    expect(out.state.cursor).toBe(2);
  });

  it('input mode: a rest slot in a partly filled group is stepped over', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 2 }), { type: 'deleteBackward' });
    expect(out.events).toBe(ev);
    expect(out.state.cursor).toBe(1);
  });

  it('input mode: Backspace × n empties a filled group, then removes it', () => {
    let ev = [b(8, 'HH'), t(3, 0, 8, 'SD'), t(3, 1, 8, 'SD'), t(3, 2, 8, 'SD')];
    let s = st({ cursor: 4 });
    for (let k = 0; k < 3; k++) {
      const out = run(ev, s, { type: 'deleteBackward' });
      ev = out.events;
      s = out.state;
    }
    expect(show(ev)).toEqual(['HH/8', 'r/8@3.0', 'r/8@3.1', 'r/8@3.2']);
    expect(s.cursor).toBe(1);
    // Cursor at the start of an all-rest group: the group goes, not the HH.
    const out = run(ev, s, { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['HH/8']);
    expect(out.state.cursor).toBe(1);
  });

  it('input mode: right after inserting a tuplet, Backspace removes it', () => {
    const ins = run([b(8, 'HH')], st({ cursor: 1 }), {
      type: 'insertTuplet',
      n: 3,
    });
    const out = run(ins.events, ins.state, { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['HH/8']);
    expect(out.state.cursor).toBe(1);
  });

  it('input mode: cursor after an all-rest group removes the whole group', () => {
    const ev = [...restGroup(3), b(8, 'HH')];
    const out = run(ev, st({ cursor: 3 }), { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['HH/8']);
    expect(out.state.cursor).toBe(0);
  });

  it('select mode: deletes the beat and returns to input mode at its index', () => {
    const ev = [b(8, 'HH'), b(8, 'SD'), b(8, 'BD')];
    const out = run(ev, st({ selected: 1 }), { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['HH/8', 'BD/8']);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('select mode: a struck slot becomes a rest (input mode, cursor on the slot)', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8, 'SD'), t(3, 2, 8)];
    const out = run(ev, st({ selected: 1 }), { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['SD/8@3.0', 'r/8@3.1', 'r/8@3.2']);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('select mode: on an all-rest group the whole group goes', () => {
    const ev = [b(8, 'HH'), ...restGroup(5, 4)];
    const out = run(ev, st({ selected: 3 }), { type: 'deleteBackward' });
    expect(show(out.events)).toEqual(['HH/8']);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('refuses a deletion that pulls a tuplet across the barline', () => {
    // 8 + 4 4 4 + 8 = one bar, the triplet starts bar 2; deleting the first
    // 8th moves it to 56.
    const ev = [
      b(8, 'HH'),
      b(16, 'BD'),
      b(16, 'SD'),
      b(16, 'BD'),
      b(8, 'HH'),
      ...restGroup(3),
    ];
    const s = st({ cursor: 1 });
    const out = run(ev, s, { type: 'deleteBackward' });
    expect(out.events).toBe(ev);
    expect(out.state).toBe(s);
    expect(out.message).toContain('1 小節目の 3 連符が小節線をまたぎます');
  });
});

describe('insertTuplet / removeTuplet', () => {
  it('inserts n rests with the current duration (dot ignored), cursor at its start', () => {
    const ev = [b(8, 'HH')];
    const out = run(ev, st({ cursor: 1, duration: '8', dotted: true }), {
      type: 'insertTuplet',
      n: 3,
    });
    expect(show(out.events)).toEqual(['HH/8', 'r/8@3.0', 'r/8@3.1', 'r/8@3.2']);
    expect(out.state).toMatchObject({ cursor: 1, selected: null });
  });

  it('inserts at the start, then the keys fill it', () => {
    const ins = run([], st({ duration: '16' }), { type: 'insertTuplet', n: 6 });
    expect(show(ins.events)).toHaveLength(6);
    const f = run(ins.events, ins.state, { type: 'instInput', inst: 'SD' });
    expect(show(f.events)[0]).toBe('SD/4@6.0');
    expect(f.state.cursor).toBe(1);
  });

  it('refuses inside a group, a whole-note unit and an invalid n', () => {
    const ev = restGroup(3);
    const s = st({ cursor: 1 });
    const inside = run(ev, s, { type: 'insertTuplet', n: 3 });
    expect(inside).toEqual({
      events: ev,
      state: s,
      message: '連符の中に連符は入れられません',
    });
    expect(inside.events).toBe(ev);
    const whole = run([], st({ duration: '1' }), {
      type: 'insertTuplet',
      n: 3,
    });
    expect(whole.message).toBe('連符の単位は 2分〜32分の音符だけです');
    const four = run([], st(), { type: 'insertTuplet', n: 4 });
    expect(four.message).toContain('4 連符は作れません');
  });

  it('refuses a tuplet that would cross the barline', () => {
    const ev = [b(16, 'BD'), b(16, 'SD'), b(16, 'BD'), b(8, 'SD')];
    const out = run(ev, st({ cursor: 4 }), { type: 'insertTuplet', n: 3 });
    expect(out.events).toBe(ev);
    expect(out.message).toContain('小節線をまたぎます');
  });

  it('select mode: inserts right after the selected beat', () => {
    const ev = [b(8, 'HH'), b(8, 'SD')];
    const out = run(ev, st({ selected: 0 }), { type: 'insertTuplet', n: 3 });
    expect(show(out.events)).toEqual([
      'HH/8',
      'r/8@3.0',
      'r/8@3.1',
      'r/8@3.2',
      'SD/8',
    ]);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('select mode: refused when the selected slot is not the last of its group', () => {
    const out = run(restGroup(3), st({ selected: 0 }), {
      type: 'insertTuplet',
      n: 3,
    });
    expect(out.message).toBe('連符の中に連符は入れられません');
  });

  it('removeTuplet removes the group around the cursor (inside / after / at start)', () => {
    const ev = [
      b(8, 'HH'),
      t(3, 0, 8, 'SD'),
      t(3, 1, 8),
      t(3, 2, 8),
      b(8, 'BD'),
    ];
    for (const cursor of [1, 2, 3, 4]) {
      const out = run(ev, st({ cursor }), { type: 'removeTuplet' });
      expect(show(out.events)).toEqual(['HH/8', 'BD/8']);
      expect(out.state.cursor).toBe(1);
    }
  });

  it('removeTuplet in select mode removes the selected beat’s group', () => {
    const ev = [b(8, 'HH'), t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const out = run(ev, st({ selected: 2 }), { type: 'removeTuplet' });
    expect(show(out.events)).toEqual(['HH/8']);
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
  });

  it('removeTuplet without a group is refused', () => {
    const ev = [b(8, 'HH')];
    const s = st({ cursor: 1 });
    expect(run(ev, s, { type: 'removeTuplet' })).toEqual({
      events: ev,
      state: s,
      message: MESSAGES.noTuplet,
    });
    expect(run(ev, st({ selected: 0 }), { type: 'removeTuplet' }).message).toBe(
      MESSAGES.noTuplet,
    );
  });

  it('refuses removing a group when a later tuplet would cross the barline', () => {
    const ev = [
      b(8, 'HH'),
      ...restGroup(3, 4), // span 8 at 8 → 16
      b(16, 'SD'), // 16 → 32
      b(8, 'BD'), // 32 → 40
      b(8, 'BD'), // 40 → 48
      ...restGroup(3), // span 16 at 48 → 64
    ];
    // Remove the 16th triplet (span 8): second group moves to 40 → 56 fits.
    const ok = run(ev, st({ cursor: 2 }), { type: 'removeTuplet' });
    expect(ok.message).toBeUndefined();
    // Removing the leading 16th triplet here moves the 2nd quintuplet to 56.
    const ev2 = [
      ...restGroup(3, 4), // 0 → 8
      b(8, 'BD'), // 8 → 16
      ...restGroup(5, 8), // span 32 at 16 → 48
      b(16, 'SD'), // 48 → 64
      ...restGroup(5, 8), // 64 → 96
    ];
    const bad = run(ev2, st({ cursor: 1 }), { type: 'removeTuplet' });
    expect(bad.events).toBe(ev2);
    expect(bad.message).toContain('5 連符が小節線をまたぎます');
  });

  it('tupletForRemoval mirrors removeTuplet', () => {
    const ev = [b(8, 'HH'), ...restGroup(3), b(8, 'BD')];
    expect(tupletForRemoval(ev, st({ cursor: 0 }))).toBeNull();
    expect(tupletForRemoval(ev, st({ cursor: 1 }))?.start).toBe(1);
    expect(tupletForRemoval(ev, st({ cursor: 4 }))?.start).toBe(1);
    expect(tupletForRemoval(ev, st({ cursor: 5 }))).toBeNull();
    expect(tupletForRemoval(ev, st({ selected: 2 }))?.start).toBe(1);
    expect(tupletForRemoval(ev, st({ selected: 4 }))).toBeNull();
    expect(tupletForRemoval(ev, st({ selected: 9 }))).toBeNull();
  });
});

describe('toggleGhost / cycleAccent', () => {
  it('input mode: ghost on the last instrument of the previous beat', () => {
    const ev = [b(8, 'HH', 'SD')];
    const out = run(ev, st({ cursor: 1, lastInst: 'SD' }), {
      type: 'toggleGhost',
    });
    expect(show(out.events)).toEqual(['HH+SD(g)/8']);
    const off = run(out.events, out.state, { type: 'toggleGhost' });
    expect(show(off.events)).toEqual(['HH+SD/8']);
  });

  it('accent cycles none → accent → heavy → none', () => {
    let ev = [b(8, 'SD')];
    let s = st({ cursor: 1, lastInst: 'SD' });
    const seen: string[] = [];
    for (let k = 0; k < 3; k++) {
      const out = run(ev, s, { type: 'cycleAccent' });
      ev = out.events;
      s = out.state;
      seen.push(show(ev)[0]);
    }
    expect(seen).toEqual(['SD>/8', 'SD^/8', 'SD/8']);
  });

  it('ghost and accent exclude each other', () => {
    const ev: DrumEvent[] = [{ hits: [{ inst: 'SD', ghost: true }], ticks: 8 }];
    const out = run(ev, st({ cursor: 1, lastInst: 'SD' }), {
      type: 'cycleAccent',
    });
    expect(show(out.events)).toEqual(['SD>/8']);
    const g = run(out.events, out.state, { type: 'toggleGhost' });
    expect(show(g.events)).toEqual(['SD(g)/8']);
  });

  it('falls back to the only hit of the beat and makes it the last instrument', () => {
    const out = run([b(8, 'SD')], st({ cursor: 1, lastInst: 'HH' }), {
      type: 'toggleGhost',
    });
    expect(show(out.events)).toEqual(['SD(g)/8']);
    expect(out.state.lastInst).toBe('SD');
  });

  it('refuses when the instrument is ambiguous, on a rest, or with no beat', () => {
    const ev = [b(8, 'HH', 'BD')];
    const s = st({ cursor: 1, lastInst: 'SD' });
    expect(run(ev, s, { type: 'toggleGhost' })).toEqual({
      events: ev,
      state: s,
      message: MESSAGES.whichInstrument,
    });
    expect(run([r()], st({ cursor: 1 }), { type: 'cycleAccent' }).message).toBe(
      MESSAGES.restArticulation,
    );
    expect(run([], st(), { type: 'cycleAccent' }).message).toBe(
      MESSAGES.noPrevious,
    );
  });

  it('select mode: acts on the selected beat', () => {
    const ev = [b(8, 'HH', 'BD'), b(8, 'HH')];
    const out = run(ev, st({ selected: 0, cursor: 2, lastInst: 'BD' }), {
      type: 'cycleAccent',
    });
    expect(show(out.events)).toEqual(['HH+BD>/8', 'HH/8']);
    expect(out.state.selected).toBe(0);
  });

  it('works on a tuplet slot', () => {
    const ev = [t(3, 0, 8, 'SD'), t(3, 1, 8), t(3, 2, 8)];
    const out = run(ev, st({ cursor: 1, lastInst: 'SD' }), {
      type: 'toggleGhost',
    });
    expect(show(out.events)).toEqual(['SD(g)/8@3.0', 'r/8@3.1', 'r/8@3.2']);
  });

  it('instrument keys set the last instrument used by S / A', () => {
    const a = run([], st(), { type: 'instInput', inst: 'HH' });
    const c = run(a.events, a.state, { type: 'toggleOnPrevious', inst: 'BD' });
    const g = run(c.events, c.state, { type: 'cycleAccent' });
    expect(show(g.events)).toEqual(['HH+BD>/8']);
  });
});

describe('select mode: instrument / rest keys', () => {
  it('an instrument key toggles it on the selected beat', () => {
    const ev = [b(8, 'HH'), b(8, 'SD')];
    const add = run(ev, st({ selected: 0 }), { type: 'instInput', inst: 'BD' });
    expect(show(add.events)).toEqual(['HH+BD/8', 'SD/8']);
    expect(add.state).toMatchObject({ selected: 0, lastInst: 'BD' });
    const rm = run(add.events, add.state, {
      type: 'toggleOnPrevious',
      inst: 'HH',
    });
    expect(show(rm.events)).toEqual(['BD/8', 'SD/8']);
  });

  it('toggles on a selected tuplet slot (mark kept)', () => {
    const ev = restGroup(3);
    const out = run(ev, st({ selected: 2 }), { type: 'instInput', inst: 'SD' });
    expect(show(out.events)).toEqual(['r/8@3.0', 'r/8@3.1', 'SD/8@3.2']);
  });

  it('rest clears the selected beat; a selected rest stays the same', () => {
    const ev = [b(12, 'HH', 'BD')];
    const out = run(ev, st({ selected: 0 }), { type: 'rest' });
    expect(show(out.events)).toEqual(['r/12']);
    const again = run(out.events, out.state, { type: 'rest' });
    expect(again.events).toBe(out.events);
    expect(again.state).toBe(out.state);
  });
});

describe('cursor, selection and mode', () => {
  it('moveLeft / moveRight clamp in input mode; same state at the edges', () => {
    const ev = [r(), r()];
    const s0 = st({ cursor: 0 });
    expect(run(ev, s0, { type: 'moveLeft' }).state).toBe(s0);
    expect(run(ev, st({ cursor: 1 }), { type: 'moveRight' }).state.cursor).toBe(
      2,
    );
    const s2 = st({ cursor: 2 });
    expect(run(ev, s2, { type: 'moveRight' }).state).toBe(s2);
  });

  it('moveLeft / moveRight move the selection, clamped', () => {
    const ev = [r(), r(), r()];
    expect(
      run(ev, st({ selected: 1 }), { type: 'moveLeft' }).state.selected,
    ).toBe(0);
    const s = st({ selected: 2 });
    expect(run(ev, s, { type: 'moveRight' }).state).toBe(s);
  });

  it('selectBefore selects the beat before the cursor and syncs the duration', () => {
    const ev = [b(24, 'SD'), b(8, 'HH')];
    const out = run(ev, st({ cursor: 1 }), { type: 'selectBefore' });
    expect(out.state).toMatchObject({
      selected: 0,
      duration: '4',
      dotted: true,
    });
    const s0 = st({ cursor: 0 });
    expect(run(ev, s0, { type: 'selectBefore' }).state).toBe(s0);
    const sel = st({ selected: 1 });
    expect(run(ev, sel, { type: 'selectBefore' }).state).toBe(sel);
  });

  it('clearSelection returns to input mode after the beat', () => {
    const out = run([r(), r()], st({ selected: 0 }), {
      type: 'clearSelection',
    });
    expect(out.state).toMatchObject({ selected: null, cursor: 1 });
    const s = st({ cursor: 1 });
    expect(run([r()], s, { type: 'clearSelection' }).state).toBe(s);
  });

  it('a stale selection acts as input mode at the end', () => {
    const out = run([b(8, 'HH')], st({ selected: 5 }), {
      type: 'instInput',
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['HH/8', 'SD/8']);
    expect(out.state).toMatchObject({ selected: null, cursor: 2 });
  });

  it('select (click) sets the selection, duration and the clicked instrument', () => {
    const ev = [b(4, 'HH', 'SD')];
    const out = run(ev, st(), { type: 'select', index: 0, inst: 'SD' });
    expect(out.state).toMatchObject({
      selected: 0,
      duration: '16',
      dotted: false,
      lastInst: 'SD',
    });
    expect(out.events).toBe(ev);
    // An instrument not on the beat does not become the last one.
    expect(
      run(ev, st(), { type: 'select', index: 0, inst: 'BD' }).state.lastInst,
    ).toBeNull();
    // A 32nd keeps the input duration.
    expect(
      run([b(2, 'SD')], st({ duration: '8' }), { type: 'select', index: 0 })
        .state.duration,
    ).toBe('8');
    // Out of range → same.
    const s = st();
    expect(run(ev, s, { type: 'select', index: 3 }).state).toBe(s);
    expect(run(ev, s, { type: 'select', index: 0.5 }).state).toBe(s);
  });
});

describe('mouse: placeAt / addAt', () => {
  it('placeAt inserts at the index and leaves input mode after it', () => {
    const ev = [b(8, 'HH'), b(8, 'HH')];
    const out = run(ev, st({ cursor: 2, selected: 0 }), {
      type: 'placeAt',
      index: 1,
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['HH/8', 'SD/8', 'HH/8']);
    expect(out.state).toMatchObject({
      selected: null,
      cursor: 2,
      lastInst: 'SD',
    });
  });

  it('placeAt fills a tuplet slot when the index is in its fill zone', () => {
    const out = run(restGroup(3), st(), {
      type: 'placeAt',
      index: 1,
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['r/8@3.0', 'SD/8@3.1', 'r/8@3.2']);
    expect(out.state.cursor).toBe(2);
  });

  it('placeAt ignores an invalid index', () => {
    const ev = [r()];
    const s = st();
    for (const index of [-1, 2, 0.5]) {
      const out = run(ev, s, { type: 'placeAt', index, inst: 'SD' });
      expect(out.events).toBe(ev);
      expect(out.state).toBe(s);
    }
  });

  it('placeAt is refused when it pushes a tuplet across the barline', () => {
    const ev = [b(16, 'BD'), b(16, 'SD'), b(16, 'BD'), ...restGroup(3)];
    const out = run(ev, st({ cursor: 6 }), {
      type: 'placeAt',
      index: 0,
      inst: 'SD',
    });
    expect(out.events).toBe(ev);
    expect(out.message).toContain('小節線をまたぎます');
  });

  it('addAt adds the instrument to the beat; input mode: cursor after it', () => {
    const ev = [b(8, 'HH'), b(8, 'HH')];
    const out = run(ev, st({ cursor: 2 }), {
      type: 'addAt',
      index: 0,
      inst: 'BD',
    });
    expect(show(out.events)).toEqual(['HH+BD/8', 'HH/8']);
    expect(out.state).toMatchObject({
      cursor: 1,
      selected: null,
      lastInst: 'BD',
    });
    // S / A now target that beat's BD.
    const acc = run(out.events, out.state, { type: 'cycleAccent' });
    expect(show(acc.events)).toEqual(['HH+BD>/8', 'HH/8']);
  });

  it('addAt in select mode selects the clicked beat', () => {
    const ev = [b(8, 'HH'), b(8, 'HH')];
    const out = run(ev, st({ selected: 1 }), {
      type: 'addAt',
      index: 0,
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['HH+SD/8', 'HH/8']);
    expect(out.state).toMatchObject({ selected: 0, lastInst: 'SD' });
  });

  it('addAt never removes: an instrument already there leaves the events', () => {
    const ev = [b(8, 'HH', 'BD')];
    const out = run(ev, st({ cursor: 1 }), {
      type: 'addAt',
      index: 0,
      inst: 'BD',
    });
    expect(out.events).toBe(ev);
    expect(out.state.lastInst).toBe('BD');
  });

  it('addAt on a rest / tuplet rest slot turns it into a hit', () => {
    const out = run(restGroup(3), st(), {
      type: 'addAt',
      index: 1,
      inst: 'SD',
    });
    expect(show(out.events)).toEqual(['r/8@3.0', 'SD/8@3.1', 'r/8@3.2']);
    expect(out.state.cursor).toBe(2);
  });

  it('addAt HO replaces HH (exclusive), and ignores an invalid index', () => {
    const ev = [b(8, 'HH')];
    const out = run(ev, st(), { type: 'addAt', index: 0, inst: 'HO' });
    expect(show(out.events)).toEqual(['HO/8']);
    const s = st();
    expect(run(ev, s, { type: 'addAt', index: 1, inst: 'SD' }).state).toBe(s);
  });
});

describe('identity', () => {
  it('no-op commands return the same events and state', () => {
    const ev = [b(8, 'HH')];
    const s = st({ cursor: 1 });
    for (const cmd of [
      { type: 'moveRight' },
      { type: 'clearSelection' },
      { type: 'setDuration', d: '8' },
    ] as DrumCommand[]) {
      const out = run(ev, s, cmd);
      expect(out.events).toBe(ev);
      expect(out.state).toBe(s);
      expect(out.message).toBeUndefined();
    }
  });

  it('state-only commands keep the events array', () => {
    const ev = [b(8, 'HH')];
    const out = run(ev, st({ cursor: 1 }), { type: 'setDuration', d: '16' });
    expect(out.events).toBe(ev);
    expect(out.state.duration).toBe('16');
  });

  it('unchanged beats are shared with the input after an edit', () => {
    const ev = [b(8, 'HH'), b(8, 'SD')];
    const out = run(ev, st({ cursor: 2 }), { type: 'instInput', inst: 'BD' });
    expect(out.events[0]).toBe(ev[0]);
    expect(out.events[1]).toBe(ev[1]);
  });
});
