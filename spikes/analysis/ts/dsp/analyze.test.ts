import { describe, expect, it } from 'vitest';
import { parseArgs } from '../cli';
import { analyze, STAGES } from './analyze';
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
    for (const m of [...notes, notes[0] - 24]) s += Math.sin(2 * Math.PI * 440 * Math.pow(2, (m - 69) / 12) * t);
    y[i] = 0.1 * env * s + (tb < 0.01 ? 0.3 * Math.sin(2 * Math.PI * 2000 * t) * (1 - tb / 0.01) : 0);
  }
  return y;
}

describe('analyze', () => {
  it('runs every stage in Python order and builds a result JSON', () => {
    const seen: string[] = [];
    const out = analyze(synth(16), { onStage: (s) => seen.push(s.name) });
    expect(seen).toEqual([...STAGES]);
    const r = out.result;
    expect(r.format).toBe('band-sheets-analysis');
    expect(r.analyzer.configHash).toBe('adec583eb3c6');
    expect(Object.keys(r.analyzer.timingsSec ?? {})).toEqual([...STAGES, 'total']);
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

  it('silence: no beats, no chords, still a valid result', () => {
    const r = analyze(new Float32Array(SR * 3)).result;
    expect(r.beats).toEqual([]);
    expect(r.chords).toEqual([]);
    expect(r.sections).toEqual([]);
    expect(r.key).toEqual({ tonic: 'C', mode: 'major', confidence: 0 });
  });

  it('timingsSec can be left out, preTimings come first', () => {
    const y = synth(4);
    expect('timingsSec' in analyze(y, { timings: false }).result.analyzer).toBe(false);
    const t = analyze(y, { preTimings: { resample: 0.5 } }).result.analyzer.timingsSec ?? {};
    expect(Object.keys(t)[0]).toBe('resample');
    expect(t.total).toBeGreaterThanOrEqual(0.5);
  });

  it('rejects a non-default config', () => {
    const cfg = { ...DEFAULT_CONFIG, chords: { ...DEFAULT_CONFIG.chords, vocab: 'v1' } } as AnalyzerConfig;
    expect(() => analyze(new Float32Array(SR), { cfg })).toThrow(/chords.vocab="v1" is not supported/);
  });
});

describe('cli parseArgs', () => {
  it('reads input, -o, --config, --sr', () => {
    expect(parseArgs(['a.wav'])).toEqual({ input: 'a.wav', out: undefined, config: undefined, sr: 22050 });
    expect(parseArgs(['y.f32', '-o', 'r.json', '--config', 'c.json', '--sr', '44100'])).toEqual({
      input: 'y.f32',
      out: 'r.json',
      config: 'c.json',
      sr: 44100,
    });
  });
});
