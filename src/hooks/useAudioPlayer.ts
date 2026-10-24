/**
 * Plays the picked recording on the review screen S3 (plan sections 4, 5): an <audio> element on an object URL
 * of the File — local only, no network. The URL is revoked when the file changes or the screen unmounts.
 * `currentTime` follows the element on every animation frame while playing (the current bar is highlighted).
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
}

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

  useEffect(() => {
    if (!file) return;
    const d = depsRef.current;
    const el = (d.createElement ?? (() => new Audio()))();
    const url = (d.createUrl ?? ((b: Blob) => URL.createObjectURL(b)))(file);
    let frame = 0;
    const tick = () => {
      setCurrentTime(el.currentTime);
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
      setCurrentTime(el.currentTime);
    };
    el.onended = el.onpause;
    el.onseeked = () => setCurrentTime(el.currentTime);
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

  return { playing, currentTime, duration, failed, play, pause, seek };
}
