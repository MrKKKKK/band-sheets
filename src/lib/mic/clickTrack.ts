/**
 * The metronome of the microphone recording (docs/mic-recording-plan.md §2.4): when every click
 * sounds, which one is the downbeat, where the recording is "now" (bar / beat) and the click as
 * samples / as notes for the review screen's playback.
 *
 * Clock: second 0 = the first beat of the one-bar count-in = the file's 0 s. Bar 0 is the count-in,
 * bar 1 is the song's first bar (it starts at `barSec`). The tempo is ♩ per minute (the song's
 * `{tempo}`); a beat is `beatTicksOf(ts)` ticks, so 6/8 clicks on eighths (twice the ♩ rate).
 */

import type { TimeSig } from '../melody';
import { midiToHz, type SoundingNote } from '../playback';

/** One click: `bar` 0 = count-in, 1.. = the song's bars; `beat` is 1-based. */
export interface ClickBeat {
  /** seconds from the count-in's first beat */
  sec: number;
  bar: number;
  beat: number;
  /** the first beat of a bar (higher click) */
  strong: boolean;
}

function check(tempo: number, ts: TimeSig): void {
  if (!(Number.isFinite(tempo) && tempo > 0))
    throw new RangeError(`invalid tempo: ${tempo}`);
  if (
    !(Number.isInteger(ts.num) && ts.num > 0) ||
    !(Number.isInteger(ts.den) && ts.den > 0)
  )
    throw new RangeError(`invalid time signature: ${ts.num}/${ts.den}`);
}

/** Seconds per click: ♩ = `tempo`, a beat is a 1/`den` note. */
export function beatSec(tempo: number, ts: TimeSig): number {
  check(tempo, ts);
  return ((60 / tempo) * 4) / ts.den;
}

/** One bar in seconds; also the count-in's length and the song's first bar's start (`bar1Sec`). */
export function barSec(tempo: number, ts: TimeSig): number {
  return beatSec(tempo, ts) * ts.num;
}

/**
 * Every click of a take, the count-in bar included, scheduled in one go: all beats that start
 * before the file reaches `maxFileSec` (about 1200 at 120 bpm for 10 minutes).
 */
export function clickBeats(
  tempo: number,
  ts: TimeSig,
  maxFileSec: number,
): ClickBeat[] {
  const step = beatSec(tempo, ts);
  const out: ClickBeat[] = [];
  if (!(maxFileSec > 0)) return out;
  for (let i = 0; i * step < maxFileSec; i++) {
    const inBar = i % ts.num;
    out.push({
      sec: i * step,
      bar: Math.floor(i / ts.num),
      beat: inBar + 1,
      strong: inBar === 0,
    });
  }
  return out;
}

export interface ClickPosition {
  /** 0 = count-in */
  bar: number;
  beat: number;
}

/** The bar / beat at `sinceCountInSec` = seconds since the COUNT-IN's first beat (not since bar 1; negative reads as 0). */
export function positionAt(
  sinceCountInSec: number,
  tempo: number,
  ts: TimeSig,
): ClickPosition {
  const step = beatSec(tempo, ts);
  const t =
    Number.isFinite(sinceCountInSec) && sinceCountInSec > 0
      ? sinceCountInSec
      : 0;
  // the epsilon keeps a time that is exactly on a beat (up to float error) on that beat
  const n = Math.floor(t / step + 1e-9);
  return { bar: Math.floor(n / ts.num), beat: (n % ts.num) + 1 };
}

const SOFT_HZ = 1000;
const SOFT_STRONG_HZ = 1500;
const SOFT_ATTACK_SEC = 0.0015;
const SOFT_DECAY_TAU_SEC = 0.015; // e^-(0.06/0.015) ~ 1.8% at the end
const SOFT_TOTAL_SEC = 0.06;

/**
 * The click of the count-in, the recording and the latency measurement: a sine (1 kHz, the downbeat
 * 1.5 kHz) with a 1.5 ms linear attack and an exponential decay, 60 ms long, peak 0.5. Gentle to the
 * ears; `detectClicks` finds its onset ~0.7 ms after the true start (latency.ts).
 */
export function softClickSamples(
  sampleRate: number,
  strong = false,
  amplitude = 0.5,
): Float32Array<ArrayBuffer> {
  const n = Math.max(8, Math.round(sampleRate * SOFT_TOTAL_SEC));
  const attack = Math.max(1, Math.round(sampleRate * SOFT_ATTACK_SEC));
  const hz = strong ? SOFT_STRONG_HZ : SOFT_HZ;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env =
      i < attack
        ? (i + 1) / attack
        : Math.exp(-(i - attack) / (sampleRate * SOFT_DECAY_TAU_SEC));
    // sin(0) = 0 would make the first sample silent; the attack ramp already starts near 0
    out[i] = amplitude * env * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

const CLICK_NOTE_SEC = 0.05;
const STRONG_MIDI = 88;
const WEAK_MIDI = 81;

/** The clicks as notes for the tone player (review screen, 「クリックあり」); `index` = the click's index. */
export function clickNotes(beats: readonly ClickBeat[]): SoundingNote[] {
  return beats.map((b, index) => {
    const midi = b.strong ? STRONG_MIDI : WEAK_MIDI;
    return {
      index,
      start: b.sec,
      duration: CLICK_NOTE_SEC,
      midi,
      hz: midiToHz(midi),
    };
  });
}
