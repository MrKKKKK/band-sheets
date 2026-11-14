import { describe, expect, it } from 'vitest';
import { lookLineFor } from './rec_eval';

const line = (o: object) => JSON.stringify({ kind: 'look', input: 'bass', heldOut: false, task: 'R2', takes: ['bas-01-a'], configHashes: ['x'], ...o });

describe('lookLineFor', () => {
  it('returns the one dev look line of the task', () => {
    const log = [JSON.stringify({ kind: 'register', input: 'bass' }), line({}), line({ task: 'R3' })].join('\n');
    expect(lookLineFor(log, 'R2').takes).toEqual(['bas-01-a']);
  });
  it('refuses a missing or doubled line', () => {
    expect(() => lookLineFor(line({ task: 'R3' }), 'R2')).toThrow(/found 0/);
    expect(() => lookLineFor([line({}), line({})].join('\n'), 'R2')).toThrow(/found 2/);
  });
  it('refuses a held-out or empty look', () => {
    expect(() => lookLineFor(line({ heldOut: true }), 'R2')).toThrow(/not a dev look/);
    expect(() => lookLineFor(line({ takes: [] }), 'R2')).toThrow(/not a dev look/);
  });
  it('ignores looks at other inputs', () => {
    expect(() => lookLineFor(line({ input: 'bass-synth-dev' }), 'R2')).toThrow(/found 0/);
  });
});

describe('normalizeGainDb / levelDb', () => {
  it('brings the RMS to the target unless the peak would pass the ceiling', async () => {
    const { normalizeGainDb } = await import('./rec_eval');
    expect(normalizeGainDb(-40, -20, -22)).toBeCloseTo(18);
    expect(normalizeGainDb(-40, -10, -22)).toBeCloseTo(9); // capped at -1 dBFS peak
    expect(normalizeGainDb(-20, -3, -22)).toBeCloseTo(-2);
  });
  it('measures RMS and peak in dBFS', async () => {
    const { levelDb } = await import('./rec_eval');
    const y = new Float32Array(1000).map((_, i) => (i % 2 ? 0.5 : -0.5));
    const lv = levelDb(y);
    expect(lv.rmsDb).toBeCloseTo(-6.02, 2);
    expect(lv.peakDb).toBeCloseTo(-6.02, 2);
  });
});
