/**
 * Int16 chunks → a 16-bit PCM mono WAV (docs/mic-recording-plan.md §2.4): the 44-byte header plus the chunks as they
 * are, handed to `new Blob([...])`, so the whole take is never concatenated into one big array.
 * Samples are written in the platform's byte order; every browser we target is little-endian, as WAV requires.
 */

/** The 44-byte header of a mono 16-bit PCM WAV with `frames` samples. */
function wavHeader(frames: number, sampleRate: number): Uint8Array {
  const data = frames * 2;
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // integer PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, data, true);
  return b;
}

export function encodeWav16(
  chunks: readonly Int16Array[],
  sampleRate: number,
): Blob {
  let frames = 0;
  for (const c of chunks) frames += c.length;
  const parts = [
    wavHeader(frames, sampleRate),
    ...chunks.filter((c) => c.length > 0),
  ];
  return new Blob(parts as BlobPart[], { type: 'audio/wav' });
}
