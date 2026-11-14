import { describe, expect, it } from 'vitest';
import { bassNoteScores, beatWindows, clicheRuns, editCounts, editDiff, mapVocab, normalizeTruthSlash, noteToPc, scoreBass, type ScoreBeat, type ScoreChord } from './score';

// 120 BPM, 8 beats (0..3.5 s); windows of 0.5 s; eighth points at beat + 0.125 and + 0.375.
const beats: ScoreBeat[] = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5, downbeat: i % 4 === 0 }));
const ch = (start: number, end: number, root: string, quality = 'maj', bass: string | null = null): ScoreChord => ({ start, end, root, quality, bass });

describe('mapVocab / noteToPc', () => {
  it('maps the documented forms', () => {
    expect(mapVocab('maj')).toBe('maj');
    expect(mapVocab('6')).toBe('maj');
    expect(mapVocab('9')).toBe('7');
    expect(mapVocab('m9')).toBe('min7');
    expect(mapVocab('sus2')).toBeNull();
    expect(mapVocab('7sus4')).toBe('sus4');
    expect(mapVocab('m7b5')).toBe('m7b5');
    expect(mapVocab('7(#5)')).toBeNull();
    expect(mapVocab(null)).toBeNull();
  });
  it('note names', () => {
    expect(noteToPc('Db')).toBe(1);
    expect(noteToPc('Cb')).toBe(11);
    expect(noteToPc('B#')).toBe(0);
    expect(() => noteToPc('H')).toThrow();
  });
});

describe('beatWindows', () => {
  it('extends the last window by the median interval', () => {
    expect(beatWindows(beats)[7]).toEqual([3.5, 3.75, 4]);
  });
});

describe('scoreBass hand calculation', () => {
  // truth: C | C/E | G | G/B ... 2 beats each = 4 scored points of weight 0.5 -> 2 per chord... (4 points per chord = 2.0)
  const truth = [ch(0, 1, 'C'), ch(1, 2, 'C', 'maj', 'E'), ch(2, 3, 'G'), ch(3, 4, 'G', '7', 'B')];
  it('perfect result', () => {
    const s = scoreBass(truth, truth, beats);
    expect(s.segBass.rate).toBe(1);
    expect(s.slash).toMatchObject({ recall: 1, precision: 1, f: 1, truthSlash: 4, hit: 4 });
    expect(s.wrongSlash.rate).toBe(0);
    expect(s.nPoints).toBe(8);
  });
  it('root-only result: slash recall 0, seg bass half right, no false slash', () => {
    const res = truth.map((c) => ({ ...c, bass: null }));
    const s = scoreBass(truth, res, beats);
    expect(s.segBass.rate).toBe(0.5);
    expect(s.slash.recall).toBe(0);
    expect(s.slash.precision).toBeNull();
    expect(s.slash.f).toBe(0);
    expect(s.wrongSlash.rate).toBe(0);
  });
  it('wrong slash names: E and B right, a false /D on the second C, wrong name on G/B', () => {
    const res = [ch(0, 0.5, 'C', 'maj', 'D'), ch(0.5, 1, 'C'), ch(1, 2, 'C', 'maj', 'E'), ch(2, 3, 'G'), ch(3, 4, 'G', '7', 'D')];
    const s = scoreBass(truth, res, beats);
    // truth /X points: beats 2,3 (C/E, hit) and 6,7 (G/B, result /D = miss): recall 4/8 -> 2.0/4.0
    expect(s.slash.recall).toBe(0.5);
    // result /X points: 2 (D) + 4 (E) + 4 (D) = 10 half-points = 5.0 ... precision = 2.0 / 5.0? computed below
    expect(s.slash.resultSlash).toBe(5);
    expect(s.slash.precision).toBeCloseTo(2 / 5, 12);
    // no-slash truth: first C (4 pts = 2.0) and G (2.0); false /D on the first half of the first C: 2 points = 1.0
    expect(s.wrongSlash).toMatchObject({ noSlashTruth: 4, falseSlash: 1, rate: 0.25 });
    expect(s.slash.f).toBeCloseTo((2 * 0.5 * 0.4) / 0.9, 12);
  });
  it('drops truth chords whose quality is outside the vocabulary', () => {
    const t2 = [ch(0, 2, 'C', 'sus2', 'E'), ch(2, 4, 'G')];
    const s = scoreBass(t2, t2, beats);
    expect(s.nPoints).toBe(4);
    expect(s.slash.truthSlash).toBe(0);
    expect(s.slashRecall).toBeNull();
  });
  it('unparseable bass counts as no bass; no result chord is a miss', () => {
    const s = scoreBass([ch(0, 4, 'C')], [ch(0, 2, 'C', 'maj', 'H')], beats);
    expect(s.segBass.rate).toBe(0.5);
    expect(s.wrongSlash.falseSlash).toBe(0);
  });
});

