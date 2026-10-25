import type { SoundingNote } from '../lib/playback';

/**
 * `start` and `playOne` create the AudioContext on first use and THROW where Web Audio is unavailable (e.g. jsdom,
 * a browser without it): callers catch and stay silent. `now`, `stop` and `close` never throw.
 */
export interface TonePlayer {
  /**
   * Sounds `notes` from second `fromSec` of the recording's clock, at once; replaces what was scheduled. Returns
   * the context time (`now()`) at which `fromSec` sounds, for a caller whose clock is the context itself (the
   * melody editor's playback).
   */
  start(notes: readonly SoundingNote[], fromSec: number): number;
  /** The audio context's clock in seconds (0 before the first sound). */
  now(): number;
  stop(): void;
  /**
   * One tone now (a candidate that was clicked). Kept apart from the scheduled notes: `start` / `stop` never
   * cut it (only the next `playOne` or `close` does).
   */
  playOne(hz: number, durationSec: number): void;
  close(): void;
}
