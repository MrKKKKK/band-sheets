// Spike 5 T2: reading the kit sample files (FLAC via flac.ts, WAV PCM 16/24/32 / float 32) and a windowed-sinc
// resampler (kit B is 48 kHz; the "other tuning" of D3 is a resampling pitch shift). Pure TS, no network.

import { readFileSync } from 'node:fs';
import { decodeFlac, type DecodedAudio } from './flac';

export type { DecodedAudio };

export function decodeWav(buf: Uint8Array): DecodedAudio {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('wav: not a RIFF/WAVE file');
  let fmt = 0;
  let nch = 0;
  let sampleRate = 0;
  let bps = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = dv.getUint16(body, true);
      nch = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bps = dv.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE: sub-format GUID
    } else if (id === 'data') {
      if (!nch) throw new Error('wav: data before fmt');
      const bytes = bps / 8;
      const n = Math.floor(Math.min(size, buf.length - body) / (bytes * nch));
      const channels = Array.from({ length: nch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < nch; c++) {
          const o = body + (i * nch + c) * bytes;
          let v: number;
          if (fmt === 3 && bps === 32) v = dv.getFloat32(o, true);
          else if (fmt === 1 && bps === 16) v = dv.getInt16(o, true) / 32768;
          else if (fmt === 1 && bps === 24) {
            const u = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
            v = (u & 0x800000 ? u - 0x1000000 : u) / 8388608;
          } else if (fmt === 1 && bps === 32) v = dv.getInt32(o, true) / 2147483648;
          else throw new Error(`wav: unsupported format ${fmt} / ${bps} bit`);
          channels[c][i] = v;
        }
      }
      return { sampleRate, bitsPerSample: bps, channels };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('wav: no data chunk');
}

export function readAudioFile(path: string): DecodedAudio {
  const buf = new Uint8Array(readFileSync(path));
  if (/\.flac$/i.test(path)) return decodeFlac(buf);
  if (/\.wav$/i.test(path)) return decodeWav(buf);
  throw new Error(`unsupported audio file: ${path}`);
}

/** Channel average. */
export function toMono(a: DecodedAudio): Float32Array {
  if (a.channels.length === 1) return a.channels[0];
  const n = a.channels[0].length;
  const out = new Float32Array(n);
  const k = 1 / a.channels.length;
  for (const c of a.channels) for (let i = 0; i < n; i++) out[i] += c[i] * k;
  return out;
}

/** Half-width of the sinc kernel in input samples (at unity ratio). */
export const SINC_HALF = 24;
const PHASES = 512;
const KAISER_BETA = 8.6;

function besselI0(x: number): number {
  let s = 1;
  let t = 1;
  for (let k = 1; k < 30; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
  }
  return s;
}

const kernelCache = new Map<number, Float64Array>();
/** Kaiser-windowed sinc table for cutoff `fc` (cycles / input sample <= 0.5) over [-half, half] input samples. */
function kernel(fc: number, half: number): Float64Array {
  const key = fc * 1e6 + half;
  let k = kernelCache.get(key);
  if (k) return k;
  k = new Float64Array(2 * half * PHASES + 1);
  const i0b = besselI0(KAISER_BETA);
  for (let j = 0; j < k.length; j++) {
    const x = j / PHASES - half;
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))) / i0b;
    const s = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    k[j] = s * w;
  }
  kernelCache.set(key, k);
  return k;
}

/**
 * Resamples `x` so that output sample j is input position j * step (step = inRate / outRate; a pitch shift up by
 * c cents uses step = 2^(c/1200)). Windowed sinc, low-passed below the lower Nyquist. Deterministic.
 */
export function resampleStep(x: Float32Array, step: number): Float32Array {
  if (step === 1) return Float32Array.from(x);
  const fc = 0.5 * Math.min(1, 1 / step) * 0.94;
  const half = Math.ceil(SINC_HALF * Math.max(1, step));
  const k = kernel(fc, half);
  const n = Math.floor((x.length - 1) / step) + 1;
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = j * step;
    const c = Math.floor(t);
    let s = 0;
    const lo = Math.max(0, c - half + 1);
    const hi = Math.min(x.length - 1, c + half);
    for (let i = lo; i <= hi; i++) {
      const pos = (i - t + half) * PHASES; // kernel index of offset (i - t)
      const p = Math.floor(pos);
      const f = pos - p;
      const kv = p + 1 < k.length ? k[p] + (k[p + 1] - k[p]) * f : k[p];
      s += x[i] * kv;
    }
    out[j] = s;
  }
  return out;
}

export function resample(x: Float32Array, fromRate: number, toRate: number): Float32Array {
  return fromRate === toRate ? x : resampleStep(x, fromRate / toRate);
}
