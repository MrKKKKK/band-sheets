/**
 * Memory accounting for the analyzer (plan section 2 "memory": peak <= 300 MB for a 5-minute
 * song). Every typed array the DSP code allocates goes through a MemTracker, so the sum of
 * allocated bytes, the bytes still held, and the peak of that are known without relying on
 * engine-specific APIs. Only typed arrays are counted (small JS objects / numbers are not).
 */
export class MemTracker {
  /** Bytes currently held (allocated and not yet released). */
  live = 0;
  /** Max of `live` seen so far. */
  peak = 0;
  /** Sum of all bytes ever allocated (ignores releases). */
  total = 0;

  private add(bytes: number): void {
    this.live += bytes;
    this.total += bytes;
    if (this.live > this.peak) this.peak = this.live;
  }

  f32(n: number): Float32Array {
    this.add(n * 4);
    return new Float32Array(n);
  }

  f64(n: number): Float64Array {
    this.add(n * 8);
    return new Float64Array(n);
  }

  /** Mark arrays as no longer used (the caller must drop its references too). */
  release(...arrays: ({ byteLength: number } | null | undefined)[]): void {
    for (const a of arrays) if (a) this.live -= a.byteLength;
  }

  /** Account for an array that was allocated elsewhere but is now held by the analyzer. */
  adopt(a: { byteLength: number }): void {
    this.add(a.byteLength);
  }
}

/** A tracker for callers that do not care about the numbers. */
export function scratchMem(): MemTracker {
  return new MemTracker();
}
