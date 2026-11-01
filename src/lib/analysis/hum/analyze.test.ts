import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../../../test/noNetwork';
import {
  AnalysisInputError,
  analyzeHum,
  resolveStart,
  validateHumInfo,
} from './analyze';
import { humConfigHash } from './config';
import { melodyRoundTrip } from './toMelody';
import type { HumInfo, HumInput } from './types';

const SR = 44100;
const INFO: HumInfo = { bpm: 120, ts: [4, 4], startSec: 1 };

/** 1 s silence, then 8 quarter-note-ish tones (0.5 s each, 0.1 s gaps) with 3 harmonics. */
function tones(midis: number[], sr = SR): Float32Array {
  const noteSec = 0.5;
  const y = new Float32Array(
    Math.round((1 + midis.length * noteSec + 0.5) * sr),
  );
  midis.forEach((m, k) => {
    const f = 440 * 2 ** ((m - 69) / 12);
    const a = Math.round((1 + k * noteSec) * sr);
    const b = Math.round((1 + k * noteSec + noteSec - 0.1) * sr);
    for (let i = a; i < b; i++) {
      const t = i / sr;
      const env = Math.min(1, (i - a) / (0.02 * sr), (b - i) / (0.02 * sr));
      y[i] =
        0.3 *
        env *
        (Math.sin(2 * Math.PI * f * t) +
          0.5 * Math.sin(4 * Math.PI * f * t) +
          0.25 * Math.sin(6 * Math.PI * f * t));
    }
  });
  return y;
}

