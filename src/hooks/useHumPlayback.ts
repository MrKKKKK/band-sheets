/**
 * S4's listening comparison (plan §4 「D2 で決めたこと」): the recording (an <audio>, useAudioPlayer), the
 * draft as sine tones (tonePlayer.ts), or both at once. The recording is always the clock: for 「下書き」 it plays
 * muted, so the cursor, the seek bar and the tones stay on one time line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { midiToHz, type SoundingNote } from '../lib/playback';
import { createTonePlayer } from './tonePlayer';
import type { TonePlayer } from './tonePlayer.types';
import {
  useAudioPlayer,
  type AudioPlayerView,
  type AudioPlayerDeps,
} from './useAudioPlayer';

export type ListenMode = 'recording' | 'draft' | 'both';

export interface HumPlayback {
  player: AudioPlayerView;
  mode: ListenMode;
  setMode(mode: ListenMode): void;
  /** From `fromSec` (default: where it is). */
  play(fromSec?: number): void;
  pause(): void;
  seek(sec: number): void;
  /** One draft tone (a candidate), at once. */
  playNote(midi: number, durationSec: number): void;
  /** The recording alone from `from` to `to` seconds (「録音のここ」). */
  playRecording(from: number, to: number): void;
}

/** A clicked candidate sounds at most this long. */
const MAX_NOTE_SEC = 1.5;
/** 「at the end」 for ▶ (seconds). */
const END_EPS = 0.05;

export function useHumPlayback(
  file: Blob | null,
  notes: readonly SoundingNote[],
  deps: { audio?: AudioPlayerDeps; createTone?: () => TonePlayer } = {},
): HumPlayback {
  const player = useAudioPlayer(file, deps.audio);
  const [mode, setModeState] = useState<ListenMode>('both');
  const toneRef = useRef<TonePlayer | null>(null);
  const createToneRef = useRef(deps.createTone ?? (() => createTonePlayer()));
  const notesRef = useRef(notes);
  const modeRef = useRef(mode);
  /**
   * Playing as far as the tones are concerned. Set at once by play() / pause(): the element's `pause` event
   * (and so `player.playing`) comes later, and a candidate's tone must not be rescheduled away meanwhile.
   */
  const playingRef = useRef(false);
  const segmentRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tone = useCallback(() => {
    toneRef.current ??= createToneRef.current();
    return toneRef.current;
  }, []);
  const { playing, now, setMuted, setSyncListener } = player;

  const clearSegment = () => {
    if (segmentRef.current !== null) clearTimeout(segmentRef.current);
    segmentRef.current = null;
  };

  /** The tones from second `at` of the recording (or none for 「録音」). */
  const align = useCallback(
    (at: number) => {
      if (!playingRef.current || modeRef.current === 'recording') return;
      try {
        tone().start(notesRef.current, at);
      } catch {
        // no Web Audio here: the recording plays on, the draft stays silent
      }
    },
    [tone],
  );

  // The tones start when the recording really sounds (`playing`) and follow seeks, from its own clock.
  useEffect(() => {
    setSyncListener(align);
    return () => setSyncListener(null);
  }, [setSyncListener, align]);

  // The recording stopped (pause, end, error): so do the tones.
  useEffect(() => {
    if (playing) return;
    playingRef.current = false;
    toneRef.current?.stop();
  }, [playing]);

  // A fix applied while playing: the tones follow the new draft.
  useEffect(() => {
    notesRef.current = notes;
    if (playingRef.current) align(now());
  }, [notes, align, now]);

  useEffect(
    () => () => {
      clearSegment();
      toneRef.current?.close();
    },
    [],
  );

  const play = (fromSec?: number) => {
    clearSegment();
    let from = fromSec ?? now();
    // at the end: start over (the <audio> does, so must the tones)
    if (player.duration !== null && from >= player.duration - END_EPS) from = 0;
    playingRef.current = true;
    setMuted(mode === 'draft');
    toneRef.current?.stop();
    player.play(from);
  };
  const pause = () => {
    clearSegment();
    playingRef.current = false;
    player.pause();
    toneRef.current?.stop();
  };
  const seek = (sec: number) => player.seek(sec);
  const setMode = (m: ListenMode) => {
    setModeState(m);
    modeRef.current = m;
    if (!playingRef.current) return;
    setMuted(m === 'draft');
    if (m === 'recording') toneRef.current?.stop();
    else align(now());
  };
  const playNote = (midi: number, durationSec: number) => {
    if (playingRef.current || playing) pause();
    try {
      tone().playOne(midiToHz(midi), Math.min(durationSec, MAX_NOTE_SEC));
    } catch {
      // no Web Audio here: the candidate is applied all the same, silently
    }
  };
  const playRecording = (from: number, to: number) => {
    clearSegment();
    playingRef.current = false;
    toneRef.current?.stop();
    setMuted(false);
    player.play(from);
    segmentRef.current = setTimeout(
      () => {
        segmentRef.current = null;
        player.pause();
      },
      Math.max(0, to - from) * 1000,
    );
  };

  return { player, mode, setMode, play, pause, seek, playNote, playRecording };
}
