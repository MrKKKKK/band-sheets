import { describe, expect, it } from 'vitest';
import { downmixStereo, encodeWav } from './wav';

describe('encodeWav', () => {
  const w = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -3]), 44100);
  it('writes a mono 16-bit 44.1 kHz header', () => {
    expect(w.toString('ascii', 0, 4)).toBe('RIFF');
    expect(w.toString('ascii', 8, 12)).toBe('WAVE');
    expect(w.readUInt32LE(4)).toBe(w.length - 8);
    expect(w.readUInt16LE(20)).toBe(1);
    expect(w.readUInt16LE(22)).toBe(1);
    expect(w.readUInt32LE(24)).toBe(44100);
    expect(w.readUInt32LE(28)).toBe(88200);
    expect(w.readUInt16LE(34)).toBe(16);
    expect(w.toString('ascii', 36, 40)).toBe('data');
    expect(w.readUInt32LE(40)).toBe(10);
    expect(w.length).toBe(44 + 10);
  });
  it('clips and does not normalize', () => {
    expect(w.readInt16LE(44)).toBe(0);
    expect(w.readInt16LE(46)).toBe(Math.round(0.5 * 32767));
    expect(w.readInt16LE(48)).toBe(-16384);
    expect(w.readInt16LE(50)).toBe(32767);
    expect(w.readInt16LE(52)).toBe(-32768);
  });
});

describe('downmixStereo', () => {
  it('averages the channels', () => {
    expect(Array.from(downmixStereo(new Float32Array([1, 0, 0.5, 0.5, -1, 1])))).toEqual([0.5, 0.5, 0]);
  });
});
