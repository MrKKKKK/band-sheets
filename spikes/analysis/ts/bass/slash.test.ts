import { beforeEach, describe, expect, it } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { DEFAULT_BASS_CONFIG } from './config';
import type { SegmentBass } from './segmentBass';
import { bassKind, beatsIn, heldWeak, slashMarks, withSlash, type SlashChord } from './slash';
import type { AnalysisChord } from './types';

// Generic key-C material only. Pitch classes: C 0, D 2, E 4, F 5, F# 6, G 7, A 9, A# 10, B 11.
const ch = (root: number, quality = 'maj', beats = 4): SlashChord => ({ root, quality, beats });
const sb = (pc: number, confidence = 0.6, second = (pc + 7) % 12): SegmentBass => ({ pc, midi: 36 + pc, confidence, second: { pc: second, confidence: 1 - confidence } });
const cfg = { minConfidence: 0.1, minBeats: 1, weakMinConfidence: 0.4 };

describe('slash marks (B-2)', () => {
  beforeEach(() => stubNoNetwork());

  it('default config: minConfidence chosen in T6, minBeats 1, weakMinConfidence chosen in T9', () => {
    expect(DEFAULT_BASS_CONFIG.slash).toEqual({ minConfidence: 0.1, minBeats: 1, weakMinConfidence: 0.4 });
  });

  it('inversion: the 3rd or 5th of a triad, the 7th of a seventh chord (C/E, C/G, G7/F)', () => {
    const chords = [ch(0), ch(5), ch(0), ch(7, '7')];
    const bass = [sb(4), sb(5), sb(7), sb(5)];
    expect(slashMarks(chords, bass, cfg).map((m) => m && [m.bass, m.kind])).toEqual([[4, 'inversion'], null, [7, 'inversion'], [5, 'inversion']]);
  });

  it('5th (6/4): an inversion only at weakMinConfidence; below it only a pedal or a passing bass (T9)', () => {
    // C/G alone (power-chord left hand): no mark below 0.4, a mark at 0.4
    expect(slashMarks([ch(2, 'min'), ch(0), ch(9, 'min')], [sb(2), sb(7, 0.39), sb(9)], cfg)[1]).toBeNull();
    expect(slashMarks([ch(2, 'min'), ch(0), ch(9, 'min')], [sb(2), sb(7, 0.4), sb(9)], cfg)[1]).toMatchObject({ bass: 7, kind: 'inversion' });
    // passing 6/4 (F - C/G - Am) and pedal 6/4 (C/G - G) are kept at low confidence
    expect(slashMarks([ch(5), ch(0), ch(9, 'min')], [sb(5), sb(7, 0.2), sb(9)], cfg)[1]).toMatchObject({ bass: 7, kind: 'passing' });
    expect(slashMarks([ch(0), ch(7)], [sb(7, 0.2), sb(7)], cfg)[0]).toMatchObject({ bass: 7, kind: 'pedal' });
    // the 3rd is not affected
    expect(slashMarks([ch(0)], [sb(4, 0.2)], cfg)[0]).toMatchObject({ bass: 4, kind: 'inversion' });
  });

  it('minor 3rd (Am/C): an inversion only at weakMinConfidence too; held back as a candidate below it (T10)', () => {
    expect(slashMarks([ch(9, 'min')], [sb(0, 0.39)], cfg)).toEqual([null]);
    expect(slashMarks([ch(9, 'min')], [sb(0, 0.4)], cfg)[0]).toMatchObject({ bass: 0, kind: 'inversion' });
    expect(heldWeak([ch(9, 'min')], [sb(0, 0.3)], [null], cfg)).toEqual([{ pc: 0, confidence: 1 }]);
    // the major 3rd is not weak
    expect(slashMarks([ch(0)], [sb(4, 0.2)], cfg)[0]).toMatchObject({ bass: 4, kind: 'inversion' });
  });

  it('lineEnd (B-3): the 6th that ends a stepwise line under one chord (C - C/B - C/A# - C/A, Am - ... - Am/F#)', () => {
    const chords = [ch(0), ch(0), ch(0), ch(0), ch(5)];
    const bass = [sb(0), sb(11), sb(10), sb(9), sb(5)];
    expect(slashMarks(chords, bass, cfg, true).map((m) => m?.kind ?? null)).toEqual([null, 'passing', 'passing', 'passing', null]);
    expect(slashMarks(chords, bass, cfg)[3]).toBeNull(); // off without lineEnd
    const minor = slashMarks([ch(9, 'min'), ch(9, 'min'), ch(9, 'min'), ch(9, 'min'), ch(5)], [sb(9), sb(8), sb(7), sb(6), sb(5)], cfg, true);
    expect(minor[3]).toMatchObject({ bass: 6, kind: 'passing' });
    // a 6th reached by a leap is not a line end
    expect(slashMarks([ch(0), ch(0), ch(5)], [sb(0), sb(9), sb(5)], cfg, true)[1]).toBeNull();
  });

  it('heldWeak: a 5th held back stays a candidate on the unmarked chord (T9)', () => {
    const chords = [ch(5), ch(0), ch(9, 'min'), ch(0), ch(2, 'min')];
    const bass = [sb(5), sb(7, 0.3), sb(9), sb(7, 0.3), sb(2)];
    const marks = slashMarks(chords, bass, cfg);
    expect(marks.map((m) => m?.kind ?? null)).toEqual([null, 'passing', null, null, null]);
    // marked (passing) -> no held candidate; the lone C/G below 0.4 -> held
    expect(heldWeak(chords, bass, marks, cfg)).toEqual([null, null, null, { pc: 7, confidence: 1 }, null]);
    expect(heldWeak([ch(0)], [sb(7, 0.05)], [null], cfg)).toEqual([null]); // below minConfidence
    expect(heldWeak([ch(0)], [sb(7, 0.3)], [null], cfg)).toEqual([{ pc: 7, confidence: 1 }]);
    expect(heldWeak([ch(0)], [sb(7, 0.5)], [null], cfg)).toEqual([null]); // not held back by the 5th rule
  });

  it('passing: a non-chord bass one or two semitones from both neighbours, same direction (C - C/B - C/A#)', () => {
    const chords = [ch(0), ch(0), ch(0), ch(5)];
    const bass = [sb(0), sb(11), sb(10), sb(5)];
    const marks = slashMarks(chords, bass, cfg);
    expect(marks[1]).toMatchObject({ bass: 11, kind: 'passing' });
    expect(marks[2]).toBeNull(); // A# -> F is not a step: no rule explains it
    expect(bassKind(1, chords, bass, cfg)).toBe('passing');
  });

  it('passing needs minBeats and one direction', () => {
    const short = [ch(0), ch(0, 'maj', 0.5), ch(0)];
    expect(slashMarks(short, [sb(0), sb(11), sb(10)], cfg)[1]).toBeNull();
    // up then down (C - D - C under C): a neighbour note, not a passing bass
    expect(slashMarks([ch(0), ch(0), ch(5)], [sb(0), sb(2), sb(0)], cfg)[1]).toBeNull();
    // the first and last segment have one neighbour only
    expect(slashMarks([ch(0), ch(0)], [sb(11), sb(10)], cfg)).toEqual([null, null]);
  });

  it('pedal: the same bass as a neighbour under changing chords (C - F/C - G/C - C)', () => {
    const chords = [ch(0), ch(5), ch(7), ch(0)];
    const bass = [sb(0), sb(0), sb(0), sb(0)];
    expect(slashMarks(chords, bass, cfg).map((m) => m && [m.bass, m.kind])).toEqual([null, [0, 'pedal'], [0, 'pedal'], null]);
  });

  it('no mark when the bass is the root, unexplained, or below minConfidence', () => {
    expect(slashMarks([ch(0)], [sb(0)], cfg)).toEqual([null]);
    expect(slashMarks([ch(9), ch(0), ch(2)], [sb(9), sb(6), sb(2)], cfg)[1]).toBeNull(); // F# under C between A and D
    expect(slashMarks([ch(0)], [sb(4, 0.09)], cfg)).toEqual([null]);
    expect(slashMarks([ch(0)], [sb(4, 0.1)], cfg)[0]).toMatchObject({ bass: 4, confidence: 0.1 });
  });

  it('second candidate = root: the mark is still written and keeps the root as its second candidate', () => {
    const m = slashMarks([ch(0)], [sb(4, 0.3, 0)], cfg)[0];
    expect(m).toEqual({ bass: 4, kind: 'inversion', confidence: 0.3, second: { pc: 0, confidence: 0.7 } });
  });

  it('length mismatch throws', () => {
    expect(() => slashMarks([ch(0)], [], cfg)).toThrow(/1 chords but 0/);
    expect(() => withSlash([], [null])).toThrow(/0 chords but 1/);
  });
});

