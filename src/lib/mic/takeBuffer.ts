/**
 * The recorded take on the AudioContext's frame axis (docs/mic-recording-plan.md §2.1, §2.4). The capture worklet
 * sends mono Float32 chunks `{frame, data}` (frame = the context frame of the chunk's first sample); they are
 * converted to Int16 at once and kept as chunks (10 min at 48 kHz = about 58 MB, never one concatenated array).
 * Gaps read as silence; chunks that overlap or arrive out of order are placed by their frame, the later `add` wins.
 * Pure: no Web Audio objects.
 */

import { MAX_DURATION_SEC } from '../import/analysisTypes';

export interface CaptureChunk {
  /** Context frame of data[0]. */
  frame: number;
  /** Mono samples, nominally -1…1. */
  data: Float32Array;
}

export interface TakeSlice {
  /** Int16 chunks, in order, `frames` samples in all (silence where nothing was captured). */
  chunks: Int16Array[];
  frames: number;
}

/** Frames per output chunk of `slice` (1.4 s at 48 kHz). */
const SLICE_CHUNK_FRAMES = 65536;

/** Float → Int16: x * 32768, rounded, clipped to -32768…32767 (like the WAV fixtures' writer); NaN → 0. */
export function floatToInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.round(data[i] * 32768);
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s || 0;
  }
  return out;
}

/** Largest |sample| / 32768 of every `bucketFrames` frames (the last bucket may be short); [] for no samples. */
export function peakBuckets(
  chunks: readonly Int16Array[],
  bucketFrames: number,
): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(Math.ceil(total / bucketFrames));
  let i = 0;
  for (const c of chunks) {
    for (let k = 0; k < c.length; k++, i++) {
      const a = Math.abs(c[k]) / 32768;
      const b = Math.floor(i / bucketFrames);
      if (a > out[b]) out[b] = a;
    }
  }
  return out;
}

export interface TakeBuffer {
  add(chunk: CaptureChunk): void;
  /** Frame range with data: [first, end). Both 0 when nothing was added. */
  readonly firstFrame: number;
  readonly endFrame: number;
  /** Frames missing between a chunk's start and the end of the data before it, summed / the largest single gap. */
  readonly gapFrames: number;
  readonly maxGapFrames: number;
  /**
   * The samples of frames [startFrame, endFrame), as Int16 chunks. `startFrame` may be before the first data
   * (leading silence, e.g. a negative offset) or beyond it (empty); `endFrame` is cut at the last captured frame
   * and at `startFrame` + MAX_DURATION_SEC. Chunks are views of the stored ones (shared, not copied) unless the
   * input was out of order / overlapping; silence is new zero arrays. Treat the result as read-only.
   */
  slice(startFrame: number, endFrame: number): TakeSlice;
  /** The same range as one Float32Array (int16 / 32768, silence as 0): for short stretches only (calibration). */
  sliceFloat(startFrame: number, endFrame: number): Float32Array;
}

export function createTakeBuffer(sampleRate: number): TakeBuffer {
  const segs: { frame: number; data: Int16Array }[] = [];
  let first = Infinity;
  let end = -Infinity;
  let ordered = true; // every chunk starts at or after the end of the data before it
  let gapFrames = 0;
  let maxGapFrames = 0;

  function slice(startFrame: number, endFrame: number): TakeSlice {
    const start = Math.round(startFrame);
    const stop = Math.min(
      Math.round(endFrame),
      end,
      start + Math.round(MAX_DURATION_SEC * sampleRate),
    );
    const frames = segs.length === 0 ? 0 : Math.max(0, stop - start);
    const chunks: Int16Array[] = [];
    const limit = start + frames;
    if (ordered) {
      let at = start;
      for (const s of segs) {
        const from = Math.max(s.frame, start);
        const to = Math.min(s.frame + s.data.length, limit);
        if (to <= from) continue;
        if (from > at) chunks.push(new Int16Array(from - at));
        chunks.push(s.data.subarray(from - s.frame, to - s.frame));
        at = to;
      }
      if (at < limit) chunks.push(new Int16Array(limit - at));
      return { chunks, frames };
    }
    for (let o = 0; o < frames; o += SLICE_CHUNK_FRAMES)
      chunks.push(new Int16Array(Math.min(SLICE_CHUNK_FRAMES, frames - o)));
    for (const s of segs) {
      const from = Math.max(s.frame, start);
      const to = Math.min(s.frame + s.data.length, limit);
      if (to <= from) continue;
      for (
        let ci = Math.floor((from - start) / SLICE_CHUNK_FRAMES);
        ci * SLICE_CHUNK_FRAMES < to - start;
        ci++
      ) {
        const base = start + ci * SLICE_CHUNK_FRAMES;
        const a = Math.max(from, base);
        const b = Math.min(to, base + chunks[ci].length);
        if (b > a)
          chunks[ci].set(s.data.subarray(a - s.frame, b - s.frame), a - base);
      }
    }
    return { chunks, frames };
  }

  return {
    add(chunk) {
      if (chunk.data.length === 0) return;
      const frame = Math.round(chunk.frame);
      if (segs.length > 0) {
        if (frame < end) ordered = false;
        else {
          gapFrames += frame - end;
          maxGapFrames = Math.max(maxGapFrames, frame - end);
        }
      }
      segs.push({ frame, data: floatToInt16(chunk.data) });
      first = Math.min(first, frame);
      end = Math.max(end, frame + chunk.data.length);
    },
    get firstFrame() {
      return segs.length === 0 ? 0 : first;
    },
    get endFrame() {
      return segs.length === 0 ? 0 : end;
    },
    get gapFrames() {
      return gapFrames;
    },
    get maxGapFrames() {
      return maxGapFrames;
    },
    slice,
    sliceFloat(startFrame, endFrame) {
      const { chunks, frames } = slice(startFrame, endFrame);
      const out = new Float32Array(frames);
      let o = 0;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++) out[o + i] = c[i] / 32768;
        o += c.length;
      }
      return out;
    },
  };
}