describe('analyzeHum', () => {
  beforeEach(() => stubNoNetwork());
  afterEach(() => vi.unstubAllGlobals());

  it('runs end to end without network and fills the meta', () => {
    const midis = [60, 62, 64, 65, 67, 69, 71, 72];
    const y = tones(midis);
    const copy = y.slice();
    const r = analyzeHum(y, SR, INFO, {
      commit: 'abc1234',
      f0Track: true,
      sourceKind: 'synthetic',
    });
    expect(y).toEqual(copy); // input untouched
    expect(r.format).toBe('band-sheets-analysis');
    expect(r.analyzer.name).toBe('hum-ts');
    expect(r.melody.notes.map((n) => n.midi)).toEqual(midis);
    const q = r.melody.quantized;
    expect(q.bpm).toBe(120);
    expect(q.events.filter((e) => e.kind === 'note')).toHaveLength(
      midis.length,
    );
    const m = r.hum.meta;
    expect(m.configHash).toBe(humConfigHash());
    expect(m.configName).toBe('hum-v3');
    expect(m.commit).toBe('abc1234');
    expect(m.info).toEqual(INFO);
    for (const k of [
      'validate',
      'resample',
      'f0',
      'level',
      'notes',
      'quantize',
    ])
      expect(m.timings.stagesMs[k]).toBeGreaterThanOrEqual(0);
    expect(m.timings.audioSec).toBeCloseTo(y.length / SR, 6);
    expect(r.hum.f0?.hz.length).toBe(r.hum.f0?.voiced.length);
    expect(r.source.kind).toBe('synthetic');
  });

  it('omits the f0 track and commit unless asked, and overrides change the hash', () => {
    const y = tones([60, 64]);
    const r = analyzeHum(y, SR, INFO);
    expect(r.hum.f0).toBeUndefined();
    expect(r.hum.meta.commit).toBeUndefined();
    const r2 = analyzeHum(y, SR, INFO, { config: { f0: { pyin: true } } });
    expect(r2.hum.meta.configHash).not.toBe(r.hum.meta.configHash);
    expect(r2.analyzer.methods[0]).toBe('pyin');
  });

  it('accepts other sample rates', () => {
    const r = analyzeHum(tones([60, 64, 67], 22050), 22050, INFO);
    expect(r.melody.notes.map((n) => n.midi)).toEqual([60, 64, 67]);
  });

  it('rejects unusable audio like spike 3', () => {
    const code = (y: Float32Array) => {
      try {
        analyzeHum(y, SR, INFO);
      } catch (e) {
        expect(e).toBeInstanceOf(AnalysisInputError);
        return (e as AnalysisInputError).code;
      }
      return 'none';
    };
    expect(code(new Float32Array(0))).toBe('empty');
    expect(code(new Float32Array(SR / 2).fill(0.1))).toBe('too-short');
    expect(code(new Float32Array(SR * 2))).toBe('silent');
    const bad = tones([60]);
    bad[100] = NaN;
    expect(code(bad)).toBe('non-finite');
  });

  it('validates the info', () => {
    expect(() => validateHumInfo({ ...INFO, bpm: 10 })).toThrow(/bpm/);
    expect(() => validateHumInfo({ ...INFO, ts: [4, 3] })).toThrow(/拍子/);
    expect(() => validateHumInfo({ ...INFO, startSec: -1 })).not.toThrow(); // bar 1 may start before the recording
    expect(() => validateHumInfo({ ...INFO, startSec: NaN })).toThrow(/小節頭/);
    expect(() => validateHumInfo({ bpm: 120, ts: [4, 4] })).toThrow(/どちらか/);
    expect(() => validateHumInfo({ ...INFO, firstNoteSec: 1 })).toThrow(
      /どちらか/,
    );
    expect(() =>
      validateHumInfo({ bpm: 120, ts: [4, 4], firstNoteSec: -0.1 }),
    ).toThrow(/開始/);
    expect(() => validateHumInfo({ ...INFO, firstNoteTick: 16 })).toThrow(
      /開始/,
    );
    expect(() => analyzeHum(tones([60]), SR, { ...INFO, bpm: NaN })).toThrow(
      /bpm/,
    );
  });

  it('resolveStart: bar head from startSec, or from the first note and its tick', () => {
    expect(resolveStart({ bpm: 120, ts: [4, 4], startSec: -0.5 })).toEqual({
      startSec: -0.5,
      startMode: 'barStart',
    });
    // 120 bpm: a beat is 0.5 s; first note on beat 4 (tick 48) at 1.0 s -> bar 1 at -0.5 s (before the recording)
    expect(
      resolveStart({
        bpm: 120,
        ts: [4, 4],
        firstNoteSec: 1,
        firstNoteTick: 48,
      }),
    ).toEqual({
      startSec: -0.5,
      firstNoteSec: 1,
      firstNoteTick: 48,
      startMode: 'firstNote',
    });
    expect(resolveStart({ bpm: 120, ts: [4, 4], firstNoteSec: 1 })).toEqual({
      startSec: 1,
      firstNoteSec: 1,
      startMode: 'firstNoteOnly',
    });
  });

  it('takes an approximate first-note second and finds the grid phase (meta.grid)', () => {
    // tones start at 1.0 s, one per beat (0.5 s at 120 bpm); the user says the first note is at ~0.7 s on beat 1
    const y = tones([60, 62, 64, 65, 67, 69, 71, 72]);
    const r = analyzeHum(y, SR, {
      bpm: 120,
      ts: [4, 4],
      firstNoteSec: 0.7,
      firstNoteTick: 0,
    });
    const g = r.hum.meta.grid;
    expect(g.startMode).toBe('firstNote');
    expect(g.givenStartSec).toBeCloseTo(0.7, 9);
    expect(Math.abs(g.startSec + g.onsetBiasSec - 1.0)).toBeLessThan(0.03); // whole steps + the sub-step bias
    expect(g.phaseOffsetSec).toBeCloseTo(0.25, 6); // two 16ths (0.125 s each)
    expect(g.phaseSteps).toBe(2);
    expect(r.melody.quantized.startSec).toBe(g.startSec);
    const ons = r.melody.quantized.events
      .filter((e) => e.kind === 'note')
      .map((e) => e.startTick);
    expect(ons).toEqual([0, 16, 32, 48, 64, 80, 96, 112]);
    expect(r.hum.meta.info).toEqual({
      bpm: 120,
      ts: [4, 4],
      firstNoteSec: 0.7,
      firstNoteTick: 0,
    });
  });

  it('accepts a bar-1 head before the recording (pickup bar)', () => {
    // bar 1 at -0.5 s: the tones (from 1.0 s) start on beat 4 of bar 1 (tick 48)
    const r = analyzeHum(tones([60, 62, 64, 65]), SR, {
      bpm: 120,
      ts: [4, 4],
      startSec: -0.5,
    });
    expect(r.hum.meta.grid).toMatchObject({
      startMode: 'barStart',
      phaseSteps: 0,
      barPositionKnown: true,
    });
    expect(
      r.melody.quantized.events.find((e) => e.kind === 'note')!.startTick,
    ).toBe(48);
  });
});

describe('T15 S10: analyzer output survives the app melody model (splitAtBars -> serializeMelody -> parseMelody)', () => {
  beforeEach(() => stubNoNetwork());
  afterEach(() => vi.unstubAllGlobals());
  const midis = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69];
  const starts: [string, HumInput][] = [
    ['bar head', INFO],
    [
      'first note + tick',
      { bpm: 120, ts: [4, 4], firstNoteSec: 1.02, firstNoteTick: 0 },
    ],
    ['first note only', { bpm: 120, ts: [4, 4], firstNoteSec: 1.03 }],
    [
      'bar head before the recording (pickup)',
      { bpm: 120, ts: [4, 4], startSec: 0.5 },
    ],
    ['3/4', { bpm: 90, ts: [3, 4], startSec: 1 }],
  ];
  for (const [label, info] of starts) {
    it(`round trip is identical: ${label}`, () => {
      const r = analyzeHum(tones(midis), SR, info, { sourceKind: 'synthetic' });
      const rt = melodyRoundTrip(r.melody.quantized);
      expect(rt.events.length).toBeGreaterThan(0);
      expect(rt.parsed).toBe(true);
      expect(rt.identical).toBe(true);
    });
  }
});
