import { describe, expect, it } from 'vitest';
import type { ScoreBeat } from '../../bass/score';
import { chords2ConfigHash } from '../config';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candConfig, freshDir, lookReport, candStat, combineStates, handDiffStat, lookCfgs, nameDiff, rankTheta, rowLines, runBits, scoreFile2, stateOf, THETA_GRID, tuneGrid, verdict, type FileRec2 } from './s8dev2';
import { editCounts, type EvalChord } from './score';
import type { Item } from './t8';

const beats: ScoreBeat[] = Array.from({ length: 9 }, (_, i) => ({ t: i * 0.5 }));
const ch = (start: number, end: number, root: string, quality: string, cands: [string, string][] = [], bass: string | null = null): EvalChord => ({ start, end, root, quality, bass, candidates: cands.map(([r, q]) => ({ root: r, quality: q })) });
const item = (name: string, level: string, kind: 'syn' | 'rec' = 'syn'): Item => ({ name, level, kind, wav: '', truth: '' });

// truth C7 | Am7 | F | G7 (two beats each)
const truth = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', '7')];
const baseRow = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', 'maj')];
const withCands = (c: Record<number, [string, string]>) => baseRow.map((x, i) => (c[i] ? { ...x, candidates: [{ root: c[i][0], quality: c[i][1] }] } : x));

describe('s8dev2: names, truth runs, candidate record', () => {
  it('nameDiff: 0 for the same names whatever the candidates; counts changed and missing chords', () => {
    expect(nameDiff(baseRow, withCands({ 0: ['C', '7'] }))).toBe(0);
    expect(nameDiff(baseRow, [baseRow[0], ch(1, 2, 'A', 'min7'), baseRow[2], baseRow[3]])).toBe(1);
    expect(nameDiff(baseRow, baseRow.slice(0, 3))).toBe(1);
    expect(nameDiff(baseRow, [ch(0, 1, 'C', 'maj', [], 'E'), ...baseRow.slice(1)])).toBe(1);
  });
  it('the sum of the per-run differences is the editCounts difference (nameFixableByCandidate)', () => {
    const row = withCands({ 0: ['C', '7'], 1: ['A', 'min7'], 3: ['G', 'maj7'] }); // two fixes, one wrong reading
    const b = runBits(truth, baseRow, beats);
    const r = runBits(truth, row, beats);
    const eb = editCounts(truth, baseRow, beats, 'full');
    const er = editCounts(truth, row, beats, 'full');
    expect(r.beats).toEqual(b.beats);
    expect(r.beats.reduce((a, x) => a + x, 0)).toBe(er.nBeats);
    expect(r.nameEdit).toEqual(b.nameEdit);
    const sumD = r.fix.reduce((a, x, i) => a + x - b.fix[i], 0);
    expect(sumD).toBe(er.nameFixableByCandidate - eb.nameFixableByCandidate);
    expect(sumD).toBe(2);
    expect(er.total).toBe(eb.total); // the names are the same, so is every other count
    expect(handDiffStat(r.fix.map((x, i) => ({ d: x - b.fix[i], beats: r.beats[i] })))).toBeCloseTo((-100 * 2) / er.nBeats, 12);
  });
  it('candStat: the segment\'s middle decides hit / wrong root; per candidate quality', () => {
    const row = [ch(0, 1, 'C', 'maj', [['C', '7']]), ch(1, 2, 'A', 'min', [['A', 'min7']]), ch(2, 3, 'D', 'maj', [['D', '7']]), ch(3, 4, 'G', 'maj', [['G', 'maj7']])];
    expect(candStat(truth, row)).toEqual({ segs: 4, hit: 2, wrongRoot: 1, unscored: 0, byQ: { '7': { n: 2, hit: 1 }, min7: { n: 1, hit: 1 }, maj7: { n: 1, hit: 0 } } });
    expect(candStat(truth, baseRow)).toMatchObject({ segs: 0 });
    expect(candStat([], [row[0]])).toMatchObject({ segs: 1, unscored: 1, hit: 0 });
  });
});