describe('cliche', () => {
  const t = [ch(0, 1, 'A', 'min'), ch(1, 2, 'A', 'min', 'G#'), ch(2, 3, 'A', 'min', 'G'), ch(3, 4, 'C')];
  it('finds a descending run of >= 3', () => {
    expect(clicheRuns({ chords: t })).toEqual([[0, 2]]);
    expect(clicheRuns({ chords: t.slice(0, 2) })).toEqual([]);
  });
  it('is hit only if every point in the run is right', () => {
    expect(scoreBass(t, t, beats).cliche).toMatchObject({ runs: 1, hit: 1, rate: 1 });
    const miss = [t[0], t[1], ch(2, 3, 'A', 'min'), t[3]];
    expect(scoreBass(t, miss, beats).cliche).toMatchObject({ runs: 1, hit: 0, rate: 0 });
    expect(scoreBass([ch(0, 4, 'C')], [ch(0, 4, 'C')], beats).cliche.rate).toBeNull();
  });
});

describe('editCounts', () => {
  const truth = [ch(0, 2, 'C'), ch(2, 4, 'G', 'maj', 'B')];
  it('zero for an exact copy', () => {
    expect(editCounts(truth, truth, beats).total).toBe(0);
  });
  it('slash add / remove / change', () => {
    expect(editCounts(truth, [ch(0, 2, 'C'), ch(2, 4, 'G')], beats)).toMatchObject({ slashAdd: 1, total: 1 });
    expect(editCounts(truth, [ch(0, 2, 'C', 'maj', 'E'), ch(2, 4, 'G', 'maj', 'B')], beats)).toMatchObject({ slashRemove: 1, total: 1 });
    expect(editCounts(truth, [ch(0, 2, 'C'), ch(2, 4, 'G', 'maj', 'D')], beats)).toMatchObject({ slashChange: 1, total: 1 });
  });
  it('name fix, split, merge', () => {
    expect(editCounts(truth, [ch(0, 2, 'C'), ch(2, 4, 'D', 'maj', 'B')], beats)).toMatchObject({ name: 1, total: 1 });
    // one result piece spans the boundary: split 1 + the second segment's label differs (G/B vs C) -> name 1, slashAdd 1
    expect(editCounts(truth, [ch(0, 4, 'C')], beats)).toMatchObject({ split: 1, name: 1, slashAdd: 1, total: 3 });
    // truth first segment cut in two result pieces: merge 1
    expect(editCounts(truth, [ch(0, 1, 'C'), ch(1, 2, 'C', 'maj', 'E'), ch(2, 4, 'G', 'maj', 'B')], beats)).toMatchObject({ merge: 1, total: 1 });
  });
  it('editDiff: stripping the bass of a correct result costs the missing slashes', () => {
    const d = editDiff(truth, truth, beats);
    expect(d.withBass.total).toBe(0);
    expect(d.withoutBass.total).toBe(1);
    expect(d.savedPer100Beats).toBeCloseTo((1 / 8) * 100, 12);
  });
});

describe('bassNoteScores', () => {
  const n = (start: number, midi: number) => ({ start, end: start + 0.4, midi });
  it('octave error counts for pitch class only; onset outside 50 ms misses both', () => {
    const ref = [n(0, 40), n(0.5, 43), n(1, 45)];
    const est = [n(0.02, 40), n(0.5, 55), n(1.07, 45)];
    const s = bassNoteScores(ref, est);
    expect(s.octave.matched).toBe(1);
    expect(s.pitchClass.matched).toBe(2);
    expect(s.pitchClass.f).toBeCloseTo(2 / 3, 12);
  });
});

describe('normalizeTruthSlash (T8)', () => {
  it('drops a truth bass equal to the root (G/G, Db/C#) and keeps real slash chords', () => {
    const t = [ch(0, 1, 'G', 'maj', 'G'), ch(1, 2, 'Db', 'maj', 'C#'), ch(2, 3, 'C', 'maj', 'E'), ch(3, 4, 'A', 'min')];
    const n = normalizeTruthSlash(t);
    expect(n.map((c) => c.bass)).toEqual([null, null, 'E', null]);
    expect(n[2]).toBe(t[2]);
    // a result without /X now scores the G/G beats as no-/X truth instead of a missed /X
    const r = [ch(0, 1, 'G'), ch(1, 2, 'Db'), ch(2, 3, 'C', 'maj', 'E'), ch(3, 4, 'A', 'min')];
    expect(scoreBass(t, r, beats).slash.recall).toBeCloseTo(1 / 3, 12);
    expect(scoreBass(n, r, beats).slash.recall).toBe(1);
  });
});
