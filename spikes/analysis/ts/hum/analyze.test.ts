import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../browser/wav';
import { toMono } from '../dsp/core/resample';
import { stubNoNetwork } from '../parity/noNetwork';
import { AnalysisInputError, analyzeHum, validateHumInfo } from './analyze';
import { humConfigHash } from './config';
import { parseArgs, parseInfoTxt } from './cli';
import type { HumInfo } from './types';

const SR = 44100;
const INFO: HumInfo = { bpm: 120, ts: [4, 4], startSec: 1 };

/** 1 s silence, then 8 quarter-note-ish tones (0.5 s each, 0.1 s gaps) with 3 harmonics. */
function tones(midis: number[], sr = SR): Float32Array {
  const noteSec = 0.5;
  const y = new Float32Array(Math.round((1 + midis.length * noteSec + 0.5) * sr));
  midis.forEach((m, k) => {
    const f = 440 * 2 ** ((m - 69) / 12);
    const a = Math.round((1 + k * noteSec) * sr);
    const b = Math.round((1 + k * noteSec + noteSec - 0.1) * sr);
    for (let i = a; i < b; i++) {
      const t = i / sr;
      const env = Math.min(1, (i - a) / (0.02 * sr), (b - i) / (0.02 * sr));
      y[i] = 0.3 * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
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
    const r = analyzeHum(y, SR, INFO, { commit: 'abc1234', f0Track: true, sourceKind: 'synthetic' });
    expect(y).toEqual(copy); // input untouched
    expect(r.format).toBe('band-sheets-analysis');
    expect(r.analyzer.name).toBe('hum-ts');
    expect(r.melody.notes.map((n) => n.midi)).toEqual(midis);
    const q = r.melody.quantized;
    expect(q.bpm).toBe(120);
    expect(q.events.filter((e) => e.kind === 'note')).toHaveLength(midis.length);
    const m = r.hum.meta;
    expect(m.configHash).toBe(humConfigHash());
    expect(m.configName).toBe('hum-v1');
    expect(m.commit).toBe('abc1234');
    expect(m.info).toEqual(INFO);
    for (const k of ['validate', 'resample', 'f0', 'level', 'notes', 'quantize']) expect(m.timings.stagesMs[k]).toBeGreaterThanOrEqual(0);
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
    expect(() => validateHumInfo({ ...INFO, startSec: -1 })).toThrow(/開始/);
    expect(() => analyzeHum(tones([60]), SR, { ...INFO, bpm: NaN })).toThrow(/bpm/);
  });

  const wavPath = join(import.meta.dirname, '..', '..', 'out', 'hum', 'syn-h0-saints-s1.wav');
  it.skipIf(!existsSync(wavPath))('runs on a synthetic variant file', () => {
    const wav = decodeWav(new Uint8Array(readFileSync(wavPath)));
    const r = analyzeHum(toMono(wav.channels), wav.sampleRate, { bpm: 116, ts: [4, 4], startSec: 2.642966 });
    expect(r.melody.notes.length).toBeGreaterThan(20);
  });
});

describe('cli helpers', () => {
  it('parses the intake header without reading the melody', () => {
    const txt = 'bpm: 100\n拍子：３/４\n開始: 2.5\n歌い方: a\nメロディ:\nbpm: 999\n';
    expect(parseInfoTxt(txt)).toEqual({ bpm: 100, ts: [3, 4], startSec: 2.5 });
  });
  it('parses arguments', () => {
    const a = parseArgs(['x.wav', '--bpm', '90', '--ts', '3/4', '--start', '1.5', '-o', 'o.json', '--commit', 'abc']);
    expect(a).toMatchObject({ input: 'x.wav', bpm: 90, ts: [3, 4], start: 1.5, out: 'o.json', commit: 'abc' });
    expect(() => parseArgs(['--nope'])).toThrow();
  });
});

describe('cli held-out guard', () => {
  it('refuses a held-out wav of the manifest', async () => {
    const man = join(import.meta.dirname, '..', '..', 'out', 'hum', 'manifest.json');
    if (!existsSync(man)) return;
    const held = (JSON.parse(readFileSync(man, 'utf8')) as { variants: { heldOut: boolean; wav: string }[] }).variants.find((v) => v.heldOut);
    if (!held) return;
    const { run } = await import('./cli');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => run([join('out', 'hum', held.wav), '--bpm', '100', '--start', '1'])).toThrow('exit');
    expect(String(err.mock.calls[0][0])).toMatch(/held-out/);
    exit.mockRestore();
    err.mockRestore();
  });
});
