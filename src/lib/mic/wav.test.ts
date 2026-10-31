import { describe, expect, it } from 'vitest';
import {
  decodeWavMono,
  isDecodableWav,
  readWavHeader,
  wavDurationSec,
} from '../../analysis/audioFile';
import { createTakeBuffer } from './takeBuffer';
import { encodeWav16, wavParts } from './wav';

function bytesOf(chunks: Int16Array[], sr: number): Uint8Array {
  const parts = wavParts(chunks, sr);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += p.byteLength;
  }
  return out;
}

describe('wav.ts round trip through audioFile.ts', () => {
  it('reads back the rate, length and samples (within int16 rounding)', () => {
    const sr = 44100;
    const src = Float32Array.from(
      { length: 70000 },
      (_, i) => Math.sin(i / 20) * (i % 9000 === 0 ? 1.5 : 0.8),
    );
    const b = createTakeBuffer();
    for (let o = 0; o < src.length; o += 4096)
      b.add({ frame: 1000 + o, data: src.subarray(o, o + 4096) });
    const { chunks, frames } = b.slice(1000, 1000 + src.length, sr);
    const bytes = bytesOf(chunks, sr);
    const h = readWavHeader(bytes)!;
    expect(h.sampleRate).toBe(sr);
    expect(h.numChannels).toBe(1);
    expect(h.bitsPerSample).toBe(16);
    expect(isDecodableWav(h)).toBe(true);
    expect(wavDurationSec(h)).toBeCloseTo(frames / sr, 9);
    const y = decodeWavMono(bytes, h);
    expect(y.length).toBe(src.length);
    for (let i = 0; i < y.length; i++) {
      const want = Math.max(-1, Math.min(32767 / 32768, src[i]));
      expect(Math.abs(y[i] - want)).toBeLessThanOrEqual(1 / 32768);
    }
  });

  it('an empty take is a valid zero-length WAV', () => {
    const bytes = bytesOf([], 48000);
    expect(bytes.length).toBe(44);
    const h = readWavHeader(bytes)!;
    expect(h.dataBytes).toBe(0);
    expect(decodeWavMono(bytes, h).length).toBe(0);
  });

  it('Blob has the header plus 2 bytes per frame and the WAV type', () => {
    const blob = encodeWav16(
      [Int16Array.from([1, 2, 3]), new Int16Array(0)],
      8000,
    );
    expect(blob.size).toBe(44 + 6);
    expect(blob.type).toBe('audio/wav');
  });
});
