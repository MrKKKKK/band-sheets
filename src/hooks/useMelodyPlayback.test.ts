import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackPlan } from '../lib/melodyPlayback';
import type { TonePlayer } from './tonePlayer';
import { useMelodyPlayback } from './useMelodyPlayback';

/** A tone player whose context clock is `clock.t`. */
function fakeTone() {
  const clock = { t: 0 };
  const tone = {
    start: vi.fn(() => clock.t + 0.03),
    stop: vi.fn(),
    playOne: vi.fn(),
    close: vi.fn(),
    now: () => clock.t,
  } satisfies TonePlayer;
  return { tone, clock };
}

// two quarter notes at ♩=60 from event 2: rest 0–1 s, note 1–2 s
const plan: PlaybackPlan = {
  notes: [{ index: 3, start: 1, duration: 1, midi: 69, hz: 440 }],
  steps: [
    { index: 2, start: 0 },
    { index: 3, start: 1 },
  ],
  duration: 2,
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const { tone, clock } = fakeTone();
  const create = vi.fn(() => tone);
  const onFinish = vi.fn();
  const hook = renderHook(() =>
    useMelodyPlayback(onFinish, { createTone: create }),
  );
  /** Moves the context clock to `t` (seconds after the first note) and runs one frame. */
  const at = (t: number) =>
    act(() => {
      clock.t = 0.03 + t;
      vi.advanceTimersByTime(16);
    });
  return { hook, tone, create, onFinish, at };
}

describe('useMelodyPlayback', () => {
  it('play schedules the notes from 0 and moves the playhead on the context clock', () => {
    const { hook, tone, at } = setup();
    expect(hook.result.current.playing).toBe(false);
    act(() => hook.result.current.play(plan));
    expect(tone.start).toHaveBeenCalledWith(plan.notes, 0);
    expect(hook.result.current.playing).toBe(true);
    expect(hook.result.current.at).toBe(2);
    at(0.5);
    expect(hook.result.current.at).toBe(2);
    at(1.2);
    expect(hook.result.current.at).toBe(3);
  });

  it('stops by itself at the end and calls onFinish once', () => {
    const { hook, tone, onFinish, at } = setup();
    act(() => hook.result.current.play(plan));
    at(2.01);
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.at).toBeNull();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(tone.stop).toHaveBeenCalled();
    at(3);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('stop() silences the tones at once, without onFinish', () => {
    const { hook, tone, onFinish, at } = setup();
    act(() => hook.result.current.play(plan));
    act(() => hook.result.current.stop());
    expect(tone.stop).toHaveBeenCalled();
    expect(hook.result.current.playing).toBe(false);
    at(5);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('playNote sounds one short tone; one context (created lazily) is closed on unmount', () => {
    const { hook, tone, create } = setup();
    expect(create).not.toHaveBeenCalled();
    act(() => hook.result.current.playNote(69));
    expect(tone.playOne).toHaveBeenCalledWith(440, expect.any(Number));
    const [, sec] = tone.playOne.mock.calls[0] as unknown as [number, number];
    expect(sec).toBeLessThanOrEqual(0.5);
    act(() => hook.result.current.play(plan));
    expect(create).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(tone.close).toHaveBeenCalled();
  });

  it('without Web Audio (the context throws) nothing breaks and it stays stopped', () => {
    const { tone } = fakeTone();
    const broken = {
      ...tone,
      start: vi.fn((): number => {
        throw new ReferenceError('AudioContext is not defined');
      }),
      playOne: vi.fn(() => {
        throw new ReferenceError('AudioContext is not defined');
      }),
    };
    const hook = renderHook(() =>
      useMelodyPlayback(vi.fn(), { createTone: () => broken }),
    );
    act(() => hook.result.current.play(plan));
    expect(hook.result.current.playing).toBe(false);
    expect(() => hook.result.current.playNote(60)).not.toThrow();
  });

  it('a plan without steps plays nothing', () => {
    const { hook, tone } = setup();
    act(() => hook.result.current.play({ notes: [], steps: [], duration: 0 }));
    expect(tone.start).not.toHaveBeenCalled();
    expect(hook.result.current.playing).toBe(false);
  });
});
