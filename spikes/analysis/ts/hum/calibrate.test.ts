import { describe, expect, it } from 'vitest';
import { REF_TRAITS, calibrationOverrides, measureVoiceTraits, quantile, robustSigma, type KnownNote, type VoiceTraits } from './calibrate';
import { resolveHumConfig } from './config';
import type { FrameF0Track } from './types';

const HOP = 256 / 22050;
const hz = (p: number) => 440 * 2 ** ((p - 69) / 12);

interface Voice {
  tuningCents: number;
  scoopSemitones: number;
  scoopSec: number;
  vibCents: number;
  vibHz: number;
  /** Per-note offsets (cents), cycled. */
  noteOffsets: number[];
  /** Sung-time shift vs the given grid (s) and transposition (semitones). */
  shiftSec: number;
  transpose: number;
  gapSec: number;
}

const BASE_VOICE: Voice = { tuningCents: -20, scoopSemitones: 2, scoopSec: 0.12, vibCents: 40, vibHz: 5.5, noteOffsets: [10, -10, 0], shiftSec: 0, transpose: 0, gapSec: 0.05 };

/** A melody of quarter notes at 120 bpm (bar-1 head 1.0 s), every note its own voiced run (gap before the next). */
function known(n = 16): KnownNote[] {
  const pitches = [60, 62, 64, 65, 67, 65, 64, 62];
  return Array.from({ length: n }, (_, i) => ({ startTick: i * 16, ticks: 16, midi: pitches[i % pitches.length] }));
}
const GRID = { bpm: 120, ts: [4, 4] as [number, number], startSec: 1.0 };

function synthTrack(notes: KnownNote[], v: Voice): FrameF0Track {
  const tickSec = 60 / (GRID.bpm * 16);
  const end = GRID.startSec + (notes.at(-1)!.startTick + notes.at(-1)!.ticks) * tickSec + 1;
  const n = Math.ceil(end / HOP);
  const hzs = new Array<number>(n).fill(0);
  const voiced = new Array<number>(n).fill(0);
  notes.forEach((nt, k) => {
    const on = GRID.startSec + nt.startTick * tickSec + v.shiftSec;
    const off = on + nt.ticks * tickSec - v.gapSec;
    const target = nt.midi + v.transpose + (v.tuningCents + v.noteOffsets[k % v.noteOffsets.length]) / 100;
    for (let i = Math.ceil(on / HOP); i * HOP < off; i++) {
      const t = i * HOP - on;
      const scoop = t < v.scoopSec ? -v.scoopSemitones * (1 - t / v.scoopSec) : 0;
      const vib = t >= v.scoopSec ? (v.vibCents / 100) * Math.sin(2 * Math.PI * v.vibHz * (t - v.scoopSec) + 2.1 * k) : 0;
      hzs[i] = hz(target + scoop + vib);
      voiced[i] = 1;
    }
  });
  return { t0: 0, hopSec: HOP, hz: hzs, voiced };
}

describe('helpers', () => {
  it('quantile interpolates, robustSigma of a normal-ish set', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile([5], 0.9)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(robustSigma([-1, 0, 1])).toBeCloseTo(1.4826, 4);
  });
});

