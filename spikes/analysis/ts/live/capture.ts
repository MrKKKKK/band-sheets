/**
 * LT2 of the live chord-check tool: the pure logic between the worklet's blocks and the core (used by
 * ts/browser/liveWorker.ts, tested in capture.test.ts).
 *
 * - `Capture`: blocks {frame, data: one Float32Array per channel} (micCheck's message shape, all channels) -> mono ->
 *   22,050 Hz -> `FloatRing`. Blocks of one batch are put on the context frame axis by micCheck's `assembleBlocks`
 *   (gaps = 0, counted); a gap between batches is zero-filled the same way.
 * - `CalibrationCollector`: waits for the input to pass the gate, then hands over the next CALIBRATION_SEC of audio once.
 * - `latestWindow`: the newest window, always lagging WAIT_SEC (its analysed signal ends at "now").
 */
import { toMono } from '../dsp/core/resample';
import { assembleBlocks } from '../browser/micCheck';
import { ANALYZER_SR, GATE_DBFS, WAIT_SEC } from './core';
import { FloatRing, StreamResampler } from './ring';

/** Seconds the session's tuning and gain are measured on (plan 1.3). */
export const CALIBRATION_SEC = 3;
/** The ring holds this much 22,050 Hz audio: the longest window (3 s) + 2 x 0.8 s, and the calibration span, with room. */
export const RING_SEC = 8;
/** Longest window the page offers (s). */
export const MAX_WINDOW_SEC = 3;

export interface ChannelBlock {
  /** the context frame of data[c][0] */
  frame: number;
  data: Float32Array[];
}

export class Capture {
  readonly ring = new FloatRing(RING_SEC * ANALYZER_SR);
  /** frames the worklet never delivered (filled with 0), in device-rate frames */
  gapFrames = 0;
  private readonly resampler: StreamResampler;
  private nextFrame: number | null = null;

  constructor(readonly deviceRate: number) {
    this.resampler = new StreamResampler(deviceRate, ANALYZER_SR);
  }

  /** Takes one batch of blocks (any order); returns when the samples are in `ring` (the resampler's context wait aside). */
  ingest(blocks: readonly ChannelBlock[]): void {
    if (blocks.length === 0) return;
    const channels = blocks[0].data.length;
    const rec = Array.from({ length: channels }, (_, c) => assembleBlocks(blocks.map((b) => ({ frame: b.frame, data: b.data[c] }))));
    let mono = toMono(rec.map((r) => r.samples));
    this.gapFrames += rec[0].gapFrames;
    let start = rec[0].startFrame;
    if (this.nextFrame !== null) {
      if (start > this.nextFrame) {
        this.gapFrames += start - this.nextFrame;
        this.feed(new Float32Array(start - this.nextFrame));
      } else if (start < this.nextFrame) {
        const skip = Math.min(mono.length, this.nextFrame - start); // late duplicate: already have it
        mono = mono.subarray(skip);
        start += skip;
      }
    }
    this.nextFrame = start + mono.length;
    this.feed(mono);
  }

  private feed(mono: Float32Array): void {
    const out = this.resampler.push(mono);
    if (out.length) this.ring.push(out);
  }
}

const HOP_SEC = 0.1;

/** After the input first reaches the gate: collect the next `seconds`, once. `reset()` starts waiting again (測り直す). */
export class CalibrationCollector {
  private scanned: number | null = null;
  private onset: number | null = null;

  constructor(
    private readonly gateDb = GATE_DBFS,
    private readonly seconds = CALIBRATION_SEC,
    private readonly sr = ANALYZER_SR,
  ) {}

  reset(): void {
    this.scanned = null;
    this.onset = null;
  }

  /** Seconds collected so far (0 while waiting for the gate). */
  progress(ring: FloatRing): number {
    return this.onset === null ? 0 : Math.min(this.seconds, (ring.end - this.onset) / this.sr);
  }

  /** The `seconds` of audio from the gate crossing once the ring has them, else null. Call after every ring update. */
  feed(ring: FloatRing): Float32Array | null {
    const hop = Math.round(HOP_SEC * this.sr);
    if (this.onset === null) {
      this.scanned ??= ring.end; // audio from before the start / reset does not count
      while (this.scanned + hop <= ring.end) {
        const h = ring.slice(this.scanned, this.scanned + hop);
        let e = 0;
        for (const v of h) e += v * v;
        if (10 * Math.log10(e / hop + 1e-20) >= this.gateDb) {
          this.onset = this.scanned;
          break;
        }
        this.scanned += hop;
      }
    }
    const n = Math.round(this.seconds * this.sr);
    if (this.onset === null || ring.end < this.onset + n) return null;
    if (this.onset < ring.start) {
      this.reset(); // fell out of the ring (a stalled loop): wait for the gate again
      return null;
    }
    const y = ring.slice(this.onset, this.onset + n);
    this.reset();
    return y;
  }
}

export interface WindowPick {
  /** absolute sample range of the analysed signal (window + WAIT_SEC on each side) */
  from: number;
  to: number;
  /** the window inside it, in seconds (core.ts WindowCtx) */
  colStart: number;
  colEnd: number;
}

/** The newest window of `windowSec`: its analysed signal ends at the newest sample, the window ends WAIT_SEC before. Null until the ring holds enough. */
export function latestWindow(ring: FloatRing, windowSec: number, sr = ANALYZER_SR): WindowPick | null {
  const to = ring.end;
  const from = to - Math.round((windowSec + 2 * WAIT_SEC) * sr);
  if (from < ring.start) return null;
  return { from, to, colStart: WAIT_SEC, colEnd: WAIT_SEC + windowSec };
}
