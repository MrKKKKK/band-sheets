import { describe, expect, it } from 'vitest';
import { ANALYZER_SR, GATE_DBFS, WAIT_SEC } from './core';
import { CALIBRATION_SEC, Capture, CalibrationCollector, latestWindow, type ChannelBlock } from './capture';
import { FloatRing } from './ring';

const SR = 48000;
const tone = (n: number, off: number, amp: number): Float32Array => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * (off + i)) / SR));
/** `n` frames from `frame` as 128-frame stereo blocks (right channel = left) */
function blocks(frame: number, n: number, amp: number): ChannelBlock[] {
  const out: ChannelBlock[] = [];
  for (let f = frame; f < frame + n; f += 128) out.push({ frame: f, data: [tone(128, f, amp), tone(128, f, amp)] });
  return out;
}

describe('Capture', () => {
  it('resamples mono blocks into the ring at 22,050 Hz', () => {
    const c = new Capture(SR);
    c.ingest(blocks(0, SR, 0.1));
    expect(c.gapFrames).toBe(0);
    expect(Math.abs(c.ring.end - ANALYZER_SR)).toBeLessThan(400); // minus the context wait
  });
  it('fills a hole inside a batch and between batches with zeros and counts it', () => {
    const c = new Capture(SR);
    const a = blocks(0, 128 * 40, 0.1);
    a.splice(10, 2); // 2 blocks missing in the middle
    c.ingest(a);
    expect(c.gapFrames).toBe(256);
    c.ingest(blocks(128 * 50, 128 * 10, 0.1)); // 10 blocks missing before this batch
    expect(c.gapFrames).toBe(256 + 1280);
  });
  it('ignores blocks it already has', () => {
    const c = new Capture(SR);
    c.ingest(blocks(0, 128 * 100, 0.1));
    const end = c.ring.end;
    c.ingest(blocks(0, 128 * 50, 0.1));
    expect(c.ring.end).toBe(end);
    expect(c.gapFrames).toBe(0);
  });
});

describe('CalibrationCollector', () => {
  const quiet = (s: number) => new Float32Array(Math.round(s * ANALYZER_SR));
  const loud = (s: number) => Float32Array.from({ length: Math.round(s * ANALYZER_SR) }, (_, i) => 0.1 * Math.sin(i));
  it('waits for the gate, then returns exactly the next 3 s from the crossing, once', () => {
    const ring = new FloatRing(8 * ANALYZER_SR);
    const col = new CalibrationCollector();
    ring.push(quiet(2));
    expect(col.feed(ring)).toBeNull();
    expect(col.progress(ring)).toBe(0);
    ring.push(loud(1.5));
    expect(col.feed(ring)).toBeNull();
    expect(col.progress(ring)).toBeCloseTo(1.5, 1);
    ring.push(loud(2));
    const y = col.feed(ring)!;
    expect(y.length).toBe(CALIBRATION_SEC * ANALYZER_SR);
    expect(Math.max(...y.subarray(0, 2000))).toBeGreaterThan(0.05); // starts on sound
    expect(col.feed(ring)).toBeNull(); // not again until reset
  });
  it('ignores sound below the gate, and sound from before a reset', () => {
    const ring = new FloatRing(8 * ANALYZER_SR);
    const col = new CalibrationCollector();
    col.feed(ring);
    ring.push(Float32Array.from({ length: ANALYZER_SR }, () => 10 ** ((GATE_DBFS - 10) / 20)));
    expect(col.feed(ring)).toBeNull();
    expect(col.progress(ring)).toBe(0);
    ring.push(loud(1));
    col.feed(ring);
    col.reset();
    ring.push(loud(3));
    expect(col.feed(ring)).toBeNull(); // the first feed after reset starts at the ring's end
    expect(col.progress(ring)).toBe(0);
  });
});

describe('latestWindow', () => {
  it('ends the analysed signal at the newest sample, the window WAIT_SEC before', () => {
    const ring = new FloatRing(8 * ANALYZER_SR);
    ring.push(new Float32Array(Math.round(2.5 * ANALYZER_SR)));
    expect(latestWindow(ring, 1)).toBeNull(); // needs 1 + 1.6 s
    ring.push(new Float32Array(Math.round(0.5 * ANALYZER_SR)));
    const w = latestWindow(ring, 1)!;
    expect(w.to).toBe(ring.end);
    expect(w.to - w.from).toBe(Math.round((1 + 2 * WAIT_SEC) * ANALYZER_SR));
    expect(w.colStart).toBe(WAIT_SEC);
    expect(w.colEnd).toBe(WAIT_SEC + 1);
    expect(latestWindow(ring, 3)).toBeNull();
  });
});
