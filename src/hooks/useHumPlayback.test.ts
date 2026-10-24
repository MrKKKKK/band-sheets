import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TonePlayer } from './tonePlayer';
import { useHumPlayback } from './useHumPlayback';

function fakeAudio() {
  const el = {
    preload: '',
    src: '',
    muted: false,
    currentTime: 0,
    duration: 8,
    onloadedmetadata: null as (() => void) | null,
    onplay: null as (() => void) | null,
    onpause: null as (() => void) | null,
    onended: null as (() => void) | null,
    onseeked: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: vi.fn(() => {
      queueMicrotask(() => el.onplay?.());
      return Promise.resolve();
    }),
    pause: vi.fn(() => el.onpause?.()),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  return el;
}

function setup() {
  const el = fakeAudio();
  const tone: TonePlayer = {
    start: vi.fn(),
    stop: vi.fn(),
    playOne: vi.fn(),
    close: vi.fn(),
  };
  const notes = [{ index: 1, start: 1, duration: 0.5, midi: 69, hz: 440 }];
  const hook = renderHook(
    ({ n }) =>
      useHumPlayback(new Blob(['x']), n, {
        audio: {
          createElement: () => el as unknown as HTMLAudioElement,
          createUrl: () => 'blob:x',
          revokeUrl: () => undefined,
        },
        createTone: () => tone,
      }),
    { initialProps: { n: notes } },
  );
  return { el, tone, notes, hook };
}

describe('useHumPlayback', () => {
  it('「両方」 (default): the recording and the tones from the same second', async () => {
    const { el, tone, notes, hook } = setup();
    expect(hook.result.current.mode).toBe('both');
    await act(async () => hook.result.current.play(2));
    expect(el.muted).toBe(false);
    expect(el.currentTime).toBe(2);
    expect(tone.start).toHaveBeenCalledWith(notes, 2);
    act(() => hook.result.current.pause());
    expect(tone.stop).toHaveBeenCalled();
  });

  it('「下書き」 plays the recording muted as the clock; 「録音」 has no tones', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.setMode('draft'));
    await act(async () => hook.result.current.play(0));
    expect(el.muted).toBe(true);
    expect(tone.start).toHaveBeenCalledTimes(1);
    // switching while playing
    el.currentTime = 3;
    act(() => hook.result.current.setMode('recording'));
    expect(el.muted).toBe(false);
    expect(tone.stop).toHaveBeenCalled();
    act(() => hook.result.current.setMode('both'));
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 3);
  });

  it('a new draft while playing restarts the tones; the end of the recording stops them', async () => {
    const { el, tone, hook } = setup();
    await act(async () => hook.result.current.play(0));
    el.currentTime = 1.5;
    const next = [{ index: 1, start: 1, duration: 1, midi: 70, hz: 466 }];
    hook.rerender({ n: next });
    expect(tone.start).toHaveBeenLastCalledWith(next, 1.5);
    vi.mocked(tone.stop).mockClear();
    act(() => el.onended?.());
    expect(tone.stop).toHaveBeenCalled();
  });

  it('playNote sounds one capped tone; playRecording plays a segment of the recording only', async () => {
    vi.useFakeTimers();
    const { el, tone, hook } = setup();
    act(() => hook.result.current.playNote(69, 4));
    expect(tone.playOne).toHaveBeenCalledWith(440, 1.5);
    await act(async () => hook.result.current.playRecording(1, 1.5));
    expect(el.currentTime).toBe(1);
    expect(el.play).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(el.pause).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
