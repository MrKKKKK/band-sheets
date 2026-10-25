/**
 * Pure helpers for decodeFile: read a WAV's header (duration, to reject a too-long file before decoding it) and
 * decode PCM / float WAV straight to mono; find other files' own sample rate (so decodeAudioData does not
 * resample); mix down to mono.
 * From the research branch (spikes/analysis/ts/browser/wav.ts readWavHeader / decodeWav, bench.ts sniffRate /
 * mixdownInPlace).
 *
 * Why WAV is decoded here and not by decodeAudioData: Chromium scales 16-bit samples asymmetrically (positive
 * values / 32767), while libsndfile / librosa (the research reference, and the golden fixtures) divide by 32768.
 * Decoding WAV ourselves gives the analyzers exactly the research branch's samples (and needs no AudioBuffer).
 */

export interface WavHeader {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float (WAVE_FORMAT_EXTENSIBLE resolved to its sub-format) */
  format: number;
  dataOffset: number;
  /** Bytes of sample data actually present (the header's size, clamped to the file). */
  dataBytes: number;
}

function tag(v: DataView, o: number): string {
  return String.fromCharCode(
    v.getUint8(o),
    v.getUint8(o + 1),
    v.getUint8(o + 2),
    v.getUint8(o + 3),
  );
}

/**
 * Parses a RIFF/WAVE header; null when `bytes` is not one (or has no fmt chunk before the data chunk, or the data
 * chunk does not start inside `bytes`). `bytes` may be just the start of the file: `fileBytes` (the whole file's
 * size) clamps the data size.
 */
export function readWavHeader(
  bytes: Uint8Array,
  fileBytes = bytes.byteLength,
): WavHeader | null {
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
      if (body + 16 > bytes.byteLength) return null;
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26 && body + 26 <= bytes.byteLength)
        format = v.getUint16(body + 24, true); // extensible: sub-format GUID
      fmt = {
        format,
        numChannels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      return {
        ...fmt,
        dataOffset: body,
        dataBytes: Math.max(0, Math.min(size, fileBytes - body)),
      };
    }
    o = body + size + (size & 1);
  }
  return null;
}

/** Duration in seconds of the samples present in a WAV, or null when the header is unusable. */
export function wavDurationSec(h: WavHeader): number | null {
  const frameBytes = (h.bitsPerSample / 8) * h.numChannels;
  if (!(frameBytes > 0) || !(h.sampleRate > 0)) return null;
  return Math.floor(h.dataBytes / frameBytes) / h.sampleRate;
}

const MP3_RATES = [44100, 48000, 32000];

/** The first MPEG audio frame's sample rate (after an ID3v2 tag), or null. Looks at most 64 KiB in. */
export function mp3SampleRate(bytes: Uint8Array): number | null {
  let o = 0;
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    // ID3v2, syncsafe size
    o = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  const end = Math.min(bytes.length, o + 65536);
  for (let i = o; i + 3 < end; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (bytes[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
    const layer = (bytes[i + 1] >> 1) & 3; // 0 = reserved
    const idx = (bytes[i + 2] >> 2) & 3;
    if (ver === 1 || layer === 0 || idx === 3) continue;
    const base = MP3_RATES[idx];
    return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
  }
  return null;
}

/** Rates an OfflineAudioContext accepts in every current browser (the spec minimum range). */
const MIN_CONTEXT_RATE = 8000;
const MAX_CONTEXT_RATE = 96000;
/** Used when the rate cannot be read from the file (m4a, ogg, …): the browser resamples to it. */
export const FALLBACK_RATE = 44100;

/** The rate to decode at: the file's own (WAV header, MP3 frame) when usable, else FALLBACK_RATE. */
export function decodeRate(bytes: Uint8Array): number {
  const r = readWavHeader(bytes)?.sampleRate ?? mp3SampleRate(bytes);
  return r !== null && r >= MIN_CONTEXT_RATE && r <= MAX_CONTEXT_RATE
    ? r
    : FALLBACK_RATE;
}

/**
 * Mixes `channels` down to mono IN PLACE in channels[0] and returns it (librosa.to_mono: the mean; same float32
 * values as the research branch's toMono / bench mixdown). One channel: returned as is.
 */
export function mixdownInPlace(
  channels: readonly Float32Array[],
): Float32Array {
  const out = channels[0];
  const k = channels.length;
  if (k === 1) return out;
  const n = out.length;
  if (k === 2) {
    const r = channels[1];
    for (let i = 0; i < n; i++) out[i] = (out[i] + r[i]) * 0.5;
  } else {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < k; c++) s += channels[c][i];
      out[i] = s / k;
    }
  }
  return out;
}

