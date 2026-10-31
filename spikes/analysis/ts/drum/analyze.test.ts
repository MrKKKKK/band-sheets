import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { DRUM_STAGES, DrumInputError, analyzeDrums, drumScore, validateDrumInfo } from './analyze';
import { drumConfigHash } from './config';
import { parseDrums } from '../../../../src/lib/drumParse';
import { timeSigOf } from './toDrums';

const SR = 44100;
const BPM = 120;
const INFO = { bpm: BPM, ts: [4, 4] as [number, number], startSec: 0.5 };

/** Synthetic kit-free pattern: BD (80 Hz thump) on 1 and 3, SD (noise burst) on 2 and 4, HH (short hi noise) on every 8th. 4 bars of 4/4. */
function pattern(bars = 4): Float32Array {
  const beat = 60 / BPM;
  const y = new Float32Array(Math.round((INFO.startSec + bars * 4 * beat + 1) * SR));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const add = (t: number, len: number, f: (i: number, n: number) => number) => {
    const a = Math.round(t * SR);
    for (let i = 0; i < len * SR && a + i < y.length; i++) y[a + i] += f(i, len * SR);
  };
  for (let b = 0; b < bars * 4; b++) {
    const t = INFO.startSec + b * beat;
    if (b % 2 === 0) add(t, 0.25, (i, n) => 0.8 * Math.sin((2 * Math.PI * 80 * i) / SR) * Math.exp((-6 * i) / n));
    else add(t, 0.2, (i, n) => 0.5 * rnd() * Math.exp((-5 * i) / n));
    for (const h of [0, 0.5]) add(t + h * beat, 0.04, (i, n) => 0.2 * rnd() * (1 - i / n));
  }
  return y;
}

