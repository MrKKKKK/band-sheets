import { describe, expect, it } from 'vitest';
import { resampleSinc } from '../dsp/core/resample';
import { FloatRing, StreamResampler } from './ring';

const ramp = (n: number, off = 0): Float32Array => Float32Array.from({ length: n }, (_, i) => off + i);

describe('FloatRing', () => {
  it('slices by absolute index across the wrap', () => {
    const r = new FloatRing(10);
    r.push(ramp(7));
    r.push(ramp(8, 7)); // total 15: holds 5..14
    expect([r.start, r.end]).toEqual([5, 15]);
    expect(Array.from(r.slice(5, 15))).toEqual(Array.from(ramp(10, 5)));
    expect(Array.from(r.slice(8, 12))).toEqual([8, 9, 10, 11]);
  });
  it('keeps only the tail of a push bigger than the capacity', () => {
    const r = new FloatRing(4);
    r.push(ramp(9));
    expect([r.start, r.end]).toEqual([5, 9]);
    expect(Array.from(r.slice(5, 9))).toEqual([5, 6, 7, 8]);
  });
  it('throws for samples that are gone or not there yet', () => {
    const r = new FloatRing(4);
    r.push(ramp(6));
    expect(() => r.slice(1, 3)).toThrow();
    expect(() => r.slice(3, 7)).toThrow();
    expect(r.slice(6, 6).length).toBe(0);
  });
});

describe('StreamResampler', () => {
  const sig = (n: number, sr: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) + 0.5 * Math.sin((2 * Math.PI * 3100 * i) / sr));

  for (const sr of [48000, 44100, 96000]) {
    it(`${sr} -> 22050 in odd-sized pieces equals one resampleSinc call (to its last context)`, () => {
      const x = sig(sr * 2, sr);
      const ref = resampleSinc(x, sr, 22050);
      const rs = new StreamResampler(sr, 22050);
      const parts: Float32Array[] = [];
      for (let i = 0, k = 0; i < x.length; k++) {
        const n = [128, 1000, 4097, 333][k % 4];
        parts.push(rs.push(x.subarray(i, i + n)));
        i += n;
      }
      const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) (out.set(p, o), (o += p.length));
      expect(out.length).toBeGreaterThan(ref.length - 1000);
      let worst = 0;
      for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - ref[i]));
      expect(worst).toBeLessThan(1e-6);
      expect(out.length + Math.ceil((rs.pendingInput * 22050) / sr)).toBeGreaterThanOrEqual(ref.length - 2);
    });
  }

  it('passes the signal through at the same rate', () => {
    const rs = new StreamResampler(22050, 22050);
    const x = ramp(100);
    expect(rs.push(x)).toBe(x);
  });
});
