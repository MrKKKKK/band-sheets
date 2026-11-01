import { describe, expect, it } from 'vitest';
import {
  barSec,
  beatSec,
  clickBeats,
  clickNotes,
  softClickSamples,
  positionAt,
} from './clickTrack';

const T44 = { num: 4, den: 4 };
const T34 = { num: 3, den: 4 };
const T68 = { num: 6, den: 8 };

describe('beatSec / barSec', () => {
  it('♩ = tempo for x/4', () => {
    expect(beatSec(120, T44)).toBeCloseTo(0.5, 12);
    expect(barSec(120, T44)).toBeCloseTo(2, 12);
    expect(barSec(120, T34)).toBeCloseTo(1.5, 12);
  });

  it('6/8 clicks on eighths: half a ♩', () => {
    expect(beatSec(120, T68)).toBeCloseTo(0.25, 12);
    expect(barSec(120, T68)).toBeCloseTo(1.5, 12);
  });

  it('rejects an invalid tempo or time signature', () => {
    expect(() => beatSec(0, T44)).toThrow(RangeError);
    expect(() => beatSec(NaN, T44)).toThrow(RangeError);
    expect(() => beatSec(100, { num: 0, den: 4 })).toThrow(RangeError);
    expect(() => beatSec(100, { num: 4, den: 0 })).toThrow(RangeError);
  });
});

describe('clickBeats', () => {
  it('starts with the count-in bar, downbeats strong', () => {
    const b = clickBeats(120, T44, 4.1);
    expect(b.map((x) => [x.sec, x.bar, x.beat, x.strong])).toEqual([
      [0, 0, 1, true],
      [0.5, 0, 2, false],
      [1, 0, 3, false],
      [1.5, 0, 4, false],
      [2, 1, 1, true],
      [2.5, 1, 2, false],
      [3, 1, 3, false],
      [3.5, 1, 4, false],
      [4, 2, 1, true],
    ]);
  });

  it('follows 3/4 and 6/8', () => {
    expect(clickBeats(120, T34, 3.1).map((x) => x.beat)).toEqual([
      1, 2, 3, 1, 2, 3, 1,
    ]);
    const b = clickBeats(120, T68, 1.6);
    expect(b).toHaveLength(7);
    expect(b[6]).toMatchObject({ bar: 1, beat: 1, strong: true });
    expect(b[6].sec).toBeCloseTo(1.5, 12);
  });

  it('stops before the file reaches the limit (a click at the limit is left out)', () => {
    const b = clickBeats(120, T44, 600);
    expect(b).toHaveLength(1200);
    expect(b[b.length - 1].sec).toBeCloseTo(599.5, 9);
  });

  it('has no drift: beat 900 is 900 x 60/97 s', () => {
    const b = clickBeats(97, T44, 600);
    expect(b[900].sec).toBeCloseTo((900 * 60) / 97, 9);
  });

  it('is empty for a limit of 0 or less', () => {
    expect(clickBeats(120, T44, 0)).toEqual([]);
    expect(clickBeats(120, T44, -3)).toEqual([]);
  });
});

describe('positionAt', () => {
  it('reads count-in as bar 0 and then the song bars', () => {
    expect(positionAt(0, 120, T44)).toEqual({ bar: 0, beat: 1 });
    expect(positionAt(1.9, 120, T44)).toEqual({ bar: 0, beat: 4 });
    expect(positionAt(2, 120, T44)).toEqual({ bar: 1, beat: 1 });
    expect(positionAt(3.6, 120, T44)).toEqual({ bar: 1, beat: 4 });
    expect(positionAt(4.5, 120, T34)).toEqual({ bar: 3, beat: 1 });
  });

  it('keeps a time on a beat (float error) on that beat', () => {
    const step = beatSec(97, T44);
    expect(positionAt(step * 4 - 1e-12, 97, T44)).toEqual({ bar: 1, beat: 1 });
  });

  it('treats negative / non-finite as the start', () => {
    expect(positionAt(-1, 120, T44)).toEqual({ bar: 0, beat: 1 });
    expect(positionAt(NaN, 120, T44)).toEqual({ bar: 0, beat: 1 });
  });
});

describe('softClickSamples', () => {
  const SR = 48000;
  it('is short, peaks within 2 ms, stays under 0.5 and ends near zero', () => {
    for (const strong of [false, true]) {
      const x = softClickSamples(SR, strong);
      expect(x.length).toBeLessThanOrEqual(SR * 0.08);
      expect(x.every(Number.isFinite)).toBe(true);
      let peak = 0;
      let at = 0;
      x.forEach((v, i) => {
        if (Math.abs(v) > peak) {
          peak = Math.abs(v);
          at = i;
        }
      });
      expect(peak).toBeLessThanOrEqual(0.5);
      expect(peak).toBeGreaterThan(0.3);
      expect(at / SR).toBeLessThanOrEqual(0.004);
      expect(Math.abs(x[x.length - 1])).toBeLessThan(0.02);
      // onset: the first 2 ms already carry the energy
      expect(
        Math.max(...Array.from(x.slice(0, SR * 0.002)).map(Math.abs)),
      ).toBeGreaterThan(0.1);
    }
  });

  it('the downbeat differs from the weak beat', () => {
    expect(Array.from(softClickSamples(SR, true))).not.toEqual(
      Array.from(softClickSamples(SR, false)),
    );
  });

  it('is much softer than the measurement click and valid at low rates', () => {
    expect(softClickSamples(SR)[10]).toBeLessThan(0.5 + 1e-9);
    expect(softClickSamples(8000).length).toBeGreaterThanOrEqual(8);
  });
});

describe('clickNotes', () => {
  it('one note per click at its time; the downbeat is higher', () => {
    const notes = clickNotes(clickBeats(120, T44, 1.1));
    expect(notes.map((n) => [n.index, n.start])).toEqual([
      [0, 0],
      [1, 0.5],
      [2, 1],
    ]);
    expect(notes[0].midi).toBeGreaterThan(notes[1].midi);
    expect(notes[0].hz).toBeGreaterThan(notes[1].hz);
    expect(notes[1].duration).toBeGreaterThan(0);
  });

  it('is empty for no clicks', () => {
    expect(clickNotes([])).toEqual([]);
  });
});
