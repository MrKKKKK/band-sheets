// Mono 16-bit PCM WAV writer (docs/audio-spike0-plan.md, design decision 2):
// clip only, never normalize.

/** Average interleaved stereo into mono. */
export function downmixStereo(interleaved: Float32Array): Float32Array {
  const n = Math.floor(interleaved.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (interleaved[2 * i] + interleaved[2 * i + 1]) / 2;
  return out;
}

/** Mono 16-bit PCM WAV file bytes. Samples outside [-1, 1] are clipped. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(c < 0 ? c * 32768 : c * 32767), 44 + 2 * i);
  }
  return buf;
}
