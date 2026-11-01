import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG } from './config';
import { beatGrid, quantize, type QuantizedEventT } from './quantize';
import { melodyRoundTrip, midiToPitchString, toMelodyEvents } from './toMelody';
import type { HumInfo, QuantizedEvent, QuantizedMelody } from './types';

const n = (startTick: number, ticks: number, midi: number): QuantizedEvent => ({
  kind: 'note',
  startTick,
  ticks,
  midi,
  src: 0,
  candidates: [],
  gridCandidates: [],
  confidence: 1,
});
const r = (startTick: number, ticks: number): QuantizedEvent => ({
  kind: 'rest',
  startTick,
  ticks,
});
const Q = (
  events: QuantizedEvent[],
  ts: [number, number] = [4, 4],
): QuantizedMelody => ({
  bpm: 100,
  ts,
  startSec: 0,
  onsetBiasSec: 0,
  grid: 'sixteenth',
  events,
});

describe('midiToPitchString', () => {
  it('spells like the app (sharps, flats by key)', () => {
    expect([60, 61, 69, 48].map((m) => midiToPitchString(m))).toEqual([
      'C4',
      'C#4',
      'A4',
      'C3',
    ]);
    expect(midiToPitchString(70, 'F')).toBe('Bb4');
    expect(() => midiToPitchString(5)).toThrow(RangeError);
    expect(() => midiToPitchString(60.5)).toThrow(RangeError);
  });
});

describe('toMelodyEvents / melodyRoundTrip', () => {
  it('dots, rests, a note across the bar line, same-pitch repeats: identical round trip', () => {
    const q = Q([
      n(0, 24, 60), // dotted quarter
      n(24, 8, 62),
      r(32, 8), // eighth rest
      n(40, 12, 64), // dotted eighth
      n(52, 4, 64), // same pitch again
      n(56, 32, 65), // across the bar line: 8 + 24 -> tied
      n(88, 8, 65),
      n(96, 4, 65),
      r(100, 12),
      n(112, 16, 67),
    ]);
    const rt = melodyRoundTrip(q);
    expect(rt.events).toHaveLength(10);
    expect(rt.events[5]).toEqual({ kind: 'note', pitch: 'F4', ticks: 32 });
    expect(rt.bars).toBe(2);
    expect(rt.ties).toBeGreaterThanOrEqual(1);
    expect(rt.tex).toMatch(/F4\{(d )?t\}/);
    expect(rt.parsed).toBe(true);
    expect(rt.identical).toBe(true);
  });
  it('a short last bar is fine; long notes decompose (40 = half + eighth, tied)', () => {
    const rt = melodyRoundTrip(Q([n(0, 40, 60), n(40, 8, 62)]));
    expect(rt.identical).toBe(true);
    expect(rt.ties).toBe(1);
  });
  it('3/4', () => {
    const rt = melodyRoundTrip(
      Q([n(0, 48, 60), n(48, 16, 62), n(64, 32, 64)], [3, 4]),
    );
    expect(rt.identical).toBe(true);
    expect(rt.bars).toBe(2);
  });
  it('rejects broken melodies (gap, overlap, two rests in a row)', () => {
    expect(() => toMelodyEvents(Q([n(0, 16, 60), n(20, 16, 62)]))).toThrow(
      /expected 16/,
    );
    expect(() => toMelodyEvents(Q([n(0, 16, 60), r(16, 8), r(24, 8)]))).toThrow(
      /two rests/,
    );
    expect(() => toMelodyEvents(Q([n(0, 15, 60)]))).toThrow(/bad ticks/);
  });
  it('triplet slots become a tuplet group and survive the round trip', () => {
    const ev: QuantizedEventT[] = [
      n(0, 16, 60),
      { ...n(16, 8, 62), tuplet: { n: 3, slot: 0 } },
      { ...n(16 + 16 / 3, 8, 64), tuplet: { n: 3, slot: 1 } },
      {
        kind: 'rest',
        startTick: 16 + 32 / 3,
        ticks: 8,
        tuplet: { n: 3, slot: 2 },
      },
      n(32, 32, 65),
    ];
    const rt = melodyRoundTrip({ ...Q(ev), grid: 'triplet' });
    expect(rt.events[1].tuplet).toEqual({ n: 3, slot: 0 });
    expect(rt.tex).toContain('tu 3');
    expect(rt.identical).toBe(true);
  });
  it('quantize -> round trip, triplet switch on', () => {
    const info: HumInfo = { bpm: 100, ts: [4, 4], startSec: 1 };
    const tick = beatGrid(info).tickSec;
    const T = 16 / 3;
    const notes = [0, T, 2 * T, 16, 32, 48].map((t, i, a) => ({
      start: 1 + t * tick,
      end: 1 + (a[i + 1] ?? 64) * tick - 0.02,
      midi: 60 + i,
    }));
    const q = quantize(notes, info, {
      ...DEFAULT_HUM_CONFIG.grid,
      triplet: true,
      onsetBias: false,
    });
    expect(q.grid).toBe('triplet');
    expect(melodyRoundTrip(q).identical).toBe(true);
  });
});
