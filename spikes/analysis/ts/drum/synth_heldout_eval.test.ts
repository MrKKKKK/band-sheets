import { describe, expect, it } from 'vitest';
import { finalLogLine, EVAL_LEVELS } from './heldout_eval';
import { hasDrumLook3, hasDrumSynthLook3, parseLog } from './heldout_guard';
import { runSynthEval, synthBlock, synthLogLines, SYNTH_LEVELS, type SynthDeps } from './synth_heldout_eval';

const variants = [
  { name: 'syn-d1-rock8-kA-s1', kit: 'A', level: 'D1', split: 'tuning', heldOut: false },
  { name: 'syn-d1-rock8-kA-s4', kit: 'A', level: 'D1', split: 'dev', heldOut: false },
  { name: 'syn-d1-rock8-kB-s4', kit: 'B', level: 'D1', split: 'dev', heldOut: false },
  { name: 'syn-d2-rock8-kB-s5', kit: 'B', level: 'D2', split: 'dev', heldOut: false },
  { name: 'syn-d1-rock8-kC-s6', kit: 'C', level: 'D1', split: 'heldOut', heldOut: true },
  { name: 'syn-d2-rock8-kC-s7', kit: 'C', level: 'D2', split: 'heldOut', heldOut: true },
];
const item = (id: string) => ({
  id,
  truth: { barTicks: 64, barStartsSec: [0, 2], hits: [{ t: 0, bar: 0, tick: 0, inst: 'BD' }] },
  result: { drums: [{ t: 0, inst: 'BD' }], drum: { quantized: { bpm: 120, ts: [4, 4], startSec: 0, hits: [{ bar: 0, tick: 0, inst: 'BD' }] } } } as never,
});

function deps(over: Partial<SynthDeps> = {}, log: string[] = []) {
  const calls: string[] = [];
  const d: SynthDeps = {
    variants,
    readLog: () => (log.length ? log.join('\n') + '\n' : null),
    appendLog: (l) => void log.push(l),
    porcelain: () => '',
    now: () => 't',
    configHash: 'abc',
    frozenConfigHash: 'abc',
    commit: 'c0ffee',
    analyze: (name, level) => {
      calls.push(`${name}@${level}`);
      expect(hasDrumSynthLook3(parseLog(log.join('\n')))).toBe(true); // both lines are written before any analysis
      return item(name);
    },
    ...over,
  };
  return { d, calls, log };
}

describe('synthetic held-out guard (T16, G2-11)', () => {
  it('runs once: two lines (dev kit B, held-out kit C) before the analysis, kit B and C x 3 levels, never kit A', () => {
    const { d, calls, log } = deps();
    const out = runSynthEval(d);
    expect(log).toHaveLength(2);
    const [dev, held] = log.map((l) => JSON.parse(l));
    expect(dev).toMatchObject({ kind: 'look', input: 'drum-synth', lookPoint: 3, take: 'dev', heldOut: false, kits: ['B'], configHash: 'abc', commit: 'c0ffee' });
    expect(held).toMatchObject({ kind: 'look', input: 'drum-synth', lookPoint: 3, take: 'heldout', heldOut: true, variants: ['syn-d1-rock8-kC-s6', 'syn-d2-rock8-kC-s7'] });
    expect(calls).toHaveLength(4 * SYNTH_LEVELS.length);
    expect(calls.some((c) => c.includes('kA'))).toBe(false);
    expect(out.pools.C['S-9'].D2.all.matched).toBe(1);
    expect(out.report).toContain('C - B');
    // a second run is refused before reading anything
    const again = deps({}, log);
    expect(() => runSynthEval(again.d)).toThrow(/already exists/);
    expect(again.calls).toEqual([]);
    expect(log).toHaveLength(2);
  });
  it('is separate from the recordings: their look-3 line does not block it, and its line does not count as theirs', () => {
    const rec = finalLogLine({ time: 't0', takes: ['drm-05-e'], levels: EVAL_LEVELS, configHash: 'abc' });
    expect(synthBlock({ configHash: 'abc', frozenConfigHash: 'abc', commit: 'c', logText: rec, porcelain: '' })).toBeNull();
    const lines = synthLogLines({ time: 't', dev: ['b'], held: ['c'], levels: SYNTH_LEVELS, configHash: 'abc', commit: 'c' });
    expect(hasDrumLook3(parseLog(lines.join('\n')))).toBe(false);
    expect(hasDrumSynthLook3(parseLog(lines[0]))).toBe(false); // the dev line alone does not use up the held-out look
  });
  it('refuses a dirty tree, unreadable git, a non-frozen config or no commit, writing nothing', () => {
    for (const over of [{ porcelain: () => ' M x\n' }, { porcelain: () => null }, { configHash: 'zzz' }, { commit: undefined }] as Partial<SynthDeps>[]) {
      const { d, calls, log } = deps(over);
      expect(() => runSynthEval(d)).toThrow();
      expect(calls).toEqual([]);
      expect(log).toEqual([]);
    }
  });
  it('refuses when a held-out variant is not kit C', () => {
    const { d, log } = deps({ variants: [...variants, { name: 'syn-x-kB-s6', kit: 'B', level: 'D1', split: 'heldOut', heldOut: true }] });
    expect(() => runSynthEval(d)).toThrow(/not kit C/);
    expect(log).toEqual([]);
  });
});