describe('measureVoiceTraits (synthetic voice)', () => {
  const kn = known();
  const tr = measureVoiceTraits(synthTrack(kn, BASE_VOICE), kn, GRID);

  it('finds the tuning offset, the scoop and the vibrato extent', () => {
    expect(tr.nNotes).toBe(16);
    expect(tr.coverage).toBeGreaterThan(0.8); // -30 c notes with +-40 c vibrato cross the rounding boundary sometimes
    expect(tr.tuningCents).toBeGreaterThan(-26);
    expect(tr.tuningCents).toBeLessThan(-14);
    expect(tr.scoopDepthSemitones).toBeGreaterThan(1.7);
    expect(tr.scoopDepthSemitones).toBeLessThan(2.25); // measured from the note median (vibrato moves it a little)
    expect(tr.scoopMs).toBeGreaterThan(80);
    expect(tr.scoopMs).toBeLessThan(140);
    expect(tr.scoopRate).toBe(1);
    // sinusoid of amplitude A: (P90 - P10) / 2 ~ 0.95 A
    expect(tr.wobbleCents).toBeGreaterThan(32);
    expect(tr.wobbleCents).toBeLessThan(44);
    expect(tr.noteSigmaCents).toBeGreaterThan(3);
    expect(tr.noteSigmaCents).toBeLessThan(25);
  });

  it('is unchanged by a constant time shift and a transposition of the singer', () => {
    const v = { ...BASE_VOICE, shiftSec: 0.23, transpose: 5 };
    const t2 = measureVoiceTraits(synthTrack(kn, v), kn, GRID);
    for (const k of ['tuningCents', 'scoopDepthSemitones', 'wobbleCents', 'noteSigmaCents'] as const) expect(Math.abs(t2[k] - tr[k])).toBeLessThan(6);
    expect(t2.nNotes).toBe(16);
    const t3 = measureVoiceTraits(synthTrack(kn, { ...v, transpose: -12 }), kn, GRID);
    expect(Math.abs(t3.wobbleCents - tr.wobbleCents)).toBeLessThan(6);
  });

  it('a steady voice without scoops measures small traits', () => {
    const t = measureVoiceTraits(synthTrack(kn, { ...BASE_VOICE, scoopSemitones: 0, vibCents: 0, noteOffsets: [0] }), kn, GRID);
    expect(t.scoopDepthSemitones).toBeLessThan(0.05);
    expect(t.scoopRate).toBe(0);
    expect(Number.isNaN(t.scoopMs)).toBe(true); // no scoop long enough to time
    expect(t.wobbleCents).toBeLessThan(1);
    expect(t.intraSpreadCents).toBeLessThan(1);
  });

  it('never returns pitches: only the trait keys', () => {
    expect(Object.keys(tr).sort()).toEqual(
      ['coverage', 'intraSpreadCents', 'nNotes', 'noteSigmaCents', 'onsetBiasMs', 'onsetScatterMs', 'scoopDepthSemitones', 'scoopMs', 'scoopRate', 'tuningCents', 'wobbleCents'].sort(),
    );
  });

  it('an unvoiced track gives no usable notes and no overrides', () => {
    const silent: FrameF0Track = { t0: 0, hopSec: HOP, hz: new Array(3000).fill(0), voiced: new Array(3000).fill(0) };
    const t = measureVoiceTraits(silent, kn, GRID);
    expect(t.nNotes).toBe(0);
    expect(calibrationOverrides(t)).toEqual({});
  });
});

const traits = (o: Partial<VoiceTraits>): VoiceTraits => ({
  nNotes: 20,
  coverage: 0.8,
  tuningCents: 0,
  intraSpreadCents: 30,
  wobbleCents: REF_TRAITS.wobbleCents,
  noteSigmaCents: REF_TRAITS.noteSigmaCents,
  scoopDepthSemitones: REF_TRAITS.scoopDepthSemitones,
  scoopMs: REF_TRAITS.scoopMs,
  scoopRate: 0.5,
  onsetBiasMs: 0,
  onsetScatterMs: 50,
  ...o,
});

describe('calibrationOverrides (fixed rule)', () => {
  it('the reference voice maps to the hum-v3 defaults', () => {
    const d = resolveHumConfig();
    const ov = calibrationOverrides(traits({}));
    expect(ov.segment).toEqual({ scoopMaxSemitones: d.segment.scoopMaxSemitones, fragmentMs: d.segment.fragmentMs, moveSemitones: d.segment.moveSemitones });
    expect(ov.pitch).toEqual({ boundaryCents: d.pitch.boundaryCents });
  });

  it('a rougher voice relaxes the segmentation, clamped', () => {
    const ov = calibrationOverrides(traits({ scoopDepthSemitones: 2.8, scoopMs: 180, wobbleCents: 73, noteSigmaCents: 75 }));
    expect(ov.segment).toEqual({ scoopMaxSemitones: 2.3, fragmentMs: 200, moveSemitones: 0.7 });
    expect(ov.pitch).toEqual({ boundaryCents: 30 });
    const big = calibrationOverrides(traits({ scoopDepthSemitones: 9, scoopMs: 900, wobbleCents: 300, noteSigmaCents: 300 }));
    expect(big.segment).toEqual({ scoopMaxSemitones: 3, fragmentMs: 250, moveSemitones: 0.8 });
    expect(big.pitch).toEqual({ boundaryCents: 40 });
  });

  it('a steadier voice keeps the segmentation defaults (never below), boundary goes down', () => {
    const d = resolveHumConfig();
    const ov = calibrationOverrides(traits({ scoopDepthSemitones: 0.2, scoopMs: 30, wobbleCents: 10, noteSigmaCents: 15 }));
    expect(ov.segment).toEqual({ scoopMaxSemitones: d.segment.scoopMaxSemitones, fragmentMs: d.segment.fragmentMs, moveSemitones: d.segment.moveSemitones });
    expect(ov.pitch).toEqual({ boundaryCents: 10 });
  });

  it('unmeasured traits keep their keys at the default; too few notes -> no overrides', () => {
    const ov = calibrationOverrides(traits({ scoopDepthSemitones: NaN, scoopMs: NaN }));
    expect(ov.segment).toEqual({ moveSemitones: 0.5 });
    expect(calibrationOverrides(traits({ nNotes: 3 }))).toEqual({});
  });

  it('the overrides are valid config input', () => {
    const cfg = resolveHumConfig(calibrationOverrides(traits({ wobbleCents: 70 })));
    expect(cfg.segment.moveSemitones).toBeCloseTo(0.65, 12);
  });
});
