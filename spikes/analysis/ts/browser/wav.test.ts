import { describe, expect, it } from 'vitest';
import { decodeWav } from './wav';

function pcmWav(bits: 8 | 16, nc: number, data: number[]): Uint8Array {
  const bps = bits / 8;
  const size = data.length * bps;
  const b = new Uint8Array(44 + size);
  const v = new DataView(b.buffer);
  const put = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + size, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nc, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000 * nc * bps, true);
  v.setUint16(32, nc * bps, true);
  v.setUint16(34, bits, true);
  put(36, 'data');
  v.setUint32(40, size, true);
  data.forEach((x, i) => (bits === 8 ? v.setUint8(44 + i, x) : v.setInt16(44 + i * 2, x, true)));
  return b;
}

describe('decodeWav', () => {
  it('8-bit PCM is unsigned: (u - 128) / 128, like libsndfile', () => {
    const w = decodeWav(pcmWav(8, 2, [0, 128, 255, 64]));
    expect(w.sampleRate).toBe(8000);
    expect(Array.from(w.channels[0])).toEqual([-1, 127 / 128]);
    expect(Array.from(w.channels[1])).toEqual([0, -0.5]);
  });

  it('16-bit PCM is signed, / 32768', () => {
    const w = decodeWav(pcmWav(16, 1, [-32768, 16384, 32767]));
    expect(Array.from(w.channels[0])).toEqual([-1, 0.5, 32767 / 32768]);
  });
});
