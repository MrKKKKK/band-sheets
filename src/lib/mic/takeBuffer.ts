/**
 * The recorded take on the AudioContext's frame axis (docs/mic-recording-plan.md §2.1, §2.4). The capture worklet
 * sends mono Float32 chunks `{frame, data}` (frame = the context frame of the chunk's first sample); they are
 * converted to Int16 at once and kept as chunks (10 min at 48 kHz = about 58 MB, never one concatenated array).
 * Gaps read as silence; chunks that overlap or arrive out of order are placed by their frame, the later `add` wins.
 * Pure: no Web Audio objects.
 */

import { MAX_DURATION_SEC } from '../../analysis/types';

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

/** The frame where a file that starts at `startFrame` reaches MAX_DURATION_SEC (the take must end there). */
export function maxEndFrame(startFrame: number, sampleRate: number): number {
  return startFrame + Math.round(MAX_DURATION_SEC * sampleRate);
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

/** `peaks` reduced to at most `count` buckets by taking maxima; fewer peaks than `count` are returned as they are. */
export function reducePeaks(
  peaks: ArrayLike<number>,
  count: number,
): Float32Array {
  const n = peaks.length;
  if (n <= count || count <= 0) return Float32Array.from(Array.from(peaks));
  const out = new Float32Array(count);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((i * count) / n);
    if (peaks[i] > out[b]) out[b] = peaks[i];
  }
  return out;
}

export interface TakeBuffer {
  add(chunk: CaptureChunk): void;
  /** Frame range with data: [first, end). Both 0 when nothing was added. */
  readonly firstFrame: number;
  readonly endFrame: number;
  /**
   * The samples of frames [startFrame, endFrame), as Int16 chunks. `startFrame` may be before the first data
   * (leading silence, e.g. a negative offset) or beyond it (empty); `endFrame` is cut at the last captured frame
   * and at `startFrame` + MAX_DURATION_SEC. Does not modify the buffer.
   */
  slice(startFrame: number, endFrame: number, sampleRate: number): TakeSlice;
}

export function createTakeBuffer(): TakeBuffer {
  const segs: { frame: number; data: Int16Array }[] = [];
  let first = Infinity;
  let end = -Infinity;
  return {
    add(chunk) {
      if (chunk.data.length === 0) return;
      const frame = Math.round(chunk.frame);
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
    slice(startFrame, endFrame, sampleRate) {
      const start = Math.round(startFrame);
      const stop = Math.min(
        Math.round(endFrame),
        end,
        maxEndFrame(start, sampleRate),
      );
      const frames = segs.length === 0 ? 0 : Math.max(0, stop - start);
      const chunks: Int16Array[] = [];
      for (let o = 0; o < frames; o += SLICE_CHUNK_FRAMES)
        chunks.push(new Int16Array(Math.min(SLICE_CHUNK_FRAMES, frames - o)));
      for (const s of segs) {
        const from = Math.max(s.frame, start);
        const to = Math.min(s.frame + s.data.length, start + frames);
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
    },
  };
}
