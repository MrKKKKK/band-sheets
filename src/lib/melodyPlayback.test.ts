import { describe, expect, it } from 'vitest';
import type { MelodyEvent, TimeSig } from './melody';
import {
  barProgress,
  playbackPlan,
  playbackStart,
  playbackTempo,
  startHint,
  startMessage,
  stepAt,
} from './melodyPlayback';

const T44: TimeSig = { num: 4, den: 4 };
const note = (pitch: string, ticks = 16): MelodyEvent => ({
  kind: 'note',
  pitch,
  ticks,
});
const rest = (ticks = 16): MelodyEvent => ({ kind: 'rest', ticks });

// bar 1: C D (rest) E; bar 2: F (half) G (half)
const evs: MelodyEvent[] = [
  note('C4'),
  note('D4'),
  rest(),
  note('E4'),
  note('F4', 32),
  note('G4', 32),
];

describe('playbackTempo', () => {
  it('uses the song tempo, else 100 (未設定)', () => {
    expect(playbackTempo(120)).toEqual({ tempo: 120, set: true });
    expect(playbackTempo(undefined)).toEqual({ tempo: 100, set: false });
    expect(playbackTempo(0)).toEqual({ tempo: 100, set: false });
    expect(playbackTempo(Number.NaN)).toEqual({ tempo: 100, set: false });
  });
});

describe('playbackStart', () => {
  it('starts at the selected note', () => {
    expect(playbackStart(evs, { cursor: 6, selected: 3 })).toEqual({
      index: 3,
      from: 'selection',
    });
  });

  it('starts at the cursor when nothing is selected', () => {
    expect(playbackStart(evs, { cursor: 4, selected: null })).toEqual({
      index: 4,
      from: 'cursor',
    });
  });

  it('cursor at the head, or at the end (nothing after it) → the section head', () => {
    expect(playbackStart(evs, { cursor: 0, selected: null })).toEqual({
      index: 0,
      from: 'head',
    });
    expect(playbackStart(evs, { cursor: 6, selected: null })).toEqual({
      index: 0,
      from: 'head',
    });
  });

  it('only rests after the start point → the section head', () => {
    const withTail = [...evs, rest(), rest()];
    expect(playbackStart(withTail, { cursor: 6, selected: null })).toEqual({
      index: 0,
      from: 'head',
    });
    expect(playbackStart(withTail, { cursor: 0, selected: 7 })).toEqual({
      index: 0,
      from: 'head',
    });
  });

  it('null without any note', () => {
    expect(playbackStart([], { cursor: 0, selected: null })).toBeNull();
    expect(playbackStart([rest(64)], { cursor: 0, selected: null })).toBeNull();
  });
});

describe('playbackPlan', () => {
  // tempo 60: one quarter (16 ticks) = 1 s
  it('from the head: every note (rests silent), every event as a step', () => {
    const p = playbackPlan(evs, 60, 0);
    expect(p.notes.map((n) => [n.index, n.start, n.duration])).toEqual([
      [0, 0, 1],
      [1, 1, 1],
      [3, 3, 1],
      [4, 4, 2],
      [5, 6, 2],
    ]);
    expect(p.steps).toEqual([
      { index: 0, start: 0 },
      { index: 1, start: 1 },
      { index: 2, start: 2 },
      { index: 3, start: 3 },
      { index: 4, start: 4 },
      { index: 5, start: 6 },
    ]);
    expect(p.duration).toBe(8);
  });

  it('from an event: times start at 0 there; earlier notes are left out', () => {
    const p = playbackPlan(evs, 60, 3);
    expect(p.notes.map((n) => [n.index, n.start])).toEqual([
      [3, 0],
      [4, 1],
      [5, 3],
    ]);
    expect(p.steps.map((s) => s.index)).toEqual([3, 4, 5]);
    expect(p.duration).toBe(5);
  });

  it('tuplet slots last their real length; a tie is one note', () => {
    const trip: MelodyEvent[] = [
      { kind: 'note', pitch: 'C4', ticks: 8, tuplet: { n: 3, slot: 0 } },
      { kind: 'note', pitch: 'D4', ticks: 8, tuplet: { n: 3, slot: 1 } },
      { kind: 'note', pitch: 'E4', ticks: 8, tuplet: { n: 3, slot: 2 } },
      note('F4', 48), // one note, written tied across beats
    ];
    const p = playbackPlan(trip, 60, 1);
    expect(p.notes).toHaveLength(3);
    expect(p.notes[0].start).toBe(0);
    expect(p.notes[0].duration).toBeCloseTo(1 / 3);
    expect(p.notes[2].duration).toBe(3);
    expect(p.duration).toBeCloseTo(2 / 3 + 3);
  });
});

describe('stepAt', () => {
  const p = playbackPlan(evs, 60, 0);
  it('the event at t (rests too), null from the end on', () => {
    expect(stepAt(p, 0)).toBe(0);
    expect(stepAt(p, 2.5)).toBe(2);
    expect(stepAt(p, 5.9)).toBe(4);
    expect(stepAt(p, 7.99)).toBe(5);
    expect(stepAt(p, 8)).toBeNull();
    expect(stepAt(p, -0.01)).toBe(0);
  });
});

describe('labels', () => {
  it('startHint by where playback starts', () => {
    expect(startHint({ index: 0, from: 'head' }, evs, T44)).toBe(
      'セクションの最初から鳴らします',
    );
    expect(startHint({ index: 5, from: 'cursor' }, evs, T44)).toBe(
      'カーソルの位置（2 小節目の 3 拍目）から鳴らします',
    );
    expect(startHint({ index: 1, from: 'selection' }, evs, T44)).toBe(
      '選んだ音（1 小節目の 2 拍目）から鳴らします',
    );
  });

  it('startMessage / barProgress', () => {
    expect(startMessage(evs, T44, 4)).toBe('2 小節目から再生します');
    expect(barProgress(evs, T44, 3)).toEqual({ bar: 1, bars: 2 });
    expect(barProgress(evs, T44, 5)).toEqual({ bar: 2, bars: 2 });
  });
});