describe('s8dev2: three states and the lines', () => {
  it('stateOf: top <= -1.5 PASS, bottom > -1.5 FAIL, else the user decides; both groups must pass', () => {
    expect(stateOf({ lo: -2.5, hi: -1.5 })).toBe('PASS');
    expect(stateOf({ lo: -1.4, hi: -0.2 })).toBe('FAIL');
    expect(stateOf({ lo: -2, hi: -1 })).toBe('USER');
    expect(stateOf(null)).toBeNull();
    expect(combineStates(['PASS', 'PASS'])).toBe('PASS');
    expect(combineStates(['PASS', 'USER'])).toBe('USER');
    expect(combineStates(['USER', 'FAIL'])).toBe('FAIL');
    expect(combineStates(['PASS', null])).toBeNull();
  });
  const mk = (name: string, level: string, rows: Record<string, EvalChord[]>, kind: 'syn' | 'rec' = 'syn'): FileRec2 => scoreFile2(item(name, level, kind), { chords: truth, beats }, { rows: { base: baseRow, ...rows }, ms: {} });
  const opts = { boot: true, decisive: ['SYN'], push: ['SYN'], noise: ['SYN'], dec9: ['SYN'] };
  it('rowLines: the decisive value is the editCounts difference per 100 beats; guards: names, push-out, noise, decision 9', () => {
    const f = mk('c2-d-b-x', 'B', { E1c: withCands({ 0: ['C', '7'], 1: ['A', 'min7'] }) });
    const l = rowLines([f], 'E1c', opts);
    expect(l.decisive[0].value).toBeCloseTo((-100 * 2) / 8, 9);
    expect(l.decisive[0].ci).not.toBeNull(); // 4 truth runs only: the state itself is stateOf's (above)
    const names = l.guards.find((g) => g.line.startsWith('名前'))!;
    expect(names.pass).toBe(true);
    expect(l.guards.find((g) => g.line.startsWith('候補のうるささ'))!.value).toBeCloseTo(50, 9); // 2 of 4 chords carry an added candidate
    expect(l.guards.find((g) => g.line.startsWith('候補のうるささ'))!.pass).toBe(false);
    expect(l.guards.find((g) => g.line.startsWith('候補の押し出し'))!.pass).toBe(true);
    // C7 / Am7 are 7th truths read as triads: the correct 7th is now shown, (G7 has none shown): the hidden count falls from 3 to 1
    const d9 = l.guards.find((g) => g.line.startsWith('決定 9'))!;
    expect(d9.value).toBeCloseTo(1 / 3, 12);
    expect(d9.ci).not.toBeNull(); // 3 segments only: the interval's top reaches 1 (a resample of the G7 segment alone)
  });
  it('a name that differs from the base is a harness-fix, whatever the numbers', () => {
    const f = mk('c2-d-b-x', 'B', { E1c: [ch(0, 1, 'C', '7'), ...baseRow.slice(1)] });
    const l = rowLines([f], 'E1c', opts);
    expect(l.guards.find((g) => g.line.startsWith('名前'))!.pass).toBe(false);
    expect(verdict(l, [])).toMatch(/harness-fix/);
  });
  it('verdict: FAIL stops, a user band is adopted only with both points <= -1.5 and every guard passing', () => {
    const ok = { decisive: [], guards: [{ kind: '守り' as const, line: 'x', value: 0, op: '<=' as const, target: 0, ci: null, pass: true }] };
    expect(verdict({ ...ok, state: 'FAIL' }, [])).toMatch(/止める/);
    expect(verdict({ ...ok, state: 'USER' }, [-1.6, -2])).toMatch(/採る側/);
    expect(verdict({ ...ok, state: 'USER' }, [-1.4, -2])).toMatch(/止める/);
    expect(verdict({ ...ok, state: 'PASS' }, [-3, -3])).toMatch(/採る側/);
    const bad = { decisive: [], guards: [{ kind: '守り' as const, line: 'x', value: 11, op: '<=' as const, target: 10, ci: null, pass: false }] };
    expect(verdict({ ...bad, state: 'PASS' }, [-3, -3])).toMatch(/止める/); // decisive PASS + a guard FAIL = stop (decisions 9, 17)
    expect(verdict({ ...ok, state: 'PASS' }, [-3, -3])).toMatch(/PASS/);
  });
});

