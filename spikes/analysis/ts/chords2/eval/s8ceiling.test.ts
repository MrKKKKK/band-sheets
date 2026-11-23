import { describe, expect, it } from 'vitest';
import type { ScoreBeat } from '../../bass/score';
import { ceilingOf } from './s8ceiling';
import { editCounts, type EditRun, type EvalChord } from './score';

// 120 BPM, 8 beats; truth runs of 2 beats each (1 s)
const beats: ScoreBeat[] = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5 }));
const ch = (start: number, end: number, root: string, quality: string, bass: string | null = null, extra: Partial<EvalChord> = {}): EvalChord => ({ start, end, root, quality, bass, ...extra });

describe('ceilingOf (s8-dev-2 ceiling of the candidates-only E1)', () => {
  it('counts only unfixed name edits on a root-correct triad of the truth E1 quality (any /X)', () => {
    const truth = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'G', '7'), ch(3, 4, 'F', 'maj7', 'A')];
    const result = [
      ch(0, 1, 'C', 'maj'), // reachable
      ch(1, 2, 'A', 'min', null, { candidates: [{ root: 'A', quality: 'min7' }] }), // already fixable by a candidate
      ch(2, 3, 'E', 'min'), // wrong root
      ch(3, 4, 'F', 'maj', 'A'), // reachable (slash triad)
    ];
    const c = ceilingOf(truth, result, beats);
    expect(c).toMatchObject({ beats: 8, runs: 4, nameEdits: 4, fixable: 1, reachable: 2 });
    expect(c.check).toEqual({ name: 4, fixable: 1 });
  });

  it('does not count a right name, a triad truth, a 7th read as another 7th, or m7b5 on the wrong triad', () => {
    const truth = [ch(0, 1, 'D', '7'), ch(1, 2, 'C', 'maj'), ch(2, 3, 'G', 'maj7'), ch(3, 4, 'B', 'm7b5')];
    const result = [ch(0, 1, 'D', '7'), ch(1, 2, 'C', 'maj'), ch(2, 3, 'G', '7'), ch(3, 4, 'B', 'min')];
    expect(ceilingOf(truth, result, beats)).toMatchObject({ nameEdits: 2, reachable: 0 });
    // m7b5 on its own triad is reachable
    expect(ceilingOf([ch(0, 4, 'B', 'm7b5')], [ch(0, 4, 'B', 'dim')], beats).reachable).toBe(1);
  });

  it('onRun leaves editCounts unchanged and its runs sum to the counts', () => {
    const truth = [ch(0, 2, 'C', '7'), ch(2, 4, 'A', 'min')];
    const result = [ch(0, 1, 'C', 'maj'), ch(1, 3, 'C', '7', null, { candidates: [{ root: 'A', quality: 'min' }] }), ch(3, 4, 'A', 'min')];
    const runs: EditRun[] = [];
    const e = editCounts(truth, result, beats, 'full', { onRun: (r) => runs.push(r) });
    expect(e).toEqual(editCounts(truth, result, beats, 'full'));
    expect(runs.reduce((a, r) => a + r.beats, 0)).toBe(e.nBeats);
    expect(runs.filter((r) => r.nameEdit).length).toBe(e.name);
    expect(runs.filter((r) => r.fixable).length).toBe(e.nameFixableByCandidate);
  });
});