describe('analyzeDrums', () => {
  beforeEach(() => stubNoNetwork());
  afterEach(() => vi.unstubAllGlobals());

  it('runs end to end without network, fills the meta and leaves the input alone', () => {
    const y = pattern();
    const copy = y.slice();
    const r = analyzeDrums({ ...INFO, samples: y, sampleRate: SR }, undefined, { commit: 'abc1234', sourceKind: 'synthetic' });
    expect(y).toEqual(copy);
    expect(r.format).toBe('band-sheets-analysis');
    expect(r.analyzer.name).toBe('drum-ts');
    expect(r.source.kind).toBe('synthetic');
    const m = r.drum.meta;
    expect(m.configHash).toBe(drumConfigHash());
    expect(m.commit).toBe('abc1234');
    expect(m.info).toEqual(INFO);
    expect(m.level).toBe('S-3');
    expect(Object.keys(m.timings.stagesMs)).toEqual([...DRUM_STAGES]);
    expect(m.stages.map((s) => s.name)).toEqual([...DRUM_STAGES]);
    expect(m.timings.audioSec).toBeCloseTo(y.length / SR, 6);
    expect(r.drums.length).toBeGreaterThan(20);
    const q = r.drum.quantized!;
    expect(q.hits.length).toBe(r.drums.filter((h) => h.bar !== undefined).length);
    for (const h of r.drums) expect(['BD', 'SD', 'HH']).toContain(h.inst);
    // the grid fields of drums[] agree with drum.quantized
    for (const g of q.hits) expect(r.drums[g.src]).toMatchObject({ bar: g.bar, tick: g.tick, inst: g.inst });
  });

  it('converts to the app drum model and the section text round-trips through serializeDrums / parseDrums', () => {
    const r = analyzeDrums({ ...INFO, samples: pattern(), sampleRate: SR });
    const t = drumScore(r);
    expect(t.roundTrip).toEqual({ parsed: true, identical: true });
    expect(t.events.length).toBeGreaterThan(0);
    const back = parseDrums(t.tex, timeSigOf(INFO.ts));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.events).toEqual(t.events);
  });

  it('is deterministic apart from timings', () => {
    const y = pattern(2);
    const a = analyzeDrums({ ...INFO, samples: y, sampleRate: SR });
    const b = analyzeDrums({ ...INFO, samples: y, sampleRate: SR });
    expect(b.drums).toEqual(a.drums);
    expect(b.drum.quantized).toEqual(a.drum.quantized);
  });

  it('rejects unusable audio with the input error codes and bad info with a Japanese message', () => {
    const code = (y: Float32Array) => {
      try {
        analyzeDrums({ ...INFO, samples: y, sampleRate: SR });
      } catch (e) {
        return e instanceof DrumInputError ? e.code : String(e);
      }
      return 'no error';
    };
    expect(code(new Float32Array(0))).toBe('empty');
    expect(code(new Float32Array(SR / 2).fill(0.1))).toBe('too-short');
    expect(code(new Float32Array(2 * SR))).toBe('silent');
    const nan = pattern(1);
    nan[1000] = NaN;
    expect(code(nan)).toBe('non-finite');
    expect(() => validateDrumInfo({ ...INFO, bpm: 10 })).toThrow('bpm');
    expect(() => validateDrumInfo({ ...INFO, ts: [4, 3] })).toThrow('拍子');
    expect(() => validateDrumInfo({ ...INFO, startSec: NaN })).toThrow('小節頭');
  });

  it('S-9 (T11) runs without a warning and keeps S-3 BD / SD; S-ext (T12) runs and keeps the S-9 BD', () => {
    const s3 = analyzeDrums({ ...INFO, samples: pattern(2), sampleRate: SR });
    const r = analyzeDrums({ ...INFO, samples: pattern(2), sampleRate: SR, level: 'S-9' });
    expect(r.drum.meta.level).toBe('S-9');
    expect(r.drum.meta.warnings.some((w) => w.includes('not implemented'))).toBe(false);
    const bdSd = (x: typeof r) => x.drums.filter((h) => h.inst === 'BD' || h.inst === 'SD').map((h) => `${h.t} ${h.inst}`);
    expect(bdSd(r)).toEqual(bdSd(s3));
    const ext = analyzeDrums({ ...INFO, samples: pattern(2), sampleRate: SR, level: 'S-ext' });
    expect(ext.drum.meta.level).toBe('S-ext');
    expect(ext.drum.meta.warnings.some((w) => w.includes('not implemented'))).toBe(false);
    expect(ext.drums.filter((h) => h.inst === 'BD').map((h) => h.t)).toEqual(r.drums.filter((h) => h.inst === 'BD').map((h) => h.t));
  });

  it('does not read ground truth or render code (plan decision 4), and the Worker graph avoids alphaTab', () => {
    // T16 (review nice 4): every analysis file of ts/drum, i.e. all but tests, evaluation, scoring and CLI entries
    const notAnalysis = /\.test\.ts$|^(cli|classify_eval|heldout_eval|heldout_guard|synth_heldout_eval|make_templates|onset_eval|pool|report|score|score_check|templates_build)\.ts$/;
    const files = readdirSync(new URL('./', import.meta.url)).filter((f) => f.endsWith('.ts') && !notAnalysis.test(f));
    expect(files).toEqual(expect.arrayContaining(['analyze.ts', 'bands.ts', 'config.ts', 'classify.ts', 'ext.ts', 'types.ts']));
    for (const f of files) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/^import (type )?[^;]*?from '([^']+)'/gm)].map((m) => ({ typeOnly: !!m[1], path: m[2] }));
      expect(imports.length, f).toBeGreaterThan(0);
      for (const { typeOnly, path: i } of imports) {
        // types.ts shares the result SHAPE with render/types.ts (type-only, erased): allowed
        if (!(typeOnly && i === '../../render/types')) expect(i, `${f} imports ${i}`).not.toMatch(/render\/|truth|templates_build|alphatab|node:/i);
        expect(i, `${f} imports ${i}`).not.toMatch(/\/(score|report|pool|heldout_\w+|cli)$|recscore/);
      }
    }
  });
});
