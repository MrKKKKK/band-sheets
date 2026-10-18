import { describe, expect, it } from 'vitest';
import type { ChordSegment } from './chords';
import { DEFAULT_CONFIG } from './config';
import { buildResult, keyRuns, methods } from './result';

const seg = (
  startBeat: number,
  endBeat: number,
  root: number | null,
  quality: string,
  confidence: number,
  extra: Partial<ChordSegment> = {},
): ChordSegment => ({
  startBeat,
  endBeat,
  root,
  quality,
  confidence,
  lowConfidence: root !== null && confidence < 0.93,
  bass: null,
  candidates: [],
  perBeat: 2,
  ...extra,
});

describe('buildResult', () => {
  const times = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  const base = {
    times,
    duration: 4.0,
    downbeats: {
      phase: 1,
      beatsPerBar: 4,
      confidence: 0.4,
      scores: [0, 0.4, 0, 0],
    },
    sections: [{ startBar: 0, endBar: 2, label: 'A' }],
    key: { tonic: 'C', mode: 'major' as const, confidence: 0.3 },
    cfg: DEFAULT_CONFIG,
  };

  it('beats: bar / beat only from the phase on, downbeat every beatsPerBar', () => {
    const r = buildResult({ ...base, segments: [] });
    expect(r.beats[0]).toEqual({ t: 0.5, downbeat: false });
    expect(r.beats[1]).toEqual({ t: 1.0, downbeat: true, bar: 0, beat: 0 });
    expect(r.beats[5]).toEqual({ t: 3.0, downbeat: true, bar: 1, beat: 0 });
    expect(r.timeSignature).toEqual({ num: 4, den: 4, confidence: 0.4 });
  });

  it('chords: gaps omitted, column times (half beats), end past last column = audio end, ? and candidates', () => {
    const r = buildResult({
      ...base,
      segments: [
        seg(0, 3, null, 'maj', 1.0),
        seg(3, 7, 0, 'maj', 0.99, {
          candidates: [
            { root: 0, quality: 'maj', prob: 0.99 },
            { root: 9, quality: 'min', prob: 0.01 },
          ],
        }),
        seg(7, 12, 7, '7', 0.5),
      ],
    });
    expect(r.chords).toHaveLength(2);
    expect(r.chords[0]).toEqual({
      start: 1.25,
      end: 2.25,
      root: 'C',
      quality: 'maj',
      bass: null,
      text: 'C',
      confidence: 0.99,
      candidates: [
        { name: 'C', root: 'C', quality: 'maj', prob: 0.99 },
        { name: 'Am', root: 'A', quality: 'min', prob: 0.01 },
      ],
    });
    expect(r.chords[1].text).toBe('G7?');
    expect(r.chords[1].start).toBe(2.25);
    expect(r.chords[1].end).toBe(4.0); // column 12 is past the last column (6 beats x 2)
  });

  it('sections: beat time at phase + bar * bpb, past the last beat = audio end', () => {
    const r = buildResult({ ...base, segments: [] });
    expect(r.sections).toEqual([{ start: 1.0, end: 4.0, label: 'A' }]);
  });

  it('analyzer block, key, keys and key order as in Python', () => {
    const r = buildResult({
      ...base,
      segments: [],
      timings: { load: 1.23456, total: 2.0004 },
      barKeys: [{ bar: 0, tonic: 0, mode: 'major', confidence: 1 }],
      warnings: ['keytrack-not-converged'],
    });
    expect(Object.keys(r)).toEqual([
      'format',
      'version',
      'source',
      'analyzer',
      'beats',
      'timeSignature',
      'sections',
      'chords',
      'key',
      'keys',
    ]);
    expect(r.source).toEqual({
      kind: 'recording',
      durationSec: 4.0,
      click: false,
    });
    expect(r.analyzer).toEqual({
      name: 'dsp-v1',
      version: 'adec583eb3c6',
      methods: methods(DEFAULT_CONFIG),
      configHash: 'adec583eb3c6',
      config: {},
      timingsSec: { load: 1.235, total: 2.0 },
      warnings: ['keytrack-not-converged'],
    });
    expect(methods(DEFAULT_CONFIG)).toEqual([
      'beats:ellis',
      'chroma:cqt',
      'chords:template+viterbi',
      'downbeat:chord+bass+onset',
      'sections:novelty',
      'key:krumhansl-schmuckler',
      'config:adec583eb3c6',
    ]);
    expect(r.key).toEqual({ tonic: 'C', mode: 'major', confidence: 0.3 });
    const noWarn = buildResult({ ...base, segments: [] });
    expect('warnings' in noWarn.analyzer).toBe(false);
    expect('timingsSec' in noWarn.analyzer).toBe(false);
    expect('keys' in noWarn).toBe(false);
  });
});

describe('keyRuns', () => {
  it('joins consecutive equal keys (sorted by bar) with the mean confidence', () => {
    expect(
      keyRuns([
        { bar: 2, tonic: 7, mode: 'major', confidence: 0.5 },
        { bar: 0, tonic: 0, mode: 'major', confidence: 1.0 },
        { bar: 1, tonic: 0, mode: 'major', confidence: 0.5 },
        { bar: 3, tonic: 7, mode: 'minor', confidence: 0.25 },
      ]),
    ).toEqual([
      { startBar: 0, tonic: 'C', mode: 'major', confidence: 0.75 },
      { startBar: 2, tonic: 'G', mode: 'major', confidence: 0.5 },
      { startBar: 3, tonic: 'G', mode: 'minor', confidence: 0.25 },
    ]);
    expect(keyRuns([])).toEqual([]);
  });
});