/** Integer PCM 8 (unsigned) / 16 / 24 / 32 bit and IEEE float 32 / 64: what decodeWavMono reads. */
export function isDecodableWav(h: WavHeader): boolean {
  return (
    h.numChannels >= 1 &&
    ((h.format === 1 && [8, 16, 24, 32].includes(h.bitsPerSample)) ||
      (h.format === 3 && [32, 64].includes(h.bitsPerSample)))
  );
}

/** Frames (samples per channel) of a WAV's data. */
export function wavFrames(h: WavHeader): number {
  return Math.floor(h.dataBytes / ((h.bitsPerSample / 8) * h.numChannels));
}

/**
 * Decodes whole frames of WAV sample data to mono (the mean of the channels, computed in float64 and rounded once,
 * like mixdownInPlace), writing `out[at…]`. Integer PCM is scaled like libsndfile's float conversion (16 bit:
 * / 32768; 8 bit unsigned: (u - 128) / 128). `data` starts on a frame boundary; `h` must satisfy isDecodableWav.
 * Returns the number of frames written.
 */
export function decodeWavFramesInto(
  data: Uint8Array,
  h: WavHeader,
  out: Float32Array,
  at: number,
): number {
  const nc = h.numChannels;
  const bits = h.bitsPerSample;
  const bps = bits / 8;
  const frame = bps * nc;
  const n = Math.min(Math.floor(data.byteLength / frame), out.length - at);
  const v = new DataView(data.buffer, data.byteOffset, n * frame);
  const read: (o: number) => number =
    h.format === 3
      ? bits === 32
        ? (o) => v.getFloat32(o, true)
        : (o) => v.getFloat64(o, true)
      : bits === 8
        ? (o) => (v.getUint8(o) - 128) / 128
        : bits === 16
          ? (o) => v.getInt16(o, true) / 32768
          : bits === 24
            ? (o) =>
                (v.getUint8(o) |
                  (v.getUint8(o + 1) << 8) |
                  (v.getInt8(o + 2) << 16)) /
                8388608
            : (o) => v.getInt32(o, true) / 2147483648;
  if (nc === 1) {
    for (let i = 0; i < n; i++) out[at + i] = read(i * bps);
  } else if (nc === 2) {
    // same float32 values as decoding both channels to float32 first and then (l + r) * 0.5
    for (let i = 0, o = 0; i < n; i++, o += frame)
      out[at + i] = (Math.fround(read(o)) + Math.fround(read(o + bps))) * 0.5;
  } else {
    for (let i = 0, o = 0; i < n; i++, o += frame) {
      let s = 0;
      for (let c = 0; c < nc; c++) s += Math.fround(read(o + c * bps));
      out[at + i] = s / nc;
    }
  }
  return n;
}

/** The whole WAV (`bytes` = the file) decoded to mono; see decodeWavFramesInto. */
export function decodeWavMono(bytes: Uint8Array, h: WavHeader): Float32Array {
  const out = new Float32Array(wavFrames(h));
  decodeWavFramesInto(
    bytes.subarray(h.dataOffset, h.dataOffset + h.dataBytes),
    h,
    out,
    0,
  );
  return out;
}
