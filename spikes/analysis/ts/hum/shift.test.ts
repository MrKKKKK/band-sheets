import { describe, expect, it } from 'vitest';
import { scoreRow } from './report';
import { chooseShift, estimateShift, estimateShiftTicks, shiftClass, unshiftNotes } from './score';
import type { HumNote, QuantizedMelody } from './types';

const truth = [60, 62, 64, 65, 67, 69].map((m, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, midi: m }));
const est = (shift: number, extra: Partial<HumNote> = {}): HumNote[] =>
  truth.map((t) => ({ start: t.start + 0.01, end: t.end, midi: t.midi + shift, cents: 0, confidence: 1, candidates: [{ midi: t.midi + shift + 1, confidence: 0.2 }], ...extra }));
const quant = (shift: number): QuantizedMelody => ({
  bpm: 120,
  ts: [4, 4],
  startSec: 0,
  onsetBiasSec: 0,
  grid: 'sixteenth',
  events: truth.map((t, i) => ({ kind: 'note' as const, startTick: i * 8, ticks: 8, midi: t.midi + shift, src: i, candidates: [], gridCandidates: [], confidence: 1 })),
});
const ticks = truth.map((t, i) => ({ startTick: i * 8, ticks: 8, midi: t.midi }));

describe('estimateShift', () => {
  for (const s of [0, 12, -12, 5, -7, 24, -24]) {
    it(`finds ${s}`, () => {
      expect(estimateShift(truth, est(s))).toBe(s);
      expect(estimateShiftTicks(ticks, quant(s).events.map((e) => e as never))).toBe(s);
    });
  }
  it('beyond 24 semitones is left alone (0)', () => {
    expect(estimateShift(truth, est(30))).toBe(0);
  });
  it('majority wins, ignoring outliers and unmatched notes', () => {
    const e = est(5);
    e[0] = { ...e[0], midi: 40 };
    e.push({ ...e[0], start: 9, end: 9.4, midi: 80 });
    expect(estimateShift(truth, e)).toBe(5);
  });
  it('ties choose the smallest |shift|, then the lower value', () => {
    expect(chooseShift([[60, 60], [62, 74]])).toBe(0);
    expect(chooseShift([[60, 72], [62, 62], [64, 52]])).toBe(0); // 1/1/1 -> 0 present
    expect(chooseShift([[60, 65], [62, 74]])).toBe(5);
    expect(chooseShift([[60, 65], [62, 57]])).toBe(-5); // |5| = |-5|, lower wins
    expect(chooseShift([[60, 72], [62, 50]])).toBe(-12);
    expect(chooseShift([])).toBe(0);
  });
  it('shiftClass', () => {
    expect([0, 12, -24, 5, -7].map(shiftClass)).toEqual(['zero', 'octave', 'octave', 'other', 'other']);
  });
  it('unshiftNotes also moves the candidates', () => {
    const [n] = unshiftNotes(est(12), 12);
    expect([n.midi, n.candidates[0].midi]).toEqual([60, 61]);
  });
});

describe('scoreRow transposeInvariant', () => {
  const inp = (s: number) => ({ truthNotes: truth, estNotes: est(s), truthTicks: ticks, estQuant: quant(s) });
  it('OFF leaves a shifted estimate at 0 and adds no shift keys', () => {
    const r = scoreRow(inp(12));
    expect(r['noteF.onset']).toBe(0);
    expect(r['noteF.onsetOffset']).toBe(0);
    expect(r['quant.exactAcc']).toBe(0);
    expect(r['shift.class']).toBeUndefined();
  });
  for (const s of [12, -12, 5, 0]) {
    it(`ON removes ${s}`, () => {
      const r = scoreRow({ ...inp(s), transposeInvariant: true });
      expect(r['noteF.onsetOffset']).toBe(1);
      expect(r['noteF.onsetPitchClass']).toBe(1);
      expect(r['quant.exactAcc']).toBe(1);
      expect(r['edit.count']).toBe(0);
      expect(r['gridCand.k1']).toBe(1);
      expect(r['pitchCand.k1']).toBe(1);
      expect(r['shift.class']).toBe(s === 0 ? 0 : s % 12 === 0 ? 1 : 2);
      expect(r['shift.semitones']).toBeUndefined(); // not exposed unless asked (recordings)
    });
  }
  it('exposeShift gives the value; ON is never worse than OFF', () => {
    const on = scoreRow({ ...inp(-12), transposeInvariant: true, exposeShift: true });
    expect(on['shift.semitones']).toBe(-12);
    const noisy = { truthNotes: truth, estNotes: est(3).map((n, i) => (i === 1 ? { ...n, midi: 70 } : n)), truthTicks: ticks, estQuant: quant(3) };
    const off = scoreRow(noisy);
    const on2 = scoreRow({ ...noisy, transposeInvariant: true });
    for (const k of ['noteF.onsetOffset', 'quant.exactAcc', 'pitchCand.k1']) expect(on2[k]).toBeGreaterThanOrEqual(off[k]);
  });
  it('tick-only input estimates the shift from ticks', () => {
    const r = scoreRow({ truthTicks: ticks, estQuant: quant(12), transposeInvariant: true });
    expect(r['quant.exactAcc']).toBe(1);
    expect(r['shift.class']).toBe(1);
  });
});
