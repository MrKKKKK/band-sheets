import { describe, expect, it, vi } from 'vitest';
import { decodeFile, type DecodeContext } from './decodeFile';
import { wavBytes } from './testing/wavBytes';
import { AnalysisError } from './types';

function fakeBuffer(channels: number[][], sampleRate: number): AudioBuffer {
  const data = channels.map((c) => new Float32Array(c));
  return {
    numberOfChannels: data.length,
    sampleRate,
    length: data[0].length,
    duration: data[0].length / sampleRate,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer;
}

function ctxFactory(decode: DecodeContext['decodeAudioData']) {
  const rates: number[] = [];
  const factory = vi.fn((sr: number) => {
    rates.push(sr);
    return { decodeAudioData: decode };
  });
  return { factory, rates };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof AnalysisError ? e.code : `other: ${String(e)}`;
  }
}

describe('decodeFile', () => {
  it('decodes WAV itself (libsndfile scaling, / 32768) to mono, without an audio context', async () => {
    const { factory } = ctxFactory(vi.fn());
    const b = wavBytes({ sr: 22050, channels: 2, dataBytes: 8 });
    const v = new DataView(b.buffer);
    [16384, 32767, -32768, 0].forEach((x, i) =>
      v.setInt16(44 + i * 2, x, true),
    );
    const out = await decodeFile(new Blob([b]), { createContext: factory });
    expect(factory).not.toHaveBeenCalled();
    expect([...out.samples]).toEqual([
      Math.fround((0.5 + 32767 / 32768) * 0.5),
      -0.5,
    ]);
    expect(out).toMatchObject({ sampleRate: 22050, channels: 2 });
    expect(out.durationSec).toBeCloseTo(2 / 22050);
  });

  it('other formats: decodeAudioData at the MP3 frame rate, mixed down to mono', async () => {
    const { factory, rates } = ctxFactory(async () =>
      fakeBuffer(
        [
          [1, 0],
          [0, 1],
        ],
        48000,
      ),
    );
    const mp3 = new Uint8Array([0xff, 0xfb, 0x94, 0, 0, 0]);
    const out = await decodeFile(new Blob([mp3]), { createContext: factory });
    expect(rates).toEqual([48000]);
    expect([...out.samples]).toEqual([0.5, 0.5]);
    expect(out).toMatchObject({ sampleRate: 48000, channels: 2 });
  });

  it('a WAV the own decoder does not read (e.g. A-law) goes to decodeAudioData', async () => {
    const { factory, rates } = ctxFactory(async () =>
      fakeBuffer([[0.25]], 8000),
    );
    const alaw = wavBytes({ sr: 8000, bits: 8, format: 6, dataBytes: 1 });
    const out = await decodeFile(new Blob([alaw]), { createContext: factory });
    expect(rates).toEqual([8000]);
    expect([...out.samples]).toEqual([0.25]);
  });

  it('rejects a WAV longer than the limit from its header, without decoding', async () => {
    const decode = vi.fn();
    const { factory } = ctxFactory(decode);
    // 8 kHz 8-bit mono: 2.5 s present > 2 s limit
    const file = new Blob([wavBytes({ sr: 8000, bits: 8, dataBytes: 20000 })]);
    expect(
      await codeOf(
        decodeFile(file, { createContext: factory, maxDurationSec: 2 }),
      ),
    ).toBe('too-long');
    expect(decode).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects other formats that turn out too long after decoding', async () => {
    const { factory, rates } = ctxFactory(async () =>
      fakeBuffer([[0, 0, 0, 0, 0]], 2),
    );
    expect(
      await codeOf(
        decodeFile(new Blob(['not a wav']), {
          createContext: factory,
          maxDurationSec: 2,
        }),
      ),
    ).toBe('too-long');
    expect(rates).toEqual([44100]);
  });

  it('the default limit is 10 minutes', async () => {
    const { factory } = ctxFactory(async () => fakeBuffer([[0]], 1));
    const ok = new Blob([
      wavBytes({ sr: 8000, bits: 8, dataBytes: 600 * 8000 }),
    ]);
    const long = new Blob([
      wavBytes({ sr: 8000, bits: 8, dataBytes: 600 * 8000 + 1 }),
    ]);
    expect(await codeOf(decodeFile(ok, { createContext: factory }))).toBe(
      'resolved',
    );
    expect(await codeOf(decodeFile(long, { createContext: factory }))).toBe(
      'too-long',
    );
  });

  it('decode errors become decode-failed', async () => {
    const { factory } = ctxFactory(() =>
      Promise.reject(new DOMException('bad', 'EncodingError')),
    );
    expect(
      await codeOf(decodeFile(new Blob(['xx']), { createContext: factory })),
    ).toBe('decode-failed');
  });

  it('aborted before or during decoding: cancelled, the decoded data is dropped', async () => {
    const ac = new AbortController();
    const { factory } = ctxFactory(async () => {
      ac.abort();
      return fakeBuffer([[1]], 8000);
    });
    expect(
      await codeOf(
        decodeFile(new Blob(['x']), {
          createContext: factory,
          signal: ac.signal,
        }),
      ),
    ).toBe('cancelled');
    const before = new AbortController();
    before.abort();
    expect(
      await codeOf(
        decodeFile(new Blob(['x']), {
          createContext: factory,
          signal: before.signal,
        }),
      ),
    ).toBe('cancelled');
  });
});

describe('decodeFile: WAV read in slices', () => {
  it('a WAV larger than one slice decodes every frame, also when the data chunk starts late', async () => {
    const frames = 1003;
    const small = { headBytes: 64, sliceBytes: 100 }; // 10+ slices
    const b = wavBytes({ sr: 8000, dataBytes: frames * 2 });
    const v = new DataView(b.buffer);
    for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, (i % 7) - 3, true);
    const out = await decodeFile(new Blob([b]), small);
    expect(out.samples.length).toBe(frames);
    expect(out.samples[frames - 1]).toBe((((frames - 1) % 7) - 3) / 32768);
    for (let i = 0; i < frames; i++)
      expect(out.samples[i]).toBe(((i % 7) - 3) / 32768);

    // a 100-byte "junk" chunk before data: the data chunk is not in the first headBytes
    const junk = new Uint8Array(8 + 100);
    junk.set([0x6a, 0x75, 0x6e, 0x6b]);
    new DataView(junk.buffer).setUint32(4, 100, true);
    const late = new Uint8Array(b.length + junk.length);
    late.set(b.subarray(0, 36));
    late.set(junk, 36);
    late.set(b.subarray(36), 36 + junk.length);
    const out2 = await decodeFile(new Blob([late]), {
      ...small,
      createContext: () => {
        throw new Error('must not use decodeAudioData');
      },
    });
    expect(out2.samples).toEqual(out.samples);
  });
});
