import { describe, expect, it } from 'vitest';
import {
  decodeRate,
  decodeWavMono,
  isDecodableWav,
  FALLBACK_RATE,
  mixdownInPlace,
  mp3SampleRate,
  readWavHeader,
  wavDurationSec,
} from './audioFile';
import { wavBytes } from './testing/wavBytes';

describe('readWavHeader / wavDurationSec', () => {
  it('reads rate, channels, bits and the data size', () => {
    const h = readWavHeader(wavBytes({ sr: 22050, channels: 2, dataBytes: 8 }));
    expect(h).toMatchObject({
      sampleRate: 22050,
      numChannels: 2,
      bitsPerSample: 16,
      format: 1,
      dataOffset: 44,
      dataBytes: 8,
    });
  });

  it('duration counts whole frames present in the file (header size clamped to the bytes)', () => {
    const full = readWavHeader(wavBytes({ sr: 8000, dataBytes: 16000 }))!;
    expect(wavDurationSec(full)).toBe(1);
    const cut = readWavHeader(
      wavBytes({ sr: 8000, dataBytes: 0xffffffff, present: 8000 }),
    )!;
    expect(cut.dataBytes).toBe(8000);
    expect(wavDurationSec(cut)).toBe(0.5);
  });

  it('skips other chunks before data and rejects non-WAV bytes', () => {
    const base = wavBytes({ sr: 11025, dataBytes: 4 });
    // insert a 3-byte LIST chunk (odd size -> 1 pad byte) between fmt and data
    const list = new Uint8Array(8 + 4);
    list.set([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0]);
    const b = new Uint8Array(base.length + list.length);
    b.set(base.subarray(0, 36));
    b.set(list, 36);
    b.set(base.subarray(36), 36 + list.length);
    expect(readWavHeader(b)?.dataOffset).toBe(44 + list.length);
    expect(readWavHeader(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(
      readWavHeader(new TextEncoder().encode('ID3 not a wav file')),
    ).toBeNull();
  });

  it('no duration for a zero frame size', () => {
    const h = readWavHeader(wavBytes({ sr: 8000, bits: 0, dataBytes: 4 }))!;
    expect(wavDurationSec(h)).toBeNull();
  });
});

describe('mp3SampleRate / decodeRate', () => {
  const frame = (b1: number, b2: number) => new Uint8Array([0xff, b1, b2, 0]);

  it('reads MPEG1 / MPEG2 / MPEG2.5 rates from the first frame header', () => {
    expect(mp3SampleRate(frame(0xfb, 0x90))).toBe(44100); // MPEG1 layer 3, idx 0
    expect(mp3SampleRate(frame(0xfb, 0x94))).toBe(48000); // idx 1
    expect(mp3SampleRate(frame(0xf3, 0x94))).toBe(24000); // MPEG2
    expect(mp3SampleRate(frame(0xe3, 0x90))).toBe(11025); // MPEG2.5
    expect(mp3SampleRate(frame(0xfb, 0x9c))).toBeNull(); // reserved rate index
  });

  it('skips an ID3v2 tag', () => {
    const b = new Uint8Array(10 + 5 + 4);
    b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5]);
    b.set([0xff, 0xfb, 0x94, 0], 15);
    expect(mp3SampleRate(b)).toBe(48000);
  });

  it('decodeRate: WAV header, else MP3 frame, else 44.1 kHz; out-of-range rates fall back', () => {
    expect(decodeRate(wavBytes({ sr: 22050, dataBytes: 0 }))).toBe(22050);
    expect(decodeRate(frame(0xfb, 0x94))).toBe(48000);
    expect(decodeRate(new Uint8Array(16))).toBe(FALLBACK_RATE);
    expect(decodeRate(wavBytes({ sr: 4000, dataBytes: 0 }))).toBe(
      FALLBACK_RATE,
    );
    expect(decodeRate(wavBytes({ sr: 192000, dataBytes: 0 }))).toBe(
      FALLBACK_RATE,
    );
  });
});

