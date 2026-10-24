import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioPlayer } from './useAudioPlayer';

function fakeAudio() {
  const el = {
    preload: '',
    src: '',
    currentTime: 0,
    duration: 12.5,
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

describe('useAudioPlayer', () => {
  it('plays the file from an object URL and revokes it on unmount', async () => {
    const el = fakeAudio();
    const revokeUrl = vi.fn();
    const file = new Blob(['x']);
    const { result, unmount } = renderHook(() =>
      useAudioPlayer(file, {
        createElement: () => el as unknown as HTMLAudioElement,
        createUrl: () => 'blob:rec',
        revokeUrl,
      }),
    );
    expect(el.src).toBe('blob:rec');
    act(() => el.onloadedmetadata?.());
    expect(result.current.duration).toBe(12.5);

    await act(async () => result.current.play(4));
    expect(el.currentTime).toBe(4);
    expect(el.play).toHaveBeenCalled();
    expect(result.current.playing).toBe(true);

    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(result.current.currentTime).toBe(4);

    unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:rec');
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('reports a file the browser cannot play', () => {
    const el = fakeAudio();
    const { result } = renderHook(() =>
      useAudioPlayer(new Blob(['x']), {
        createElement: () => el as unknown as HTMLAudioElement,
        createUrl: () => 'blob:bad',
        revokeUrl: () => undefined,
      }),
    );
    act(() => el.onerror?.());
    expect(result.current.failed).toBe(true);
  });

  it('does nothing without a file', () => {
    const createElement = vi.fn();
    const { result } = renderHook(() =>
      useAudioPlayer(null, { createElement }),
    );
    expect(createElement).not.toHaveBeenCalled();
    result.current.play();
    expect(result.current.playing).toBe(false);
  });

  describe('while playing', () => {
    afterEach(() => vi.unstubAllGlobals());

    function setup() {
      const frames: (() => void)[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      });
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
      const el = fakeAudio();
      let renders = 0;
      const { result } = renderHook(() => {
        renders++;
        return useAudioPlayer(new Blob(['x']), {
          createElement: () => el as unknown as HTMLAudioElement,
          createUrl: () => 'blob:rec',
          revokeUrl: () => undefined,
        });
      });
      // 2-second bars
      act(() => result.current.setBarResolver((t) => Math.floor(t / 2)));
      const step = (t: number) => {
        el.currentTime = t;
        act(() => frames.shift()?.());
      };
      return { el, result, step, renders: () => renders };
    }

    it('re-renders only when the bar changes or every 250 ms, not every frame', async () => {
      const { el, result, step, renders } = setup();
      await act(async () => result.current.play(0));
      const before = renders();
      // 60 frames of 16 ms inside bar 0 (about 0.96 s): at most 4 time updates
      for (let i = 1; i <= 60; i++) step(i * 0.016);
      expect(renders() - before).toBeLessThanOrEqual(4);
      // crossing into bar 1 updates at once, even within the 250 ms window
      step(1.99);
      const n = renders();
      step(2.001);
      expect(renders()).toBe(n + 1);
      expect(result.current.currentTime).toBe(2.001);
      expect(el.currentTime).toBe(2.001);
    });
  });
});
