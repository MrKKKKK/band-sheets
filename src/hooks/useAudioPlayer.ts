/**
 * Plays the picked recording on the review screen S3 (plan sections 4, 5): an <audio> element on an object URL
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
    el.onloadedmetadata = () =>
      setDuration(Number.isFinite(el.duration) ? el.duration : null);
    el.onplay = () => {
      setPlaying(true);
      stopTicking();
      frame = requestAnimationFrame(tick);
    };
    el.onpause = () => {
      setPlaying(false);
      stopTicking();
      show();
    };
    el.onended = el.onpause;
    el.onseeked = show;
    el.onerror = () => {
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
    setBarResolver,
  };
}
