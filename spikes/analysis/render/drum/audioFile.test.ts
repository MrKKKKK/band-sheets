import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeWav } from '../wav';
import { decodeWav, readAudioFile, resample, resampleStep } from './audioFile';
import { DRUMKITS_DIR, kitAvailable } from './kits';

/** sha256 (16 hex) of interleaved int32 LE PCM, as py side: soundfile.read(dtype='int32') >> (32 - bits). */
function pcmHash(path: string): string {
  const d = readAudioFile(path);
  const n = d.channels[0].length;
  const c = d.channels.length;
  const buf = Buffer.alloc(n * c * 4);
  const s = 2 ** (d.bitsPerSample - 1);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) buf.writeInt32LE(Math.round(d.channels[k][i] * s), (i * c + k) * 4);
  return `${d.sampleRate}:${n}x${c}:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`;
}

describe('FLAC decoder (flac.ts) is bit-exact against libsndfile', () => {
  // Hashes computed 2026-10-25 in the band-sheets-analysis image with soundfile (libsndfile) on the pinned kits.
  const B = 'virtuosity_drums/Samples';
  const C = 'big_rusty_drums/Samples';
  it.skipIf(!kitAvailable('B'))('kit B: 24-bit 48 kHz stereo', () => {
    expect(pcmHash(join(DRUMKITS_DIR, B, 'oh/snare/oh_snare_center_vl20.flac'))).toBe('48000:89241x2:a0b8c58ffcd37c10');
    expect(pcmHash(join(DRUMKITS_DIR, B, 'room/crash/room_crash_crash_vl3_rr2.flac'))).toBe('48000:661264x2:433c7291ee015948');
  });
  it.skipIf(!kitAvailable('C'))('kit C: 16-bit 44.1 kHz mono and stereo', () => {
    expect(pcmHash(join(DRUMKITS_DIR, C, 'kick_24/kick/kick/k_vl10_rr1.flac'))).toBe('44100:74907x1:c9cf75f0fc8c3627');
    expect(pcmHash(join(DRUMKITS_DIR, C, 'crash_17/cr/oh/cr_vl1_rr1.flac'))).toBe('44100:651434x2:c34214690e3ec8a0');
  });
});

describe('WAV reader and resampler', () => {
  it('reads back our 16-bit WAV', () => {
    const x = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
    const d = decodeWav(new Uint8Array(encodeWav(x, 44100)));
    expect(d.sampleRate).toBe(44100);
    expect(d.channels.length).toBe(1);
    for (let i = 0; i < x.length; i++) expect(Math.abs(d.channels[0][i] - x[i])).toBeLessThan(1 / 32767);
  });

  it('48 kHz -> 44.1 kHz keeps a 1 kHz sine (level and phase) and the length ratio', () => {
    const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000));
    const y = resample(x, 48000, 44100);
    expect(y.length).toBe(Math.floor(47999 / (48000 / 44100)) + 1);
    let err = 0;
    for (let j = 2000; j < 42000; j++) err = Math.max(err, Math.abs(y[j] - Math.sin((2 * Math.PI * 1000 * j) / 44100)));
    expect(err).toBeLessThan(1e-3);
  });

  it('resampling pre-ringing before an attack stays within the kernel half-width', () => {
    const x = new Float32Array(4000);
    x.fill(0.5, 2000, 2100);
    const y = resampleStep(x, 2 ** (200 / 1200));
    const at = Math.round(2000 / 2 ** (200 / 1200));
    let pre = 0;
    for (let i = 0; i < at - 40; i++) pre = Math.max(pre, Math.abs(y[i]));
    expect(pre).toBeLessThan(1e-3);
  });
});
