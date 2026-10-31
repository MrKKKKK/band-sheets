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

/** The bar / beat at `elapsedSec` from the count-in's start (negative reads as 0). */
export function positionAt(
  elapsedSec: number,
  tempo: number,
  ts: TimeSig,
): ClickPosition {
  const step = beatSec(tempo, ts);
  const t = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
  // the epsilon keeps a time that is exactly on a beat (up to float error) on that beat
  const n = Math.floor(t / step + 1e-9);
  return { bar: Math.floor(n / ts.num), beat: (n % ts.num) + 1 };
}

const CLICK_HZ = 4000;
const STRONG_CLICK_HZ = 6000;

/**
 * The click: a 2 ms burst of a square wave with a short fade; the downbeat is higher. The normal
 * click is also what the latency measurement plays.
 */
export function clickSamples(
  sampleRate: number,
  strong = false,
  amplitude = 0.9,
): Float32Array<ArrayBuffer> {
  const n = Math.max(8, Math.round(sampleRate * 0.002));
  const period = Math.max(
    2,
    Math.round(sampleRate / (strong ? STRONG_CLICK_HZ : CLICK_HZ)),
  );
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - i) / (n * 0.3));
    out[i] = (Math.floor((2 * i) / period) % 2 ? -1 : 1) * amplitude * fade;
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
