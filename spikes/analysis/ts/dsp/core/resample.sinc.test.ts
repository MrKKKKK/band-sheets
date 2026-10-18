/**
 * T8: the loading resampler (toMono + resampleSinc), plus parity with librosa.load (soxr_hq) on a dev
 * synthetic render when out/ is present (skipped in CI).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signalToErrorDb } from '../../parity/compare';
import { readStage } from '../../parity/stageFile';
import { decodeWav } from '../../browser/wav';
import { resampleSinc, sincPlan, toMono } from './resample';

function sine(n: number, sr: number, f: number, amp = 0.5): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
  return x;
}

describe('toMono', () => {
  it('returns the single channel itself', () => {
    const a = new Float32Array([1, 2]);
    expect(toMono([a])).toBe(a);
  });
  it('2 channels: float32 mean, bit-identical to Math.fround((L + R) / 2)', () => {
    const l = Float32Array.from([0.1, -0.7, 0.33333334, 1]);
    const r = Float32Array.from([0.2, 0.3, 0.1, -1]);
    const m = toMono([l, r]);
    for (let i = 0; i < l.length; i++) expect(m[i]).toBe(Math.fround((l[i] + r[i]) * 0.5));
  });
  it('rejects mismatched channel lengths', () => {
    expect(() => toMono([new Float32Array(2), new Float32Array(3)])).toThrow();
  });
});

describe('resampleSinc', () => {
  it('same rate returns the input', () => {
    const x = new Float32Array(10);
    expect(resampleSinc(x, 22050, 22050)).toBe(x);
  });

  it('length ceil(n * to / from) (librosa fix=True)', () => {
    for (const [from, n] of [[44100, 1001], [48000, 1001], [32000, 777], [16000, 500]] as const) {
      expect(resampleSinc(new Float32Array(n), from, 22050).length).toBe(Math.ceil((n * 22050) / from));
    }
  });

  it('reduced ratios: 44.1 kHz is 2:1, 48 kHz is 320:147', () => {
    expect([sincPlan(44100, 22050).up, sincPlan(44100, 22050).down]).toEqual([1, 2]);
    expect([sincPlan(48000, 22050).up, sincPlan(48000, 22050).down]).toEqual([147, 320]);
  });

  it('table size = 8 * up * width bytes (the formula in the plan-cache comment)', () => {
    const p = sincPlan(48000, 22050);
    expect(p.taps.byteLength).toBe(8 * p.up * p.width);
    expect(p.taps.byteLength).toBeLessThan(1e6);
  });

  it('the one-plan cache keeps results identical when the rate alternates', () => {
    const x = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i * 0.05));
    const a = resampleSinc(x, 48000, 22050);
    resampleSinc(x, 32000, 22050);
    expect(Array.from(resampleSinc(x, 48000, 22050))).toEqual(Array.from(a));
  });

  it.each([44100, 48000, 32000, 16000])('a 1 kHz sine from %i Hz keeps amplitude and phase (SNR > 100 dB inside)', (from) => {
    const x = sine(from, from, 1000); // 1 s
    const y = resampleSinc(x, from, 22050);
    const ref = sine(y.length, 22050, 1000);
    const a = 2000;
    const b = y.length - 2000;
    expect(signalToErrorDb(y.subarray(a, b), ref.subarray(a, b))).toBeGreaterThan(100);
  });

  it('a tone just under the passband edge (0.9 x 11025 Hz) from 48 kHz passes within 0.01 dB', () => {
    const f = 0.9 * 11025;
    const y = resampleSinc(sine(48000, 48000, f), 48000, 22050);
    let peak = 0;
    for (let i = 2000; i < y.length - 2000; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(Math.abs(20 * Math.log10(peak / 0.5))).toBeLessThan(0.01);
  });

  it.each([44100, 48000])('a tone above the target Nyquist (12 kHz) from %i Hz is below -110 dB', (from) => {
    const y = resampleSinc(sine(from, from, 12000), from, 22050);
    let peak = 0;
    for (let i = 2000; i < y.length - 2000; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(20 * Math.log10(peak / 0.5)).toBeLessThan(-110);
  });
});

const OUT = join(import.meta.dirname, '../../../out');
const VARIANTS: [string, string][] = [
  ['full-t116-straight', 'saints/full-t116-straight.wav'],
  ['etude-full-t90-straight', 'etude/etude-full-t90-straight.wav'],
];
const avail = VARIANTS.filter(([v, w]) => existsSync(join(OUT, 'parity', v, 'y.f32')) && existsSync(join(OUT, w)));

describe.skipIf(avail.length === 0)('toMono + resampleSinc(22050) vs librosa.load (soxr_hq), dev synthetic 44.1 kHz renders', () => {
  for (const [v, wav] of avail) {
    it(`${v}: same length, signal-to-error >= 70 dB`, () => {
      const w = decodeWav(readFileSync(join(OUT, wav)));
      const y = resampleSinc(toMono(w.channels), w.sampleRate, 22050);
      const ref = readStage(join(OUT, 'parity', v), 'y').data;
      expect(y.length).toBe(ref.length);
      const snr = signalToErrorDb(y, ref);
      console.log(`[T8] resampler vs librosa.load ${v}: SNR ${snr.toFixed(2)} dB`);
      expect(snr).toBeGreaterThan(70);
    });
  }
});
