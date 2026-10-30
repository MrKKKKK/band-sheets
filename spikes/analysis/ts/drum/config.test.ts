import { describe, expect, it } from 'vitest';
import { DEFAULT_DRUM_CONFIG, DRUM_CONFIG_GROUPS, drumConfigCanonical, drumConfigHash, drumConfigSummary, resolveDrumConfig } from './config';
import { EXT_DRUM_INSTRUMENTS, LEVEL_INSTRUMENTS, TICKS_PER_16TH, WHOLE_TICKS, type DrumAnalysisResult, type DrumInst } from './types';
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

const PINNED = '88d18eb37af0'; // drum-v0 (spike 5 T11b: per-take tom adapt keys; 610eb4f00c26 at T11: S-9 toms / cymbals keys, adaptSubMin; a3e68494763b at T10 (eq / adapt keys and values); 94d5028cad36 at T6 / T9; e5408bc19f5a at T5, a1fbcd60a07e at T7, 9a5aebb7fec0 at T0)

describe('drum config hash', () => {
  it('is 12 hex chars and stable (pinned)', () => {
    expect(drumConfigHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(drumConfigHash()).toBe(PINNED);
  });
  it('does not depend on key order', () => {
    const rev = reorder(DEFAULT_DRUM_CONFIG) as typeof DEFAULT_DRUM_CONFIG;
    expect(Object.keys(rev)[0]).not.toBe(Object.keys(DEFAULT_DRUM_CONFIG)[0]);
    expect(drumConfigHash(rev)).toBe(drumConfigHash());
    expect(drumConfigCanonical(rev)).toBe(drumConfigCanonical());
  });
  it('resolve with overrides in any order gives the same hash; defaults untouched', () => {
    const a = resolveDrumConfig({ onset: { hop: 128, win: 4096 }, grid: { triplet: true } });
    const b = resolveDrumConfig({ grid: { triplet: true }, onset: { win: 4096, hop: 128 } });
    expect(drumConfigHash(a)).toBe(drumConfigHash(b));
    expect(drumConfigHash(a)).not.toBe(drumConfigHash());
    expect(drumConfigSummary(a)).toEqual({ 'onset.win': 4096, 'onset.hop': 128, 'grid.triplet': true });
    expect(drumConfigHash(resolveDrumConfig({ bands: { edgesHz: [40, 200, 3000, 10000] } }))).not.toBe(drumConfigHash());
    expect(DEFAULT_DRUM_CONFIG.bands.edgesHz).toEqual([30, 250, 5000, 16000]);
    expect(drumConfigHash(resolveDrumConfig({}))).toBe(drumConfigHash());
  });
  it('rejects unknown keys and wrong types', () => {
    expect(() => resolveDrumConfig({ nope: 1 })).toThrow(/unknown/);
    expect(() => resolveDrumConfig({ onset: { nope: 1 } })).toThrow(/unknown/);
    expect(() => resolveDrumConfig({ onset: { hop: '256' } })).toThrow(/expected number/);
    expect(() => resolveDrumConfig({ grid: { triplet: 1 } })).toThrow(/expected boolean/);
    expect(() => resolveDrumConfig({ onset: 3 })).toThrow(/object/);
    expect(() => resolveDrumConfig([])).toThrow();
  });
  it('plan values', () => {
    const c = DEFAULT_DRUM_CONFIG;
    expect(Object.keys(c).filter((k) => k !== 'name')).toEqual([...DRUM_CONFIG_GROUPS]);
    expect(c.grid.subdivision).toBe(16);
    expect(c.grid.triplet).toBe(false);
    expect([c.score.toleranceSec, c.score.tightSec]).toEqual([0.05, 0.025]);
    expect(c.toms.groups).toBe(3);
    expect(c.classify.candidatesMax).toBe(1);
  });
});

describe('drum types', () => {
  it('tick constants match the melody model', () => {
    expect(WHOLE_TICKS).toBe(64);
    expect(TICKS_PER_16TH).toBe(4);
  });
  it('levels: S-3 within S-9 within S-ext; extension names follow the plan', () => {
    expect([...EXT_DRUM_INSTRUMENTS]).toEqual(['SP', 'CN', 'CB', 'SD.rim', 'SD.xs', 'RD.bell', 'HH.foot', 'HH.fsp']);
    expect(LEVEL_INSTRUMENTS['S-9']).toHaveLength(9);
    for (const i of LEVEL_INSTRUMENTS['S-3']) expect(LEVEL_INSTRUMENTS['S-9']).toContain(i);
    for (const i of LEVEL_INSTRUMENTS['S-9']) expect(LEVEL_INSTRUMENTS['S-ext']).toContain(i);
  });
  it('a DrumAnalysisResult is an AnalysisResult; old-style hits still type-check', () => {
    const inst: DrumInst = 'SD.rim';
    const r: DrumAnalysisResult = {
      format: 'band-sheets-analysis',
      version: 1,
      source: { kind: 'recording', durationSec: 1, click: true },
      analyzer: { name: 'drum-ts', version: '0', methods: ['onset'] },
      drums: [{ t: 0.5, inst, strength: 0.8, confidence: 0.9, bar: 0, tick: 8, mark: 'ac', alts: [{ inst: 'SD', confidence: 0.3 }] }],
      swingBars: [{ bar: 0, kind: 'none', ratio: 0.5 }],
      drum: {
        meta: {
          configHash: drumConfigHash(),
          configName: 'drum-v0',
          level: 'S-ext',
          timings: { stagesMs: {}, totalMs: 0, audioSec: 1 },
          warnings: [],
          info: { bpm: 100, ts: [4, 4], startSec: 0 },
          grid: { givenStartSec: 0, startSec: 0, phaseOffsetSec: 0, onsetBiasSec: 0 },
          stages: [{ name: 'onset', ms: 0, count: 1 }],
        },
      },
    };
    const asBase: AnalysisResult = r;
    const old: AnalysisResult = { ...asBase, drums: [{ t: 0, inst: 'BD', strength: 1, confidence: 1 }], swing: undefined };
    expect(old.drums?.[0].tick).toBeUndefined();
    expect(JSON.parse(JSON.stringify(r)).drums[0].inst).toBe('SD.rim');
  });
});
