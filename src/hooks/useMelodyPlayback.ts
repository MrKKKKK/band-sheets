/**
 * The melody editor's playback (lib/melodyPlayback.ts plans it): sine tones through the same `tonePlayer` as
 * S4, but with no recording the clock is the AudioContext itself (`TonePlayer.now()`), read once per animation
 * frame to move the playhead. The context is made on the first play / note (a user gesture) and closed on
 * unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { midiToHz } from '../lib/import/playback';
import { stepAt, type PlaybackPlan } from '../lib/melodyPlayback';
import { createTonePlayer, type TonePlayer } from './tonePlayer';

export interface MelodyPlayback {
  /** The event under the playhead (a rest too) while playing, else null. */
  at: number | null;
  playing: boolean;
  /** Plays `plan` from its start; replaces what is playing. False when nothing could start. */
  play(plan: PlaybackPlan): boolean;
  /** Stops at once (no `onFinish`). */
  stop(): void;
  /** One short tone now (a note just entered or re-pitched). */
  playNote(midi: number): void;
}

/** Length of the tone of an entered note (seconds). */
export const NOTE_PREVIEW_SEC = 0.35;

export function useMelodyPlayback(
  /** Called when the plan played to its end (not on `stop`). */
  onFinish: () => void,
  deps: { createTone?: () => TonePlayer } = {},
): MelodyPlayback {
  const [at, setAt] = useState<number | null>(null);
  const toneRef = useRef<TonePlayer | null>(null);
  const createToneRef = useRef(deps.createTone ?? (() => createTonePlayer()));
  const frameRef = useRef<number | null>(null);
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  const tone = useCallback(() => {
    toneRef.current ??= createToneRef.current();
    return toneRef.current;
  }, []);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    toneRef.current?.stop();
    setAt(null);
  }, []);

  const play = useCallback(
    (plan: PlaybackPlan) => {
      stop();
      if (plan.steps.length === 0) return false;
      const t = tone();
      let t0: number;
      try {
        t0 = t.start(plan.notes, 0);
      } catch {
        return false; // no Web Audio here (e.g. jsdom): stay stopped rather than break the editor
      }
      setAt(plan.steps[0].index);
      const frame = () => {
        const i = stepAt(plan, Math.max(0, t.now() - t0));
        if (i === null) {
          stop();
          onFinishRef.current();
          return;
        }
        setAt(i);
        frameRef.current = requestAnimationFrame(frame);
      };
      frameRef.current = requestAnimationFrame(frame);
      return true;
    },
    [stop, tone],
  );

  const playNote = useCallback(
    (midi: number) => {
      try {
        tone().playOne(midiToHz(midi), NOTE_PREVIEW_SEC);
      } catch {
        // no Web Audio here: the note is entered all the same
      }
    },
    [tone],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      toneRef.current?.close();
      toneRef.current = null;
    },
    [],
  );

  return { at, playing: at !== null, play, stop, playNote };
}
