import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  columnCosines,
  correlation,
  cosineSimilarity,
  fractionAtLeast,
  maxErrorOverPeak,
  maxRelativeError,
  shiftTable,
  signalToErrorDb,
  timeOffsets,
} from './compare';
import { NetworkAccessError, stubNoNetwork } from './noNetwork';
import { decodeF32, encodeF32, parseMeta, readStage } from './stageFile';

describe('stageFile', () => {
  it('reads a hand-made .f32 + meta.json back with shape and values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    try {
      const vals = [1, -2.5, 0.125, 3, 4, 5];
      writeFileSync(join(dir, 'chroma.f32'), encodeF32(vals));
      writeFileSync(join(dir, 'beats.f32'), encodeF32([0.5, 1]));
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({
          commit: 'f087ca3',
          configHash: 'adec583eb3c6',
          stages: {
            chroma: { file: 'chroma.f32', dtype: 'float32', shape: [2, 3], sr: 22050 },
            beats: { shape: [2] },
          },
        }),
      );
      const s = readStage(dir, 'chroma');
      expect(s.shape).toEqual([2, 3]);
      expect(Array.from(s.data)).toEqual(vals);
      expect(s.info.sr).toBe(22050);
      expect(Array.from(readStage(dir, 'beats').data)).toEqual([0.5, 1]);
      expect(() => readStage(dir, 'nope')).toThrow(/not in/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('is little-endian and checks byte length', () => {
    // 1.0f = 0x3f800000 -> bytes 00 00 80 3f
    expect(decodeF32(new Uint8Array([0, 0, 0x80, 0x3f]), [1])[0]).toBe(1);
    expect(() => decodeF32(new Uint8Array(7), [2])).toThrow(/size mismatch/);
    expect(decodeF32(new Uint8Array(0), [0, 3]).length).toBe(0);
    expect(decodeF32(new Uint8Array(4), [])[0]).toBe(0); // scalar
  });

  it('decodes from an unaligned view', () => {
    const buf = new Uint8Array(9);
    buf.set(encodeF32([2.5]), 1);
    expect(decodeF32(buf.subarray(1, 5), [1])[0]).toBe(2.5);
  });

  it('rejects bad meta', () => {
    expect(() => parseMeta('{}')).toThrow();
    expect(() => parseMeta('{"stages":{"a":{"shape":[1.5]}}}')).toThrow(/shape/);
    expect(() => parseMeta('{"stages":{"a":{"shape":[1],"dtype":"float64"}}}')).toThrow(/dtype/);
  });
});

describe('compare', () => {
  it('maxRelativeError', () => {
    // |1.1-1|/1 = 0.1 ; |1.8-2|/2 = 0.1 ; |0-0|=0
    expect(maxRelativeError([1.1, 1.8, 0], [1, 2, 0])).toBeCloseTo(0.1, 12);
    expect(maxRelativeError([1], [1])).toBe(0);
    expect(() => maxRelativeError([1], [1, 2])).toThrow();
  });

  it('maxErrorOverPeak', () => {
    expect(maxErrorOverPeak([1, 0.5], [1, 0])).toBeCloseTo(0.5, 12);
    expect(maxErrorOverPeak([0], [0])).toBe(0);
  });

  it('cosineSimilarity', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    // (1*1+1*0)/(sqrt2*1)
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 12);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('correlation', () => {
    expect(correlation([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
  });

  it('columnCosines and fractionAtLeast', () => {
    // 2x3 row-major: columns are (1,0),(0,1),(1,1) vs (1,0),(1,0),(1,1)
    const a = [1, 0, 1, 0, 1, 1];
    const e = [1, 1, 1, 0, 0, 1];
    const c = columnCosines(a, e, 2, 3);
    expect(c[0]).toBeCloseTo(1, 12);
    expect(c[1]).toBeCloseTo(0, 12);
    expect(c[2]).toBeCloseTo(1, 12);
    expect(fractionAtLeast(c, 0.995)).toBeCloseTo(2 / 3, 12);
  });

  it('signalToErrorDb', () => {
    // signal power 4 (2^2), error power 0.01 -> 10log10(400)
    expect(signalToErrorDb([2.1], [2])).toBeCloseTo(10 * Math.log10(4 / 0.01), 9);
    expect(signalToErrorDb([1, 2], [1, 2])).toBe(Infinity);
    expect(signalToErrorDb([1], [0])).toBe(-Infinity);
  });

  it('shiftTable finds a known shift', () => {
    const e = [0, 0, 1, 3, 2, 0, 0, 0];
    // actual is expected delayed by 2: actual[i+2] = e[i]
    const a = [0, 0, 0, 0, 1, 3, 2, 0];
    const { rows, best } = shiftTable(a, e, 3);
    expect(rows.map((r) => r.lag)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(best.lag).toBe(2);
    expect(best.cosine).toBeCloseTo(1, 12);
    expect(best.snrDb).toBe(Infinity);
    const zero = rows.find((r) => r.lag === 0)!;
    // overlap whole arrays: dot = 1*0+... a.e = 0*... compute: e.a = 2*0? e[2]=1,a[2]=0; e[3]=3,a[3]=0; e[4]=2,a[4]=1 -> 2
    // |e|^2=14, |a|^2=14 -> cos = 2/14
    expect(zero.cosine).toBeCloseTo(2 / 14, 12);
  });

  it('timeOffsets', () => {
    const r = timeOffsets([0.5, 1.001, 1.5], [0.5, 1.0, 1.5], 0.0015);
    expect(r.sameCount).toBe(true);
    expect(r.maxAbs).toBeCloseTo(0.001, 12);
    expect(r.meanSigned).toBeCloseTo(0.001 / 3, 12);
    expect(r.withinTol).toBe(1);
    expect(timeOffsets([0.5, 1.002], [0.5, 1.0], 0.0015).withinTol).toBe(0.5);
    expect(timeOffsets([1], [1, 2], 0.001).sameCount).toBe(false);
  });
});

describe('stubNoNetwork', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes network APIs throw', async () => {
    stubNoNetwork();
    expect(() => fetch('http://example.invalid/')).toThrow(NetworkAccessError);
    expect(() => new (globalThis as any).XMLHttpRequest()).toThrow(NetworkAccessError);
    expect(() => new WebSocket('ws://example.invalid/')).toThrow(NetworkAccessError);
    expect(() => (globalThis as any).navigator.sendBeacon('http://example.invalid/')).toThrow(NetworkAccessError);
  });
});
