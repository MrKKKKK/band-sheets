/**
 * The draft's sound on S4 (plan §4, §9 Q8 (a)): a plain Web Audio sine per note, no samples or sound fonts, no
 * network. Times are on the recording's clock (`SoundingNote.start`), so the draft can sound together with the
 * recording ("両方", same loudness as the recording at full volume).
 */
import type { SoundingNote } from '../lib/import/playback';

export interface TonePlayer {
  /** Sounds `notes` from second `fromSec` of the recording's clock, at once; replaces what was scheduled. */
  start(notes: readonly SoundingNote[], fromSec: number): void;
  stop(): void;
  /**
   * One tone now (a candidate that was clicked). Kept apart from the scheduled notes: `start` / `stop` never
   * cut it (only the next `playOne` or `close` does).
   */
  playOne(hz: number, durationSec: number): void;
  close(): void;
}

/** Peak gain of a tone (a sine at 1.0 is much louder than a sung recording). */
export const TONE_GAIN = 0.3;
const RAMP_SEC = 0.012;
/** Scheduling lead, so the first note is not cut. */
const LEAD_SEC = 0.03;

type Ctx = Pick<
  AudioContext,
  | 'currentTime'
  | 'destination'
  | 'createOscillator'
  | 'createGain'
  | 'resume'
  | 'close'
>;

export function createTonePlayer(
  createContext: () => Ctx = () => new AudioContext(),
): TonePlayer {
  let ctx: Ctx | null = null;
  let live: OscillatorNode[] = [];
  let single: OscillatorNode | null = null;

  const context = () => {
    if (!ctx) ctx = createContext();
    void ctx.resume().catch(() => undefined);
    return ctx;
  };

  const tone = (
    c: Ctx,
    hz: number,
    at: number,
    dur: number,
  ): OscillatorNode => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const end = at + Math.max(dur, 2 * RAMP_SEC);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(TONE_GAIN, at + RAMP_SEC);
    gain.gain.setValueAtTime(TONE_GAIN, end - RAMP_SEC);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      live = live.filter((o) => o !== osc);
    };
    osc.start(at);
    osc.stop(end);
    return osc;
  };

  const halt = (o: OscillatorNode) => {
    try {
      o.stop();
    } catch {
      // already stopped
    }
  };

  const stop = () => {
    live.forEach(halt);
    live = [];
  };

  return {
    start(notes, fromSec) {
      stop();
      const c = context();
      const t0 = c.currentTime + LEAD_SEC;
      for (const n of notes) {
        const end = n.start + n.duration;
        if (end <= fromSec) continue;
        const from = Math.max(n.start, fromSec);
        live.push(tone(c, n.hz, t0 + (from - fromSec), end - from));
      }
    },
    stop,
    playOne(hz, durationSec) {
      if (single) halt(single);
      const c = context();
      single = tone(c, hz, c.currentTime + LEAD_SEC, durationSec);
    },
    close() {
      stop();
      if (single) halt(single);
      single = null;
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}
