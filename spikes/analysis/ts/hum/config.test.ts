import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG, humConfigCanonical, humConfigHash, humConfigSummary, resolveHumConfig } from './config';
import { TICKS_PER_16TH, WHOLE_TICKS, type HumAnalysisResult, type HumNote } from './types';
import type { AnalysisResult } from '../../render/types';

function reorder(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(reorder);
  if (o && typeof o === 'object') {
    return Object.fromEntries(
      Object.entries(o as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reorder(v)]),
    );
  }
  return o;
}

describe('hum config hash', () => {
  it('is 12 hex chars and stable (pinned)', () => {
    expect(humConfigHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(humConfigHash()).toBe(PINNED);
  });
  it('does not depend on key order', () => {
    const rev = reorder(DEFAULT_HUM_CONFIG) as typeof DEFAULT_HUM_CONFIG;
    expect(Object.keys(rev)[0]).not.toBe(Object.keys(DEFAULT_HUM_CONFIG)[0]);
    expect(humConfigHash(rev)).toBe(humConfigHash());
    expect(humConfigCanonical(rev)).toBe(humConfigCanonical());
  });
  it('resolve with overrides in any order gives the same hash', () => {
    const a = resolveHumConfig({ f0: { hop: 128, win: 2048 }, grid: { triplet: true } });
    const b = resolveHumConfig({ grid: { triplet: true }, f0: { win: 2048, hop: 128 } });
    expect(humConfigHash(a)).toBe(humConfigHash(b));
    expect(humConfigHash(a)).not.toBe(humConfigHash());
    expect(humConfigSummary(a)).toEqual({ 'f0.win': 2048, 'f0.hop': 128, 'grid.triplet': true });
  });
  it('any value change changes the hash; defaults are not mutated', () => {
    const c = resolveHumConfig({ f0: { pyinThresholds: [0.1] } });
    expect(humConfigHash(c)).not.toBe(humConfigHash());
    expect(DEFAULT_HUM_CONFIG.f0.pyinThresholds).toEqual([0.05, 0.1, 0.15, 0.2, 0.3]);
    expect(humConfigHash(resolveHumConfig({}))).toBe(humConfigHash());
  });
  it('rejects unknown keys and wrong types', () => {
    expect(() => resolveHumConfig({ nope: 1 })).toThrow(/unknown/);
    expect(() => resolveHumConfig({ f0: { nope: 1 } })).toThrow(/unknown/);
    expect(() => resolveHumConfig({ f0: { hop: '256' } })).toThrow(/expected number/);
    expect(() => resolveHumConfig({ grid: { triplet: 1 } })).toThrow(/expected boolean/);
    expect(() => resolveHumConfig({ f0: 3 })).toThrow(/object/);
    expect(() => resolveHumConfig([])).toThrow();
  });
  it('plan values', () => {
    const c = DEFAULT_HUM_CONFIG;
    expect([c.f0.win, c.f0.hop, c.f0.fminHz, c.f0.fmaxHz, c.f0.binsPerSemitone]).toEqual([1024, 256, 65, 1050, 5]);
    expect(c.segment.moveSemitones).toBe(0.6);
    expect(c.segment.minMoveMs).toBe(60);
    expect(c.grid.subdivision).toBe(16);
    expect(c.pitch.candidatesMax).toBe(3);
    expect(c.grid.candidatesMax).toBe(2);
    expect(c.pitch.keyPrior).toBe(false);
    expect(c.grid.triplet).toBe(false);
  });
});

describe('hum types', () => {
  it('tick constants match the melody model', () => {
    expect(WHOLE_TICKS).toBe(64);
    expect(TICKS_PER_16TH).toBe(4);
  });
  it('a HumAnalysisResult is an AnalysisResult; old-style notes still type-check', () => {
    const note: HumNote = { start: 0, end: 0.5, midi: 60, cents: 3, confidence: 0.9, candidates: [{ midi: 61, confidence: 0.2 }] };
    const r: HumAnalysisResult = {
      format: 'band-sheets-analysis',
      version: 1,
      source: { kind: 'recording', durationSec: 1, click: true },
      analyzer: { name: 'hum-ts', version: '0', methods: ['yin'] },
      melody: {
        notes: [note],
        quantized: { bpm: 100, ts: [4, 4], startSec: 0, onsetBiasSec: 0, grid: 'sixteenth', events: [] },
      },
      hum: { meta: { configHash: humConfigHash(), configName: 'hum-v0', timings: { stagesMs: {}, totalMs: 0, audioSec: 1 }, warnings: [], tuningCents: 0, info: { bpm: 100, ts: [4, 4], startSec: 0 } } },
    };
    const asBase: AnalysisResult = r;
    const old: AnalysisResult = { ...asBase, melody: { notes: [{ start: 0, end: 1, midi: 60, confidence: 1 }] } };
    expect(old.melody?.notes[0].cents).toBeUndefined();
    expect(JSON.parse(JSON.stringify(r)).melody.notes[0].midi).toBe(60);
  });
});

const PINNED = '2d3c76d270cd';
