import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../../../test/noNetwork';
import {
  AnalysisInputError,
  analyze,
  MIN_INPUT_SEC,
  STAGES,
  validateInput,
  type InputErrorCode,
} from './analyze';
import { DEFAULT_CONFIG, type AnalyzerConfig } from './config';

const SR = 22050;

/** A few bars of block chords (C - F - G - C, one per bar) with a click on every beat, 120 BPM. */
function synth(seconds: number): Float32Array {
  const y = new Float32Array(Math.round(seconds * SR));
  const chords = [
    [60, 64, 67],
    [65, 69, 72],
    [67, 71, 74],
    [60, 64, 67],
  ];
  const beat = 0.5;
  for (let i = 0; i < y.length; i++) {
    const t = i / SR;
    const b = Math.floor(t / beat);
    const notes = chords[Math.floor(b / 4) % 4];
    const tb = t - b * beat;
    const env = Math.exp(-3 * tb);
    let s = 0;
    for (const m of [...notes, notes[0] - 24])
      s += Math.sin(2 * Math.PI * 440 * Math.pow(2, (m - 69) / 12) * t);
    y[i] =
      0.1 * env * s +
      (tb < 0.01
        ? 0.3 * Math.sin(2 * Math.PI * 2000 * t) * (1 - tb / 0.01)
        : 0);
  }
  return y;
}

// The whole pipeline must not touch the network (privacy rule): every analyze() test runs with it stubbed out.
beforeEach(() => stubNoNetwork());
afterEach(() => vi.unstubAllGlobals());

describe('analyze', () => {
  it('runs every stage in Python order and builds a result JSON', () => {
    const seen: string[] = [];
    const out = analyze(synth(16), { onStage: (s) => seen.push(s.name) });
    expect(seen).toEqual([...STAGES]);
    const r = out.result;
    expect(r.format).toBe('band-sheets-analysis');
    expect(r.analyzer.configHash).toBe('adec583eb3c6');
    expect(Object.keys(r.analyzer.timingsSec ?? {})).toEqual([
      ...STAGES,
      'total',
    ]);
    expect(r.beats.length).toBeGreaterThan(20);
    expect(r.timeSignature.num).toBe(4);
    expect(r.chords.length).toBeGreaterThan(0);
    for (const c of r.chords) {
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.candidates?.length).toBe(3);
    }
    expect(r.chords.map((c) => c.root)).toContain('F');
    expect(r.keys?.length).toBeGreaterThan(0);
    expect(out.mem.peak).toBeGreaterThan(0);
    expect(out.stats.every((s) => s.memPeak >= s.memLive)).toBe(true);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('timingsSec can be left out, preTimings come first', () => {
    const y = synth(4);
    expect('timingsSec' in analyze(y, { timings: false }).result.analyzer).toBe(
      false,
    );
    const t =
      analyze(y, { preTimings: { resample: 0.5 } }).result.analyzer
        .timingsSec ?? {};
    expect(Object.keys(t)[0]).toBe('resample');
    expect(t.total).toBeGreaterThanOrEqual(0.5);
  });

  it('rejects a non-default config', () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      chords: { ...DEFAULT_CONFIG.chords, vocab: 'v1' },
    } as AnalyzerConfig;
    expect(() => analyze(new Float32Array(SR), { cfg })).toThrow(
      /chords.vocab="v1" is not supported/,
    );
  });
});

/** The AnalysisInputError code thrown by f (fails the test when f does not throw one). */
function codeOf(f: () => unknown): InputErrorCode {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(AnalysisInputError);
    const err = e as AnalysisInputError;
    expect(err.message).toMatch(/[ぁ-んァ-ン一-龥]/); // a Japanese message for the user
    return err.code;
  }
  throw new Error('no AnalysisInputError thrown');
}

describe('input validation (never a silent "0 beats, C major" result)', () => {
  const filled = (sec: number, v: number) =>
    new Float32Array(Math.round(sec * SR)).fill(v);
  it('empty', () =>
    expect(codeOf(() => analyze(new Float32Array(0)))).toBe('empty'));
  it('0.1 s and just under the minimum are too short', () => {
    expect(codeOf(() => analyze(synth(0.1)))).toBe('too-short');
    expect(codeOf(() => analyze(synth(MIN_INPUT_SEC - 0.01)))).toBe(
      'too-short',
    );
  });
  it('silence (all zero) and denormals only', () => {
    expect(codeOf(() => analyze(filled(10, 0)))).toBe('silent');
    expect(codeOf(() => analyze(filled(10, 1e-40)))).toBe('silent');
    expect(new Float32Array([1e-40])[0]).toBeGreaterThan(0); // really a float32 denormal, not 0
  });
  it('effectively silent: at most one 16-bit LSB', () => {
    const y = filled(3, 0);
    for (let i = 0; i < y.length; i += 7) y[i] = (i % 2 ? 1 : -1) * 2 ** -15;
    expect(codeOf(() => analyze(y))).toBe('silent');
  });
  it('NaN / +-Infinity anywhere', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const y = synth(4);
      y[12345] = bad;
      expect(codeOf(() => analyze(y))).toBe('non-finite');
    }
  });
  it('NaN wins over too-short / silent (the file is broken)', () => {
    expect(codeOf(() => analyze(new Float32Array([0, NaN])))).toBe(
      'non-finite',
    );
  });
  it('non-silent but no beat grid: 0 or 1 beat -> no-beats', () => {
    const lastClick = filled(5, 0);
    lastClick[lastClick.length - 1] = 0.9; // onset strength 0 everywhere -> 0 beats
    expect(codeOf(() => analyze(lastClick))).toBe('no-beats');
    expect(codeOf(() => analyze(filled(5, 0.5)))).toBe('no-beats'); // DC -> 1 beat, no interval
  });
  it('validateInput uses the given rate; { y } input is taken over', () => {
    expect(() => validateInput(new Float32Array(44100), 44100)).toThrow(/無音/);
    expect(() =>
      validateInput(new Float32Array(44099).fill(0.1), 44100),
    ).toThrow(/短すぎ/);
    const box: { y: Float32Array | null } = { y: synth(4) };
    expect(analyze(box).result.beats.length).toBeGreaterThan(4);
    expect(box.y).toBeNull();
  });
});
