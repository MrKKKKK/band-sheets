import { describe, expect, it } from 'vitest';
import { renderReport, scoreRow, type ReportRow } from './report';
import type { HumNote, QuantizedMelody } from './types';

const hn = (start: number, end: number, midi: number, candidates: HumNote['candidates'] = []): HumNote => ({ start, end, midi, cents: 0, confidence: 1, candidates });

describe('scoreRow', () => {
  it('computes note, f0 and tick scores from one take', () => {
    const q: QuantizedMelody = {
      bpm: 120,
      ts: [4, 4],
      startSec: 0,
      onsetBiasSec: 0,
      grid: 'sixteenth',
      events: [
        { kind: 'note', startTick: 0, ticks: 4, midi: 60, src: 0, candidates: [], gridCandidates: [], confidence: 1 },
        { kind: 'note', startTick: 4, ticks: 4, midi: 63, src: 1, candidates: [], gridCandidates: [{ startTick: 4, ticks: 4, confidence: 0.3 }], confidence: 1 },
        { kind: 'rest', startTick: 8, ticks: 4 },
      ],
    };
    const s = scoreRow({
      truthNotes: [{ start: 0, end: 0.5, midi: 60 }, { start: 0.5, end: 1, midi: 62 }],
      estNotes: [hn(0, 0.5, 60), hn(0.5, 1, 63, [{ midi: 62, confidence: 0.3 }])],
      truthTicks: [{ startTick: 0, ticks: 4, midi: 60 }, { startTick: 4, ticks: 4, midi: 62 }, { startTick: 8, ticks: 2, midi: 64 }],
      estQuant: q,
    });
    expect(s['noteF.onset']).toBeCloseTo(0.5, 12);
    expect(s['pitchCand.k1']).toBeCloseTo(0.5, 12);
    expect(s['pitchCand.k2']).toBe(1);
    expect(s['quant.exactAcc']).toBeCloseTo(0.5, 12); // the 2-tick decoration is dropped from the truth
    expect(s['edit.count']).toBe(1);
    expect(s['edit.perNote']).toBeCloseTo(0.5, 12);
    expect(s['f0.rpa']).toBeUndefined();
  });
});

describe('renderReport', () => {
  const mk = (id: string, kind: 'synthetic' | 'recording', level: string, f: number): ReportRow => ({ id, kind, level, scores: { 'noteF.onset': f } });
  it('prints synthetic per level and per variant, recordings only as aggregates', () => {
    const md = renderReport([mk('syn-a', 'synthetic', 'H1', 0.9), mk('syn-b', 'synthetic', 'H1', 0.7), mk('hum-01-a', 'recording', 'rec', 0.5), mk('hum-02-b', 'recording', 'rec', 0.3)]);
    expect(md).toContain('syn-a');
    expect(md).toContain('| H1 | 2 | 0.800 |');
    expect(md).not.toContain('hum-01-a');
    expect(md).not.toContain('hum-02-b');
    expect(md).toContain('| rec mean | 2 | 0.400 |');
    expect(md).toContain('| rec min | 2 | 0.300 |');
    expect(md).toContain('| rec max | 2 | 0.500 |');
  });
  it('missing metrics print as a dash', () => {
    expect(renderReport([mk('x', 'synthetic', 'H0', 1)])).toContain('| - |');
  });
});

describe('T15 M1: note F pitch = WRITTEN note (score MIDI), not the sung pitch', () => {
  // The truth note is written C4 (60) but sung 80 cents sharp; the analyzer picked 61 (the nearest semitone to what was sung)
  // with a residual of -20 cents. Sung-pitch definition: |60.8 - 60.8| = 0 -> "right". Written definition: 61 != 60 -> wrong.
  const truth = [{ start: 0, end: 0.5, midi: 60, cents: 80 }];
  const est: HumNote[] = [{ start: 0, end: 0.5, midi: 61, cents: -20, confidence: 1, candidates: [] }];
  it('a note sung > 50 cents off the written note is NOT right when the analyzer chose another semitone', () => {
    const s = scoreRow({ truthNotes: truth, estNotes: est });
    expect(s['noteF.onset']).toBe(0);
    expect(s['noteF_sungPitch.onset']).toBe(1); // old definition kept under a different name
  });
  it('the written note is right when the analyzer picks it, even if the voice was > 50 cents away', () => {
    const e2: HumNote[] = [{ ...est[0], midi: 60, cents: 0 }];
    const s = scoreRow({ truthNotes: truth, estNotes: e2 });
    expect(s['noteF.onset']).toBe(1);
    expect(s['noteF.onsetOffset']).toBe(1);
    expect(s['noteF_sungPitch.onset']).toBe(0); // sung 60.8 vs 60.0 = 80 cents apart: the old metric punished the correct written note
  });
});
