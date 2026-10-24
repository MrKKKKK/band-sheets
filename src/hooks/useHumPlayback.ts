/**
 * S4's listening comparison (plan §4 「D2 で決めたこと」): the recording (an <audio>, useAudioPlayer), the
 * draft as sine tones (tonePlayer.ts), or both at once. The recording is always the clock: for 「下書き」 it plays
 * muted, so the cursor, the seek bar and the tones stay on one time line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { midiToHz, type SoundingNote } from '../lib/import/playback';
import { createTonePlayer, type TonePlayer } from './tonePlayer';
import {
  useAudioPlayer,
  type AudioPlayer,
  type AudioPlayerDeps,
} from './useAudioPlayer';

export type ListenMode = 'recording' | 'draft' | 'both';

export interface HumPlayback {
  player: AudioPlayer;
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
  const segmentRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tone = useCallback(() => {
    toneRef.current ??= createToneRef.current();
    return toneRef.current;
  }, []);
  const { playing, now, setMuted } = player;

  const clearSegment = () => {
    if (segmentRef.current !== null) clearTimeout(segmentRef.current);
    segmentRef.current = null;
  };

  const sound = useCallback(
    (m: ListenMode, from: number) => {
      setMuted(m === 'draft');
      if (m === 'recording') tone().stop();
      else tone().start(notesRef.current, from);
    },
    [setMuted, tone],
  );

  // The recording stopped (pause, end, error): so do the tones.
  useEffect(() => {
    if (!playing) toneRef.current?.stop();
  }, [playing]);

  // A fix applied while playing: the tones follow the new draft.
  useEffect(() => {
    notesRef.current = notes;
    if (playing && mode !== 'recording') tone().start(notes, now());
    // only on a new draft, not on every play/pause
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(
    () => () => {
      clearSegment();
      toneRef.current?.close();
    },
    [],
  );

  const play = (fromSec?: number) => {
    clearSegment();
    const from = fromSec ?? now();
    sound(mode, from);
    player.play(from);
  };
  const pause = () => {
    clearSegment();
    player.pause();
    toneRef.current?.stop();
  };
  const seek = (sec: number) => {
    player.seek(sec);
    if (playing && mode !== 'recording') tone().start(notesRef.current, sec);
  };
  const setMode = (m: ListenMode) => {
    setModeState(m);
    if (playing) sound(m, now());
  };
  const playNote = (midi: number, durationSec: number) => {
    if (playing) pause();
    tone().playOne(midiToHz(midi), Math.min(durationSec, MAX_NOTE_SEC));
  };
  const playRecording = (from: number, to: number) => {
    clearSegment();
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
