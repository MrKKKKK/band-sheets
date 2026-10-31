import { describe, expect, it } from 'vitest';
import { MAX_DURATION_SEC } from '../import/analysisTypes';
import { createTakeBuffer, floatToInt16, peakBuckets } from './takeBuffer';

const f = (...xs: number[]) => Float32Array.from(xs);
const flat = (cs: Int16Array[]) => cs.flatMap((c) => Array.from(c));

describe('floatToInt16', () => {
  it('scales by 32768, rounds, clips, and maps NaN to 0', () => {
    expect(
      Array.from(floatToInt16(f(0, 0.5, -0.5, 1, -1, 2, -2, NaN, 0.00002))),
    ).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768, 0, 1]);
  });
});

describe('createTakeBuffer.slice', () => {
  it('is empty for an empty take', () => {
    const b = createTakeBuffer(48000);
    expect(b.firstFrame).toBe(0);
    expect(b.endFrame).toBe(0);
    expect(b.slice(0, 100)).toEqual({ chunks: [], frames: 0 });
  });

  it('joins chunks across their boundary and fills a gap with zeros', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 10, data: f(0.5, 0.5) });
    b.add({ frame: 12, data: f(-0.5) });
    b.add({ frame: 15, data: f(0.25) });
    const s = b.slice(10, 16);
    expect(s.frames).toBe(6);
    expect(flat(s.chunks)).toEqual([16384, 16384, -16384, 0, 0, 8192]);
    expect(b.firstFrame).toBe(10);
    expect(b.endFrame).toBe(16);
  });

  it('places out-of-order chunks by frame; overlap: the later add wins', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 2, data: f(0.5, 0.5) });
    b.add({ frame: 0, data: f(0.25, 0.25, 0.25) });
    expect(flat(b.slice(0, 4).chunks)).toEqual([8192, 8192, 8192, 16384]);
  });

  it('a positive offset drops the head', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 0, data: f(0.1, 0.2, 0.3, 0.4) });
    const s = b.slice(2, 4);
    expect(s.frames).toBe(2);
    expect(Array.from(s.chunks[0])).toEqual(
      Array.from(floatToInt16(f(0.3, 0.4))),
    );
  });

  it('a start before the data gives leading silence (negative offset)', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 5, data: f(0.5) });
    expect(flat(b.slice(2, 6).chunks)).toEqual([0, 0, 0, 16384]);
    const c = createTakeBuffer(48000);
    c.add({ frame: 0, data: f(0.5) });
    expect(flat(c.slice(-2, 1).chunks)).toEqual([0, 0, 16384]);
  });

  it('a start beyond the data, or end <= start, is empty', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 0, data: f(0.5, 0.5) });
    expect(b.slice(10, 20).frames).toBe(0);
    expect(b.slice(1, 1).frames).toBe(0);
    expect(b.slice(2, 1).frames).toBe(0);
  });

  it('cuts the end at the last captured frame', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 0, data: f(0.5, 0.5, 0.5) });
    expect(b.slice(0, 100).frames).toBe(3);
  });

  it('splits long slices into several chunks without losing samples', () => {
    const b = createTakeBuffer(48000);
    const n = 65536 * 2 + 5;
    const data = new Float32Array(n);
    data[65535] = 0.5;
    data[65536] = -0.5;
    data[n - 1] = 0.25;
    // delivered in odd-sized chunks that straddle the output chunk boundary
    for (let o = 0; o < n; o += 40000)
      b.add({ frame: o, data: data.subarray(o, Math.min(n, o + 40000)) });
    const s = b.slice(0, n);
    expect(s.frames).toBe(n);
    const all = flat(s.chunks);
    expect(all[65535]).toBe(16384);
    expect(all[65536]).toBe(-16384);
    expect(all[n - 1]).toBe(8192);
    expect(all.filter((x) => x !== 0)).toHaveLength(3);
  });

  it('stops exactly at MAX_DURATION_SEC from the start, and does not exceed it', () => {
    const sr = 100; // tiny rate keeps the test small
    const limit = MAX_DURATION_SEC * sr;
    const b = createTakeBuffer(sr);
    b.add({ frame: 10, data: new Float32Array(limit + 500).fill(0.5) });
    expect(b.slice(10, 10 + limit).frames).toBe(limit);
    expect(b.slice(10, 10 + limit + 300).frames).toBe(limit);
    expect(b.slice(10, 10 + limit - 1).frames).toBe(limit - 1);
  });
});

describe('peakBuckets', () => {
  it('takes the max |sample| per bucket, including a short last one', () => {
    const p = peakBuckets(
      [Int16Array.from([0, -16384]), Int16Array.from([100, 32767, 5])],
      2,
    );
    expect(Array.from(p)).toEqual([0.5, 32767 / 32768, 5 / 32768]);
  });

  it('is empty for no samples', () => {
    expect(peakBuckets([], 480).length).toBe(0);
  });

  it('with fewer samples than one bucket gives one bucket', () => {
    expect(Array.from(peakBuckets([Int16Array.from([-32768])], 480))).toEqual([
      1,
    ]);
  });
});

describe('createTakeBuffer: gaps, views, floats', () => {
  it('counts the frames missing between chunks (total and largest)', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 100, data: f(0.5, 0.5) }); // the first chunk is no gap
    b.add({ frame: 102, data: f(0.5) }); // contiguous
    b.add({ frame: 110, data: f(0.5) }); // 7 missing
    b.add({ frame: 112, data: f(0.5) }); // 1 missing
    expect(b.gapFrames).toBe(8);
    expect(b.maxGapFrames).toBe(7);
  });

  it('does not count an overlapping or out-of-order chunk as a gap', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 10, data: f(0.5, 0.5) });
    b.add({ frame: 5, data: f(0.5) });
    b.add({ frame: 11, data: f(0.5, 0.5) });
    expect(b.gapFrames).toBe(0);
    expect(b.maxGapFrames).toBe(0);
  });

  it('a whole-chunk slice shares the stored memory; trimmed ends are views too', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 0, data: f(0.1, 0.2, 0.3) });
    b.add({ frame: 3, data: f(0.4, 0.5) });
    const s = b.slice(0, 5);
    expect(s.chunks).toHaveLength(2);
    const t = b.slice(0, 5);
    expect(s.chunks[0].buffer).toBe(t.chunks[0].buffer);
    s.chunks[0][0] = 7; // a write through the view is visible in the next slice
    expect(b.slice(0, 5).chunks[0][0]).toBe(7);
    expect(flat(b.slice(1, 4).chunks)).toEqual([
      ...Array.from(floatToInt16(f(0.2, 0.3, 0.4))),
    ]);
  });

  it('sliceFloat is int16 / 32768 with gaps and leading silence as 0', () => {
    const b = createTakeBuffer(48000);
    b.add({ frame: 2, data: f(0.5) });
    b.add({ frame: 5, data: f(-0.25) });
    expect(Array.from(b.sliceFloat(0, 6))).toEqual([0, 0, 0.5, 0, 0, -0.25]);
    expect(b.sliceFloat(9, 12).length).toBe(0);
  });
});
