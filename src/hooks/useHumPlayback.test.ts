import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TonePlayer } from './tonePlayer';
import { useHumPlayback } from './useHumPlayback';

/** Like a browser: `play` / `pause` events arrive later (a task), `playing` after `play`. */
function fakeAudio() {
  const later = (f: () => void) => setTimeout(f, 0);
  const el = {
    preload: '',
    src: '',
    muted: false,
    paused: true,
    currentTime: 0,
    duration: 8,
    onloadedmetadata: null as (() => void) | null,
    onplay: null as (() => void) | null,
    onplaying: null as (() => void) | null,
    onpause: null as (() => void) | null,
    onended: null as (() => void) | null,
    onseeked: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: vi.fn(() => {
      el.paused = false;
      later(() => {
        el.onplay?.();
        el.onplaying?.();
      });
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      el.paused = true;
      later(() => el.onpause?.());
    }),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  return el;
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

function setup() {
  const el = fakeAudio();
  const tone: TonePlayer = {
    start: vi.fn(),
    stop: vi.fn(),
    playOne: vi.fn(),
    close: vi.fn(),
  };
  const notes = [{ index: 1, start: 1, duration: 0.5, midi: 69, hz: 440 }];
  const file = new Blob(['x']);
  const hook = renderHook(
    ({ n }) =>
      useHumPlayback(file, n, {
        audio: {
          createElement: () => el as unknown as HTMLAudioElement,
          createUrl: () => 'blob:x',
          revokeUrl: () => undefined,
        },
        createTone: () => tone,
      }),
    { initialProps: { n: notes } },
  );
  act(() => el.onloadedmetadata?.());
  return { el, tone, notes, hook };
}

describe('useHumPlayback', () => {
  it('「両方」 (default): the tones start when the recording really plays, from its own second', async () => {
    const { el, tone, notes, hook } = setup();
    expect(hook.result.current.mode).toBe('both');
    act(() => hook.result.current.play(2));
    expect(el.muted).toBe(false);
    expect(tone.start).not.toHaveBeenCalled(); // not before the audio sounds
    el.currentTime = 2.12; // loading took a moment
    await flush();
    expect(tone.start).toHaveBeenCalledWith(notes, 2.12);
    act(() => hook.result.current.pause());
    expect(tone.stop).toHaveBeenCalled();
  });

  it('a seek while playing realigns the tones on `seeked`', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.play(0));
    await flush();
    act(() => hook.result.current.seek(5));
    el.currentTime = 5;
    act(() => el.onseeked?.());
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 5);
  });

  it('「下書き」 plays the recording muted as the clock; 「録音」 has no tones', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.setMode('draft'));
    act(() => hook.result.current.play(0));
    await flush();
    expect(el.muted).toBe(true);
    expect(tone.start).toHaveBeenCalledTimes(1);
    el.currentTime = 3;
    act(() => hook.result.current.setMode('recording'));
    expect(el.muted).toBe(false);
    expect(tone.stop).toHaveBeenCalled();
    act(() => hook.result.current.setMode('both'));
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 3);
  });

  it('a candidate clicked while playing still sounds: the late `pause` and the new draft do not cut it', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.play(0));
    await flush();
    vi.mocked(tone.start).mockClear();
    act(() => hook.result.current.playNote(69, 0.5));
    expect(tone.playOne).toHaveBeenCalledWith(440, 0.5);
    // the choice changes the draft before the element's pause event arrives
    el.currentTime = 1.2;
    hook.rerender({
      n: [{ index: 1, start: 1, duration: 0.5, midi: 70, hz: 466 }],
    });
    await flush();
    expect(hook.result.current.player.playing).toBe(false);
    expect(tone.start).not.toHaveBeenCalled();
  });

  it('a new draft while playing restarts the tones; the end of the recording stops them', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.play(0));
    await flush();
    el.currentTime = 1.5;
    const next = [{ index: 1, start: 1, duration: 1, midi: 70, hz: 466 }];
    hook.rerender({ n: next });
    expect(tone.start).toHaveBeenLastCalledWith(next, 1.5);
    vi.mocked(tone.stop).mockClear();
    act(() => el.onended?.());
    expect(tone.stop).toHaveBeenCalled();
  });

  it('▶ at the end starts over from 0, tones included', async () => {
    const { el, tone, hook } = setup();
    el.currentTime = 8;
    act(() => hook.result.current.play());
    expect(el.currentTime).toBe(0);
    await flush();
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 0);
  });

  it('playRecording plays a segment of the recording only', async () => {
    vi.useFakeTimers();
    const { el, tone, hook } = setup();
    act(() => hook.result.current.playRecording(1, 1.5));
    expect(el.currentTime).toBe(1);
    act(() => vi.advanceTimersByTime(0));
    expect(tone.start).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(el.pause).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