describe('s8dev2: push-out under the cap of 2 (G1 §2 guard)', () => {
  it('the added-note candidate goes first, so the correct top-2 candidate is hidden: hand edits +1 and the guard fails', () => {
    const t = [ch(0, 1, 'F', 'maj')];
    const b = [ch(0, 1, 'D', 'min', [['G', 'maj'], ['F', 'maj']])]; // base: F maj is the 2nd shown candidate: fixable by 1 pick
    const r = [ch(0, 1, 'D', 'min', [['D', 'min7'], ['G', 'maj'], ['F', 'maj']])]; // + the added note first: shown = [D min7, G maj]
    const bits = (x: EvalChord[]) => runBits(t, x, beats.slice(0, 3));
    expect(bits(b).fix).toEqual([1]);
    expect(bits(r).fix).toEqual([0]);
    expect(handDiffStat([{ d: -1, beats: 2 }])).toBe(50); // fix 1 -> 0: hand edits +1 over 2 beats = +50 / 100 beats
    const f = scoreFile2(item('etude4-x', 'L1'), { chords: t, beats: beats.slice(0, 3) }, { rows: { base: b, E1c: r }, ms: {} });
    const l = rowLines([f], 'E1c', { boot: false, decisive: [], push: ['Lpool'], noise: [], dec9: [] });
    const push = l.guards.find((g) => g.line.startsWith('候補の押し出し'))!;
    expect(push.value).toBeCloseTo(50, 9);
    expect(push.pass).toBe(false);
  });
});

describe('s8dev2: a re-run recomputes every file', () => {
  it('a name difference prints only its count (no table)', () => {
    const f = scoreFile2(item('c2-d-b-x', 'B'), { chords: truth, beats }, { rows: { base: baseRow, 'th0.5': [ch(0, 1, 'C', '7'), ...baseRow.slice(1)] }, ms: {} });
    const t = lookReport('x', [f]);
    expect(t).toMatch(/1 和音/);
    expect(t).not.toMatch(/手で直す数/);
  });
  it('freshDir empties a results folder (stale per-file results would be skipped by the worker)', () => {
    const d = join(mkdtempSync(join(tmpdir(), 's8dev2-')), 'look');
    mkdirSync(join(d, 'files'), { recursive: true });
    writeFileSync(join(d, 'files', 'x.json'), '{}');
    freshDir(d);
    expect(existsSync(d)).toBe(true);
    expect(readdirSync(d)).toEqual([]);
  });
});

describe('s8dev2: tuning grid and selection rule', () => {
  it('five θ_c, thetaLow .3 (θ_c below it allowed), candidate output, penalty 0, distinct hashes', () => {
    const g = tuneGrid();
    expect(g.map((c) => c.cfg.d2!.theta)).toEqual([...THETA_GRID]);
    expect(g.every((c) => c.cfg.d2!.output === 'candidate' && c.cfg.d2!.thetaLow === 0.3 && c.cfg.d2!.switchPenalty === 0)).toBe(true);
    expect(new Set(g.map((c) => chords2ConfigHash(c.cfg))).size).toBe(5);
  });
  it('rankTheta: fewest failed guards, then the smaller hand edits (.1), then the larger θ_c', () => {
    const rows: Record<string, EvalChord[]> = {};
    for (const t of THETA_GRID) rows[`th${t}`] = baseRow;
    rows['th0.25'] = withCands({ 0: ['C', '7'], 1: ['A', 'min7'], 2: ['F', 'maj7'], 3: ['G', '7'] }); // noisy
    const f = scoreFile2(item('c2-t-b-x', 'B'), { chords: truth, beats }, { rows: { base: baseRow, ...rows }, ms: {} });
    const r = rankTheta([f], tuneGrid());
    expect(r[r.length - 1].key).toBe('th0.25');
    expect(r[r.length - 1].guardFails).toBe(1);
    expect(r[0].key).toBe('th0.8'); // 0 failed guards everywhere else, equal hand edits: the larger θ_c
  });
  it('the look row needs the chosen θ_c', () => {
    expect(() => lookCfgs(null)).toThrow(/T7C_E1_CANDIDATE_THETA/);
    expect(() => lookCfgs(0.4)).toThrow(/tuning grid/);
    expect(lookCfgs(0.35)[0].key).toBe('E1c');
    expect(lookCfgs(0.35)[0].cfg).toEqual(candConfig(0.35));
  });
});
