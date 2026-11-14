import { afterEach, describe, expect, it, vi } from 'vitest';
import { enabledBassConfig } from './config';
import type { LowCqt } from './lowCqt';
import { run, truthSegments, type Item } from './t9_sweep';

describe('truthSegments', () => {
  it('respells truth roots to the analyzer names and drops the bass', () => {
    const t = [
      { start: 0, end: 1, root: 'Bb', quality: 'maj', bass: 'D' },
      { start: 1, end: 2, root: 'F#', quality: 'min', bass: null },
      { start: 2, end: 3, root: 'Db', quality: '7', bass: null },
      { start: 3, end: 4, root: 'C', quality: 'maj', bass: null },
    ];
    expect(truthSegments(t)).toEqual([
      { start: 0, end: 1, root: 'A#', quality: 'maj', bass: null },
      { start: 1, end: 2, root: 'F#', quality: 'min', bass: null },
      { start: 2, end: 3, root: 'C#', quality: '7', bass: null },
      { start: 3, end: 4, root: 'C', quality: 'maj', bass: null },
    ]);
  });
});

/** One frame per column, rows = MIDI 24.. ; `rows` maps MIDI -> magnitude, held for 2 s. */
function toy(rows: Record<number, number>): LowCqt {
  const frameSec = 512 / 22050;
  const cols = Math.ceil(2 / frameSec);
  const semi = new Float32Array(60 * cols);
  for (const [m, a] of Object.entries(rows)) for (let t = 0; t < cols; t++) semi[(Number(m) - 24) * cols + t] = a;
  return { semi, nSemis: 60, cols, midi0: 24, frameSec, tuning: 0 };
}
const beats = [0, 0.5, 1, 1.5].map((t) => ({ t }));

/** Two hand-made songs, one chord each over 4 beats. Song 1: truth C/E, E2 bass, v1a says C. Song 2: truth C, C2 bass, v1a says C. */
describe('run (t9_sweep aggregation)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aggregates slash P / R, wrong-/X rate and edits saved over two songs', () => {
    const e2 = { 40: 1, 52: 1 / 2, 59: 1 / 3, 64: 1 / 4 };
    const c2 = { 36: 1, 48: 1 / 2, 55: 1 / 3, 60: 1 / 4 };
    const v1a = [{ start: 0, end: 2, root: 'C', quality: 'maj', bass: null }];
    const items: Item[] = [
      { level: 'B1', timbre: 'A', low: toy(e2), truth: [{ start: 0, end: 2, root: 'C', quality: 'maj', bass: 'E' }], truthBeats: beats, v1a, v1aBeats: [0, 0.5, 1, 1.5], ceiling: true },
      { level: 'B1', timbre: 'A', low: toy(c2), truth: [{ start: 0, end: 2, root: 'C', quality: 'maj', bass: null }], truthBeats: beats, v1a, v1aBeats: [0, 0.5, 1, 1.5], ceiling: true },
    ];
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => void lines.push(String(s)));
    run('toy', enabledBassConfig(), items, false, false, ['B1', 'ALL']);
    const row = (kind: string, group: string) => lines.find((l) => l.startsWith(`${kind}\t${group}\t`));
    expect(lines[0]).toMatch(/^\n== toy \(bass-on hash [0-9a-f]{12}\) ==$/);
    // 16 scored points, all hit; 1 slash truth, 1 mark, 1 hit -> P = R = F = 1; no false /X in the plain song;
    // v1a without the bass stage misses the one slash: 1 edit saved over 8 beats = 12.5 per 100.
    const expected = '\t1.000\t1.000/1.000/1.000\t0.000\t  -  (0)\t12.500\t1.000->1.000\t1.000->1.000';
    expect(row('v1a', 'B1')).toBe(`v1a\tB1${expected}`);
    expect(row('v1a', 'ALL')).toBe(`v1a\tALL${expected}`);
    expect(row('truth', 'B1')).toBe(`truth\tB1${expected}`);
  });
});
