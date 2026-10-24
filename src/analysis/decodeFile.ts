/**
 * File -> mono Float32Array at the file's own rate, on the main thread (decodeAudioData is not available in
 * Workers). Plan sections 2.2 and 6.2.
 *
 * - WAV (PCM 8/16/24/32 bit, float 32/64) is decoded here, exactly like the research branch (audioFile.ts says
 *   why), straight to mono and slice by slice (the whole file is never held next to the samples). Other formats go through decodeAudioData in a context at the file's own rate where it
 *   can be read (MP3 frame header), so the browser does not resample; otherwise (m4a, …) at 44.1 kHz (accepted
 *   for a draft, plan section 6.2).
 * - Longer than `maxDurationSec` (10 min): a WAV is rejected from its header BEFORE decoding; other formats after
 *   decoding (their duration is not known earlier), and the decoded audio is dropped at once.
 * - `signal` aborted while reading / decoding: the decoded data is discarded and `cancelled` is thrown.
 * Errors are AnalysisError: decode-failed / too-long / cancelled / unsupported.
 */
import {
  decodeRate,
  decodeWavFramesInto,
  decodeWavMono,
  isDecodableWav,
  mixdownInPlace,
  readWavHeader,
  wavDurationSec,
  wavFrames,
  type WavHeader,
} from './audioFile';
import { AnalysisError, MAX_DURATION_SEC, type DecodedAudio } from './types';

/** The part of an audio context decodeFile uses (OfflineAudioContext in the browser; a fake in unit tests). */
export interface DecodeContext {
  decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer>;
}

export interface DecodeOptions {
  signal?: AbortSignal;
  maxDurationSec?: number;
  createContext?: (sampleRate: number) => DecodeContext;
  /** Bytes read first for the header (default 64 KiB) and per WAV data slice (default 4 MiB); for tests. */
  headBytes?: number;
  sliceBytes?: number;
}

function defaultContext(sampleRate: number): DecodeContext {
  if (typeof OfflineAudioContext === 'undefined')
    throw new AnalysisError('unsupported');
  return new OfflineAudioContext(1, 1, sampleRate);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisError('cancelled');
}

/** Bytes read first (header); WAV sample data is then read in slices of WAV_SLICE bytes. */
const HEAD_BYTES = 1 << 16;
const WAV_SLICE = 1 << 22;

async function readBytes(b: Blob): Promise<ArrayBuffer> {
  try {
    return await b.arrayBuffer();
  } catch {
    throw new AnalysisError('decode-failed');
  }
}

/**
 * WAV straight to mono, slice by slice: the whole file is never in memory next to the samples (a 5-minute 48 kHz
 * stereo 16-bit WAV is 58 MB, its mono float32 samples as much again).
 */
async function decodeWav(
  file: Blob,
  h: WavHeader,
  sliceBytes: number,
  signal?: AbortSignal,
): Promise<DecodedAudio> {
  const frame = (h.bitsPerSample / 8) * h.numChannels;
  const out = new Float32Array(wavFrames(h));
  const slice = Math.max(frame, sliceBytes - (sliceBytes % frame));
  for (let at = 0; at < out.length;) {
    const from = h.dataOffset + at * frame;
    const data = await readBytes(
      file.slice(from, Math.min(from + slice, h.dataOffset + h.dataBytes)),
    );
    throwIfAborted(signal);
    const n = decodeWavFramesInto(new Uint8Array(data), h, out, at);
    if (n === 0) throw new AnalysisError('decode-failed'); // the file changed under us
    at += n;
  }
  return {
    samples: out,
    sampleRate: h.sampleRate,
    channels: h.numChannels,
    durationSec: out.length / h.sampleRate,
  };
}

/** A WAV header worth decoding ourselves; throws too-long when its duration is over `max`. */
function usableWav(h: WavHeader | null, max: number): WavHeader | null {
  if (!h) return null;
  const sec = wavDurationSec(h);
  if (sec === null) return null;
  if (sec > max) throw new AnalysisError('too-long');
  return isDecodableWav(h) ? h : null;
}

export async function decodeFile(
  file: Blob,
  opts: DecodeOptions = {},
): Promise<DecodedAudio> {
  const { signal } = opts;
  const max = opts.maxDurationSec ?? MAX_DURATION_SEC;
  throwIfAborted(signal);
  const headBytes = opts.headBytes ?? HEAD_BYTES;
  const head = new Uint8Array(await readBytes(file.slice(0, headBytes)));
  throwIfAborted(signal);
  const wav = usableWav(readWavHeader(head, file.size), max);
  if (wav) return decodeWav(file, wav, opts.sliceBytes ?? WAV_SLICE, signal);

  const bytes = await readBytes(file);
  throwIfAborted(signal);
  const view = new Uint8Array(bytes); // a view, no copy
  // a WAV whose data chunk starts after the first headBytes (large metadata chunks)
  const lateWav =
    file.size > headBytes ? usableWav(readWavHeader(view), max) : null;
  if (lateWav) {
    const samples = decodeWavMono(view, lateWav);
    return {
      samples,
      sampleRate: lateWav.sampleRate,
      channels: lateWav.numChannels,
      durationSec: samples.length / lateWav.sampleRate,
    };
  }
  const rate = decodeRate(view);
  const ctx = (opts.createContext ?? defaultContext)(rate);
  let buf: AudioBuffer | null;
  try {
    // decodeAudioData DETACHES `bytes` (no copy)
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    throw new AnalysisError('decode-failed');
  }
  throwIfAborted(signal);
  if (buf.duration > max) throw new AnalysisError('too-long');
  const channels = buf.numberOfChannels;
  const sampleRate = buf.sampleRate;
  const durationSec = buf.duration;
  const per: Float32Array[] = [];
  for (let c = 0; c < channels; c++) per.push(buf.getChannelData(c));
  buf = null;
  const samples = mixdownInPlace(per);
  per.length = 0; // the other channels go with the AudioBuffer; only channel 0's storage is kept
  return { samples, sampleRate, channels, durationSec };
}
