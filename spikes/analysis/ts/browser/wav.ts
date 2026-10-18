/**
 * Minimal RIFF/WAVE reader (PCM 8-bit unsigned and 16/24/32-bit int, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) for Node
 * tests and for reading a WAV's own sample rate in the page. Integer PCM is scaled like libsndfile's
 * float conversion (16 bit: / 32768; 8 bit unsigned: (u - 128) / 128). Browsers decode with decodeAudioData instead.
 */
export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

export interface WavHeader {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  format: number;
  dataOffset: number;
  dataBytes: number;
}

function tag(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

/** Parse the header; null when `bytes` is not a RIFF/WAVE file. */
export function readWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.byteLength < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') return null;
  let o = 12;
  let fmt: Omit<WavHeader, 'dataOffset' | 'dataBytes'> | null = null;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(v, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // extensible: sub-format GUID
      fmt = {
        format,
        numChannels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      return { ...fmt, dataOffset: body, dataBytes: Math.min(size, bytes.byteLength - body) };
    }
    o = body + size + (size & 1);
  }
  return null;
}

export function decodeWav(bytes: Uint8Array): WavData {
  const h = readWavHeader(bytes);
  if (!h) throw new Error('not a RIFF/WAVE file');
  const { numChannels: nc, bitsPerSample: bits, format } = h;
  const bps = bits / 8;
  const n = Math.floor(h.dataBytes / (bps * nc));
  const v = new DataView(bytes.buffer, bytes.byteOffset + h.dataOffset, n * bps * nc);
  const channels = Array.from({ length: nc }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const o = (i * nc + c) * bps;
      let s: number;
      if (format === 1 && bits === 8) s = (v.getUint8(o) - 128) / 128;
      else if (format === 1 && bits === 16) s = v.getInt16(o, true) / 32768;
      else if (format === 1 && bits === 24) {
        const u = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16);
        s = u / 8388608;
      } else if (format === 1 && bits === 32) s = v.getInt32(o, true) / 2147483648;
      else if (format === 3 && bits === 32) s = v.getFloat32(o, true);
      else if (format === 3 && bits === 64) s = v.getFloat64(o, true);
      else throw new Error(`unsupported WAV format ${format} / ${bits} bit`);
      channels[c][i] = s;
    }
  }
  return { sampleRate: h.sampleRate, channels };
}
