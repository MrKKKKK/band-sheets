import { describe, expect, it } from 'vitest';
import type { ScoreBeat } from '../../bass/score';
import { chords2ConfigHash } from '../config';
import { fragmentation, gateLines, grid, groupsOf, LOOK_CFGS, rank, scoreFile } from './s8dev1';
import type { EvalChord } from './score';
import type { Item } from './t8';

const beats: ScoreBeat[] = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5 }));
const ch = (start: number, end: number, root: string, quality: string, bass: string | null = null): EvalChord => ({ start, end, root, quality, bass });
const item = (name: string, level: string, kind: 'syn' | 'rec' = 'syn'): Item => ({ name, level, kind, wav: '', truth: '' });

describe('s8dev1: grid, groups', () => {
  it('round 1 = 27 values with θ >= θ_low; round 2 around a value, θ_low fixed', () => {
    const g = grid(1);
    expect(g).toHaveLength(27);
    expect(new Set(g.map((c) => chords2ConfigHash(c.cfg))).size).toBe(27);
    expect(g.every((c) => c.cfg.d2!.range === 'E1' && c.cfg.d2!.theta >= c.cfg.d2!.thetaLow && !c.cfg.octaveChroma)).toBe(true);
    const r2 = grid(2, { theta: 0.35, thetaLow: 0.3, switchPenalty: 0 });
    expect(r2.map((c) => [c.cfg.d2!.theta, c.cfg.d2!.switchPenalty])).toEqual([[0.3, 0], [0.3, 0.05], [0.3, 0.1], [0.35, 0], [0.35, 0.05], [0.35, 0.1], [0.4, 0], [0.4, 0.05], [0.4, 0.1]]);
    expect(grid(2, { theta: 0.25, thetaLow: 0.2, switchPenalty: 0.1 }).map((c) => c.cfg.d2!.switchPenalty)).toEqual([0.05, 0.1, 0.2, 0.05, 0.1, 0.2, 0.05, 0.1, 0.2]);
    expect(() => grid(2)).toThrow();
    expect(() => grid(3)).toThrow();
  });
  it('the look rows: E1 and the same with D1, one F1', () => {
    expect(LOOK_CFGS.map((c) => c.key)).toEqual(['E1', 'E1|D1']);
    expect(LOOK_CFGS[1].cfg.octaveChroma).toBe(true);
    expect(LOOK_CFGS[0].cfg.d2).toEqual(LOOK_CFGS[1].cfg.d2);
    // the s8-dev-1 rows' config hashes (look at 2aafe69)
    expect(chords2ConfigHash(LOOK_CFGS[0].cfg)).toBe('8b6cd09b7c54');
    expect(chords2ConfigHash(LOOK_CFGS[1].cfg)).toBe('462ab1385491');
  });
  it('groups', () => {
    expect(groupsOf(item('c2-d-v1-human-s4-v7top', 'V1'))).toEqual(['V1', 'SYN', 'v7', 'ALL']);
    expect(groupsOf(item('syn-b1-x-tA-s4', 'B1'))).toEqual(['B1', 'SYN', 'B0-3', 'ALL']);
    expect(groupsOf(item('etude4-full', 'L1'))).toEqual(['L1', 'Lpool', 'ALL']);
    expect(groupsOf(item('etude5-x', 'LR'))).toEqual(['LR', 'ALL']);
    expect(groupsOf(item('chd-07-g', 'g-j', 'rec'))).toEqual(['g-j', 'REC']);
    expect(groupsOf(item('bas-05-e', 'e-f', 'rec'))).toEqual(['e-f', 'a-f', 'REC']);
  });
});

describe('s8dev1: lines from the saved per-file scores', () => {
  // truth C7 | Am7 | F | G7; base = the triads; E1 = C7, Am7, Fmaj7 (over-added), G
  const truth = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', '7')];
  const base = [ch(0, 1, 'C', 'maj'), ch(1, 2, 'A', 'min'), ch(2, 3, 'F', 'maj'), ch(3, 4, 'G', 'maj')];
  const e1 = [ch(0, 1, 'C', '7'), ch(1, 2, 'A', 'min7'), ch(2, 3, 'F', 'maj7'), ch(3, 4, 'G', 'maj')];
  const f = scoreFile(item('c2-d-b-x', 'B'), { chords: truth, beats }, { rows: { base, E1: e1 }, ms: {} });
  const opts = { boot: true, overAddGroups: ['SYN'], regGroups: ['SYN'], slashGroups: [] };
  const ls = gateLines([f], 'E1', 'base', opts);
  const get = (s: string) => ls.find((l) => l.line.startsWith(s))!;
  it('decisive: precision 4/6 fails .80, recall +4/6 passes +.30', () => {
    expect(get('E1 適合率').value).toBeCloseTo(4 / 6, 9);
    expect(get('E1 適合率').pass).toBe(false);
    expect(get('E1 再現率').value).toBeCloseTo(4 / 6, 9);
    expect(get('E1 再現率').pass).toBe(true);
    expect(get('E1 再現率').ci).not.toBeNull();
  });
  it('guards and watches: over-adding 1.0 on the F triad, regression of names, 7th-as-triad ratio 2/6', () => {
    expect(get('足しすぎ').value).toBe(1);
    expect(get('足しすぎ').pass).toBe(false);
    expect(get('後戻り 名前').value).toBeCloseTo(4 / 8 - 2 / 8, 9); // E1: C7, Am7 hit; base: F only; G7 missed by both
    expect(get('後戻り ルートだけ').value).toBe(0);
    expect(get('7th を 3 和音').value).toBeCloseTo(2 / 6, 9);
    expect(get('7th を 3 和音').note).toBe('2 / 6 点');
  });
  it('a regression between −.01 and −.02 is for the user (synthetic), below the stop fails', () => {
    // 100 copies of a file where base hits everything and the row misses 1 point of 8 in one copy only
    const one = scoreFile(item('c2-d-b-y', 'B'), { chords: base, beats }, { rows: { base, E1: base }, ms: {} });
    const miss = scoreFile(item('c2-d-b-z', 'B'), { chords: base, beats }, { rows: { base, E1: [ch(0, 0.25, 'D', 'maj'), ...base.map((c, i) => (i === 0 ? { ...c, start: 0.25 } : c))] }, ms: {} });
    const l = gateLines([miss, ...Array.from({ length: 4 }, () => one)], 'E1', 'base', { ...opts, boot: false }).find((x) => x.line.startsWith('後戻り 名前'))!;
    expect(l.value).toBeCloseTo(-0.5 / 40, 9);
    expect(l.pass).toBe(false);
    expect(l.user).toBe(true);
  });
  it('rank: fewer failed guards first', () => {
    const ok = scoreFile(item('c2-d-b-w', 'B'), { chords: truth, beats }, { rows: { base, A: e1, B: truth }, ms: {} });
    expect(rank([ok], ['A', 'B']).map((r) => r.key)).toEqual(['B', 'A']);
  });
  it('fragmentation: an added tone switching inside one truth segment', () => {
    const t = [ch(0, 4, 'C', '7')];
    const r = [ch(0, 1, 'C', '7'), ch(1, 2, 'C', 'maj7'), ch(2, 3, 'C', '7'), ch(3, 4, 'C', 'maj')];
    const x = scoreFile(item('c2-d-b-v', 'B'), { chords: t, beats }, { rows: { base: r, E1: r }, ms: {} });
    expect(fragmentation([x], 'E1', 'SYN')).toEqual({ boundaries: 3, switches: 2, insideTruth: 2 });
  });
});
