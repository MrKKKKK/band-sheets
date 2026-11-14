import { describe, expect, it } from 'vitest';
import { nonBassDiffs, rootChanges } from './root_regression';

const v1a = { beats: [{ t: 0 }], chords: [{ start: 0, end: 1, root: 'C', quality: 'maj', bass: null, text: 'C?' }, { start: 1, end: 2, root: 'G', quality: 'maj', bass: null, text: 'G' }] };

describe('nonBassDiffs', () => {
  it('accepts added bass fields and the /X text (before a trailing ?)', () => {
    const bass = { ...v1a, bassAnalyzer: { configHash: 'x' }, chords: [{ ...v1a.chords[0], bass: 'E', text: 'C/E?', bassKind: 'inversion', bassConfidence: 0.3, bassCandidates: [] }, v1a.chords[1]] };
    expect(nonBassDiffs(v1a, bass)).toEqual([]);
  });
  it('reports a changed root, a wrong text, a changed beat grid and a chord count', () => {
    expect(nonBassDiffs(v1a, { ...v1a, chords: [{ ...v1a.chords[0], root: 'A' }, v1a.chords[1]] })).toEqual(['chord 0: non-bass field', 'chord 0: text']);
    expect(nonBassDiffs(v1a, { ...v1a, chords: [{ ...v1a.chords[0], bass: 'E', text: 'C/E' }, v1a.chords[1]] })).toEqual(['chord 0: text']);
    expect(nonBassDiffs(v1a, { ...v1a, beats: [{ t: 0.1 }] })).toEqual(['top-level fields']);
    expect(nonBassDiffs(v1a, { ...v1a, chords: [v1a.chords[0]] })).toEqual(['v1a chord 1: pieces do not tile it']);
  });
  it('B-3 pieces that tile their v1a chord pass; a gap or a changed field does not (T10)', () => {
    const [c, g] = v1a.chords;
    const pieces = [{ ...c, end: 0.5 }, { ...c, start: 0.5, bass: 'B', text: 'C/B?', bassKind: 'passing' }, g];
    expect(nonBassDiffs(v1a, { ...v1a, chords: pieces })).toEqual([]);
    expect(nonBassDiffs(v1a, { ...v1a, chords: [{ ...c, end: 0.5 }, g] })).toEqual(['v1a chord 0: pieces do not tile it']);
    expect(nonBassDiffs(v1a, { ...v1a, chords: [{ ...c, end: 0.5 }, { ...c, start: 0.5, confidence: 1 }, g] })).toEqual(['chord 1: non-bass field']);
  });
  it('root re-decision: root / quality / name may change with { roots }, counted by rootChanges', () => {
    const bass = { ...v1a, chords: [{ ...v1a.chords[0], root: 'A', quality: 'min', bass: 'C', text: 'Am/C?' }, v1a.chords[1]] };
    expect(nonBassDiffs(v1a, bass)).toEqual(['chord 0: non-bass field']);
    expect(nonBassDiffs(v1a, bass, { roots: true })).toEqual([]);
    expect(rootChanges(v1a, bass)).toBe(1);
    expect(rootChanges(v1a, v1a)).toBe(0);
  });
});
