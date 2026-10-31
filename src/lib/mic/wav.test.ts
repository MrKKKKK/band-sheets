import { describe, expect, it } from 'vitest';
import {
  decodeWavMono,
  isDecodableWav,
  readWavHeader,
  wavDurationSec,
} from '../../analysis/audioFile';
import { createTakeBuffer } from './takeBuffer';
import { encodeWav16 } from './wav';

async function bytesOf(chunks: Int16Array[], sr: number): Promise<Uint8Array> {
  return new Uint8Array(await encodeWav16(chunks, sr).arrayBuffer());
}

describe('wav.ts round trip through audioFile.ts', () => {
  it('reads back the rate, length and samples (within int16 rounding)', async () => {
    const sr = 44100;
    const src = Float32Array.from(
      { length: 70000 },
      (_, i) => Math.sin(i / 20) * (i % 9000 === 0 ? 1.5 : 0.8),
    );
    const b = createTakeBuffer(sr);
    for (let o = 0; o < src.length; o += 4096)
      b.add({ frame: 1000 + o, data: src.subarray(o, o + 4096) });
    const { chunks, frames } = b.slice(1000, 1000 + src.length);
    const bytes = await bytesOf(chunks, sr);
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

  it('an empty take is a valid zero-length WAV', async () => {
    const bytes = await bytesOf([], 48000);
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

  it('writes the exact 44-byte header', async () => {
    const bytes = await bytesOf([Int16Array.from([1, -2, 3])], 44100);
    const hex = Array.from(bytes.subarray(0, 44), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
    expect(hex).toBe(
      '52494646' + // RIFF
        '2a000000' + // 36 + 6
        '57415645666d7420' + // WAVEfmt
        '10000000' + // fmt size 16
        '0100' + // PCM
        '0100' + // mono
        '44ac0000' + // 44100
        '88580100' + // byte rate 88200
        '0200' + // block align
        '1000' + // 16 bits
        '64617461' + // data
        '06000000', // 6 bytes
    );
  });
});
