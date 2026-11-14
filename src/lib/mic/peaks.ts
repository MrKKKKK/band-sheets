/** The take's waveform: peak per bucket of Int16 chunks (docs/mic-recording-plan.md §2.7). */

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
