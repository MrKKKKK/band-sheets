import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { runSlice } from './slice';
import { synthClip } from './synth';

describe('runSlice (T8 vertical slice)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exactly 60 s at 44.1 kHz (full / bass CQT frame counts differ there) runs without network', () => {
    stubNoNetwork();
    const stages: string[] = [];
    const r = runSlice({ channels: [synthClip(44100, 60)], sr: 44100 }, { onStage: (s) => stages.push(s.name) });
    expect(stages).toEqual(['resample', 'hpss', 'onset', 'beats', 'chroma', 'chords']);
    expect(r.durationSec).toBeCloseTo(60, 6);
    expect(r.tempoRule).toBe('skipped');
    expect(Math.abs(r.tempo - 120)).toBeLessThan(2); // 120 BPM synth
    expect(r.columnLabels.length).toBe(2 * r.beats.length);
    expect(r.columnTimes.length).toBe(r.columnLabels.length);
    // the synth plays C G Am F, one bar each
    const texts = new Set(r.chords.map((c) => c.text.replace('?', '')));
    for (const c of ['C', 'G', 'Am', 'F']) expect(texts.has(c)).toBe(true);
    expect(r.mem.peak).toBeGreaterThan(0);
  }, 120_000);

  it('empty input gives an empty result', () => {
    const r = runSlice({ channels: [new Float32Array(0)], sr: 44100 });
    expect(r.beats).toEqual([]);
    expect(r.chords).toEqual([]);
  });
});