describe('withSlash (text and JSON fields)', () => {
  const c = (text: string | undefined): AnalysisChord => ({ start: 0, end: 2, root: 'C', quality: 'maj', bass: null, confidence: 0.8, ...(text === undefined ? {} : { text }) });

  it('writes bass, bassConfidence, bassKind and C/E; the low-confidence ? stays last', () => {
    const marks = [{ bass: 4, kind: 'inversion' as const, confidence: 0.4, second: { pc: 0, confidence: 0.6 } }];
    expect(withSlash([c('C')], marks)[0]).toEqual({ ...c('C/E'), bass: 'E', bassConfidence: 0.4, bassKind: 'inversion', bassCandidates: [{ bass: 'C', confidence: 0.6 }] });
    expect(withSlash([c('C?')], marks)[0].text).toBe('C/E?');
    expect(withSlash([c(undefined)], marks)[0]).not.toHaveProperty('text');
    expect(withSlash([c('C')], [{ ...marks[0], bass: 10, kind: 'passing' }])[0].text).toBe('C/A#');
  });

  it('unmarked chords are returned as they are (v1a output unchanged)', () => {
    const one = c('C?');
    expect(withSlash([one], [null])[0]).toBe(one);
    expect(withSlash([one], [null], [null])[0]).toBe(one);
  });

  it('a held-back 5th is written as bassCandidates only (bass and text stay as v1a, T9)', () => {
    expect(withSlash([c('C?')], [null], [{ pc: 7, confidence: 1 }])[0]).toEqual({ ...c('C?'), bassCandidates: [{ bass: 'G', confidence: 1 }] });
  });
});

describe('beatsIn', () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5];
  it('counts beat times in [start, end), at least 1', () => {
    expect(beatsIn(0, 2, beats)).toBe(4);
    expect(beatsIn(0.9995, 2, beats)).toBe(2);
    expect(beatsIn(1.1, 1.3, beats)).toBe(1);
  });
});