describe('mixdownInPlace', () => {
  it('mono: the same array', () => {
    const a = new Float32Array([0.5, -1]);
    expect(mixdownInPlace([a])).toBe(a);
  });

  it('stereo / 3 channels: the mean, written into channel 0', () => {
    const l = new Float32Array([1, 0.25]);
    const r = new Float32Array([0, -0.25]);
    const m = mixdownInPlace([l, r]);
    expect(m).toBe(l);
    expect([...m]).toEqual([0.5, 0]);
    const m3 = mixdownInPlace([
      new Float32Array([3]),
      new Float32Array([0]),
      new Float32Array([0]),
    ]);
    expect([...m3]).toEqual([1]);
  });
});

describe('decodeWavMono', () => {
  function pcm(
    bits: number,
    format: number,
    channels: number,
    write: (v: DataView) => void,
  ) {
    const frames = 2;
    const b = wavBytes({
      sr: 8000,
      bits,
      format,
      channels,
      dataBytes: (frames * channels * bits) / 8,
    });
    write(new DataView(b.buffer, 44));
    const h = readWavHeader(b)!;
    expect(isDecodableWav(h)).toBe(true);
    return [...decodeWavMono(b, h)];
  }

  it('scales integer PCM like libsndfile', () => {
    expect(pcm(8, 1, 1, (v) => (v.setUint8(0, 0), v.setUint8(1, 192)))).toEqual(
      [-1, 0.5],
    );
    expect(
      pcm(
        16,
        1,
        1,
        (v) => (v.setInt16(0, -32768, true), v.setInt16(2, 16384, true)),
      ),
    ).toEqual([-1, 0.5]);
    expect(
      pcm(24, 1, 1, (v) => {
        v.setUint8(0, 0);
        v.setUint8(1, 0);
        v.setInt8(2, -128); // -8388608
        v.setUint8(3, 0);
        v.setUint8(4, 0);
        v.setInt8(5, 64); // 4194304
      }),
    ).toEqual([-1, 0.5]);
    expect(
      pcm(
        32,
        1,
        1,
        (v) => (
          v.setInt32(0, -2147483648, true),
          v.setInt32(4, 1073741824, true)
        ),
      ),
    ).toEqual([-1, 0.5]);
  });

  it('reads float 32 / 64 and averages channels like toMono', () => {
    expect(
      pcm(
        32,
        3,
        1,
        (v) => (v.setFloat32(0, 0.25, true), v.setFloat32(4, -2, true)),
      ),
    ).toEqual([0.25, -2]);
    expect(
      pcm(
        64,
        3,
        1,
        (v) => (v.setFloat64(0, 0.1, true), v.setFloat64(8, 1, true)),
      ),
    ).toEqual([Math.fround(0.1), 1]);
    expect(
      pcm(32, 3, 2, (v) => {
        v.setFloat32(0, 0.1, true);
        v.setFloat32(4, 0.2, true);
        v.setFloat32(8, 1, true);
        v.setFloat32(12, 0, true);
      }),
    ).toEqual([Math.fround((Math.fround(0.1) + Math.fround(0.2)) * 0.5), 0.5]);
    expect(
      pcm(16, 1, 3, (v) => {
        v.setInt16(0, 16384, true);
        v.setInt16(2, 16384, true);
        v.setInt16(4, -32768, true);
      }),
    ).toEqual([0, 0]);
  });

  it('not decodable: A-law, 12-bit, no channels', () => {
    const h = (bits: number, format: number, channels = 1) =>
      readWavHeader(
        wavBytes({ sr: 8000, bits, format, channels, dataBytes: 0 }),
      )!;
    expect(isDecodableWav(h(8, 6))).toBe(false);
    expect(isDecodableWav(h(12, 1))).toBe(false);
    expect(isDecodableWav(h(16, 1, 0))).toBe(false);
  });
});
