import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeAudio } from './testing/fakeAudio';
import type { TonePlayer } from './tonePlayer.types';
import { useHumPlayback } from './useHumPlayback';

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

function setup({ loaded = true } = {}) {
  const el = fakeAudio();
  const tone: TonePlayer = {
    start: vi.fn(() => 0),
    stop: vi.fn(),
    playOne: vi.fn(),
    close: vi.fn(),
    now: () => 0,
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
  if (loaded) act(() => el.loadMetadata());
  return { el, tone, notes, hook };
}

/** Records `tone.start` in the element's event log, so a test can see what it came after. */
function logStarts(el: ReturnType<typeof fakeAudio>, tone: TonePlayer) {
  vi.mocked(tone.start).mockImplementation(() => {
    el.log.push('tone.start');
    return 0;
  });
  return () => el.log.filter((e) => e === 'tone.start').length;
}

describe('useHumPlayback', () => {
  describe('the browser sends `seeked` before `playing` (Chromium)', () => {
    it('▶ from a second starts the tones once, at `playing`', async () => {
      const { el, tone, hook } = setup();
      const starts = logStarts(el, tone);
      act(() => hook.result.current.play(2));
      await flush();
      expect(el.log).toContain('seeked');
      expect(starts()).toBe(1);
      expect(el.log.indexOf('tone.start')).toBeGreaterThan(
        el.log.indexOf('playing'),
      );
    });

    it('▶ before the metadata is read starts the tones once, at `playing`', async () => {
      const { el, tone, hook } = setup({ loaded: false });
      const starts = logStarts(el, tone);
      act(() => hook.result.current.play(2));
      await flush();
      act(() => el.loadMetadata());
      await flush();
      expect(starts()).toBe(1);
      expect(el.log.indexOf('tone.start')).toBeGreaterThan(
        el.log.indexOf('playing'),
      );
    });

    it('a seek while playing restarts the tones once', async () => {
      const { el, tone, hook } = setup();
      const starts = logStarts(el, tone);
      act(() => hook.result.current.play(0));
      await flush();
      el.log.length = 0;
      act(() => hook.result.current.seek(5));
      await flush();
      expect(el.log).toContain('seeked');
      expect(starts()).toBe(1);
      expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 5);
    });
  });

  it('「両方」 (default): the tones start when the recording really plays, from its own second', async () => {
    const { el, tone, notes, hook } = setup();
    expect(hook.result.current.mode).toBe('both');
    act(() => hook.result.current.play(2));
    expect(el.muted).toBe(false);
    expect(tone.start).not.toHaveBeenCalled(); // not before the audio sounds
    el.advance(2.12); // loading took a moment
    await flush();
    expect(tone.start).toHaveBeenCalledWith(notes, 2.12);
    act(() => hook.result.current.pause());
    expect(tone.stop).toHaveBeenCalled();
  });

  it('a seek while playing realigns the tones', async () => {
    const { tone, hook } = setup();
    act(() => hook.result.current.play(0));
    await flush();
    act(() => hook.result.current.seek(5));
    await flush();
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 5);
  });

  it('「下書き」 plays the recording muted as the clock; 「録音」 has no tones', async () => {
    const { el, tone, hook } = setup();
    act(() => hook.result.current.setMode('draft'));
    act(() => hook.result.current.play(0));
    await flush();
    expect(el.muted).toBe(true);
    expect(tone.start).toHaveBeenCalledTimes(1);
    el.advance(3);
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
    el.advance(1.2);
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
    el.advance(1.5);
    const next = [{ index: 1, start: 1, duration: 1, midi: 70, hz: 466 }];
    hook.rerender({ n: next });
    expect(tone.start).toHaveBeenLastCalledWith(next, 1.5);
    vi.mocked(tone.stop).mockClear();
    el.end();
    await flush();
    expect(tone.stop).toHaveBeenCalled();
  });

  it('▶ at the end starts over from 0, tones included', async () => {
    const { el, tone, hook } = setup();
    el.advance(8);
    act(() => hook.result.current.play());
    expect(el.currentTime).toBe(0);
    await flush();
    expect(tone.start).toHaveBeenLastCalledWith(expect.anything(), 0);
  });

  it('without Web Audio, ▶ and a candidate stay silent instead of throwing', async () => {
    const { el, tone, hook } = setup();
    const noAudio = () => {
      throw new Error('no AudioContext');
    };
    vi.mocked(tone.start).mockImplementation(noAudio);
    vi.mocked(tone.playOne).mockImplementation(noAudio);
    act(() => hook.result.current.play(0));
    await flush();
    expect(tone.start).toHaveBeenCalled();
    expect(el.paused).toBe(false); // the recording plays on
    expect(() =>
      act(() => hook.result.current.playNote(69, 0.5)),
    ).not.toThrow();
    expect(tone.playOne).toHaveBeenCalled();
  });

  it('playRecording plays a segment of the recording only', async () => {
    vi.useFakeTimers();
    const { el, tone, hook } = setup();
    act(() => hook.result.current.playRecording(1, 1.5));
    expect(el.currentTime).toBe(1);
    act(() => vi.advanceTimersByTime(0));
    expect(tone.start).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(el.paused).toBe(true);
    vi.useRealTimers();
  });
});
