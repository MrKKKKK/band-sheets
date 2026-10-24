import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
