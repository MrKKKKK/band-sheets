/**
 * Playwright globalSetup of the live chord-check smoke test: writes the fake input device's wav, a self-made C major
 * chord (synth.ts chordSignal, C2 + C4 E4 G4) of 3 s at 48 kHz, 16-bit mono, to spikes/analysis/out/live/ (gitignored).
 * Chromium loops the file. No recording is involved.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chordSignal, C_CHORD } from '../live/synth';

export const FAKE_WAV = join(import.meta.dirname, '../../out/live/c-chord-48k.wav');

export function wav16(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return b;
}

export default function globalSetup(): void {
  mkdirSync(join(FAKE_WAV, '..'), { recursive: true });
  writeFileSync(FAKE_WAV, wav16(chordSignal(C_CHORD, 48000, 3), 48000));
}
