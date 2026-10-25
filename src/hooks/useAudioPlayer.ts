/**
 * Plays the picked recording on the review screens S3 / S4 (plan sections 4, 5): an <audio> element on an object URL
 * of the File — local only, no network. The URL is revoked when the file changes or the screen unmounts.
 * While playing, `currentTime` is checked on every animation frame but the state is only set when the bar
 * (from `setBarResolver`) changes or every `TIME_STEP_SEC`, so the screen does not re-render at 60 fps.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AudioPlayer {
  playing: boolean;
  /** Seconds. */
  currentTime: number;
  /** Seconds, null until the metadata is read. */
  duration: number | null;
  /** The browser cannot play this file. */
  failed: boolean;
  /** Starts (from `fromSec` when given). */
  play(fromSec?: number): void;
  pause(): void;
  seek(sec: number): void;
  /** The element's exact current second (the `currentTime` state moves only at ~4 Hz). */
  now(): number;
  /** Silences the recording while it keeps playing (S4 「下書き」: the recording is then only the clock). */
  setMuted(muted: boolean): void;
  /**
   * Called with the element's exact second when the sound really starts (`playing`) or moves while it sounds
   * (`seeked` without a `waiting` before it): S4 aligns the draft tones to it (null = none). Once per start or
   * seek, never before the sound.
   */
  setSyncListener(fn: ((sec: number) => void) | null): void;
  /** Tells the player which bar a time is in, so it updates at once when the bar changes (null = none). */
  setBarResolver(fn: ((sec: number) => number | null) | null): void;
}

/** The displayed time (seek bar, clock) moves at about 4 Hz. */
const TIME_STEP_SEC = 0.25;

export interface AudioPlayerDeps {
  createElement?: () => HTMLAudioElement;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export function useAudioPlayer(
  file: Blob | null,
  deps: AudioPlayerDeps = {},
): AudioPlayer {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const depsRef = useRef(deps);
  const barRef = useRef<((sec: number) => number | null) | null>(null);
  const mutedRef = useRef(false);
  const syncRef = useRef<((sec: number) => void) | null>(null);

  useEffect(() => {
    if (!file) return;
    const d = depsRef.current;
    let el: HTMLAudioElement;
    let url: string;
    try {
      el = (d.createElement ?? (() => new Audio()))();
      url = (d.createUrl ?? ((b: Blob) => URL.createObjectURL(b)))(file);
    } catch {
      // no media support here (e.g. jsdom): the screen still works without playback
      queueMicrotask(() => setFailed(true));
      return;
    }
    let frame = 0;
    let shown = 0;
    let shownBar: number | null = null;
    const show = () => {
      shown = el.currentTime;
      shownBar = barRef.current?.(shown) ?? null;
      setCurrentTime(shown);
    };
    const tick = () => {
      const t = el.currentTime;
      if (
        Math.abs(t - shown) >= TIME_STEP_SEC ||
        (barRef.current?.(t) ?? null) !== shownBar
      )
        show();
      frame = requestAnimationFrame(tick);
    };
    const stopTicking = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    el.preload = 'metadata';
    el.muted = mutedRef.current;
    el.onloadedmetadata = () =>
      setDuration(Number.isFinite(el.duration) ? el.duration : null);
    el.onplay = () => {
      setPlaying(true);
      stopTicking();
      frame = requestAnimationFrame(tick);
    };
    // Sounding = `playing` arrived and nothing has stopped the sound since. A seek while playing sends
    // `waiting` → `seeked` → `playing` (Chromium), and so does ▶ from a second: syncing at `seeked` too would start
    // the draft tones twice, and before the sound. A browser without `waiting` keeps the `seeked` sync.
    let sounding = false;
    el.onpause = () => {
      sounding = false;
      setPlaying(false);
      stopTicking();
      show();
    };
    el.onended = el.onpause;
    el.onwaiting = () => {
      sounding = false;
    };
    el.onplaying = () => {
      sounding = true;
      syncRef.current?.(el.currentTime);
    };
    el.onseeked = () => {
      show();
      if (sounding && !el.paused) syncRef.current?.(el.currentTime);
    };
    el.onerror = () => {
      sounding = false;
      setFailed(true);
      setPlaying(false);
      stopTicking();
    };
    el.src = url;
    elRef.current = el;
    return () => {
      stopTicking();
      el.onloadedmetadata = null;
      el.onplay = null;
      el.onpause = null;
      el.onended = null;
      el.onseeked = null;
      el.onplaying = null;
      el.onwaiting = null;
      el.onerror = null;
      el.pause();
      el.removeAttribute('src');
      el.load();
      (d.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u)))(url);
      if (elRef.current === el) elRef.current = null;
    };
  }, [file]);

  const play = useCallback((fromSec?: number) => {
    const el = elRef.current;
    if (!el) return;
    if (fromSec !== undefined) {
      el.currentTime = Math.max(0, fromSec);
      setCurrentTime(el.currentTime);
    }
    void el.play()?.catch(() => setPlaying(false));
  }, []);
  const pause = useCallback(() => elRef.current?.pause(), []);
  const seek = useCallback((sec: number) => {
    const el = elRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    setCurrentTime(el.currentTime);
  }, []);

  const now = useCallback(() => elRef.current?.currentTime ?? 0, []);
  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    if (elRef.current) elRef.current.muted = muted;
  }, []);

  const setSyncListener = useCallback((fn: ((sec: number) => void) | null) => {
    syncRef.current = fn;
  }, []);

  const setBarResolver = useCallback(
    (fn: ((sec: number) => number | null) | null) => {
      barRef.current = fn;
    },
    [],
  );

  return {
    playing,
    currentTime,
    duration,
    failed,
    play,
    pause,
    seek,
    now,
    setMuted,
    setSyncListener,
    setBarResolver,
  };
}
