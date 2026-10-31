import { describe, expect, it } from 'vitest';
import { EVAL_LEVELS, finalLogLine, runEval, type EvalDeps } from './heldout_eval';
import { hasDrumLook3, parseLog } from './heldout_guard';
import type { PoolItem } from './pool';

const recordings = [
  { name: 'drm-01-a', heldOut: false },
  { name: 'drm-02-b', heldOut: false },
  { name: 'drm-05-e', heldOut: true },
  { name: 'drm-06-f', heldOut: true },
];
const sources = { syn: [], rec: recordings, ids: Object.fromEntries(recordings.map((r) => [r.name, { heldOut: r.heldOut }])) };

function deps(over: Partial<EvalDeps> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const d: EvalDeps = {
    mode: 'final',
    recordings,
    sources,
    readLog: () => (lines.length ? lines.join('\n') + '\n' : null),
    appendLog: (l) => void lines.push(l),
    porcelain: () => '',
    now: () => 't',
    configHash: 'abc',
    commit: 'c0ffee',
    analyze: (id, level) => {
      calls.push(`${id}@${level}`);
      throw new Error('analysis reached');
    },
    ...over,
  };
  return { d, calls, lines };
}

describe('runEval final', () => {
  it('logs exactly one look-3 line (before analysis) covering all held-out takes and levels', () => {
    const { d, calls, lines } = deps();
    expect(() => runEval(d)).toThrow('analysis reached');
    expect(lines).toHaveLength(1);
    const l = JSON.parse(lines[0]);
    expect(l).toMatchObject({ kind: 'look', input: 'drum', lookPoint: 3, heldOut: true, variants: ['drm-05-e', 'drm-06-f'], levels: EVAL_LEVELS, configHash: 'abc', commit: 'c0ffee' });
    expect(hasDrumLook3(parseLog(lines[0]))).toBe(true);
    expect(calls).toEqual(['drm-05-e@S-9']); // the log line existed before the first analyze call
  });
  it('analyzes both takes x all three levels in one run after a single check', () => {
    const { d, calls, lines } = deps({ analyze: () => { throw new Error('x'); } });
    const seen: string[] = [];
    d.analyze = (id, level) => {
      seen.push(`${id}@${level}`);
      return { id, truth: { hits: [], barStartsSec: [0], bars: [] } as never, result: { drums: [], drum: { quantized: { hits: [] } } } as never };
    };
    try { runEval(d); } catch { /* scoring of the fake items is not under test */ }
    expect(seen.slice(0, 2)).toEqual(['drm-05-e@S-9', 'drm-06-f@S-9']);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
  });
  it('refuses before reading audio when a drum look-3 line already exists', () => {
    const { d, calls, lines } = deps();
    lines.push(finalLogLine({ time: 't0', takes: ['drm-05-e'], levels: EVAL_LEVELS, configHash: 'abc' }));
    expect(() => runEval(d)).toThrow(/already exists/);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
  });
  it('refuses on a dirty tree or unreadable git, logging nothing', () => {
    for (const porcelain of [' M x\n', null]) {
      const { d, calls, lines } = deps({ porcelain: () => porcelain });
      expect(() => runEval(d)).toThrow(/clean/);
      expect(calls).toEqual([]);
      expect(lines).toEqual([]);
    }
  });
  it('a dev look-3 line does not block', () => {
    const { d, lines } = deps();
    lines.push(JSON.stringify({ kind: 'look', input: 'drum', lookPoint: 3, heldOut: false }));
    expect(() => runEval(d)).toThrow('analysis reached');
    expect(lines).toHaveLength(2);
  });
});

describe('runEval selftest', () => {
  it('uses dev takes only and never logs, even with a clean/dirty tree or an existing look-3 line', () => {
    const { d, calls, lines } = deps({ mode: 'selftest', porcelain: () => ' M x\n' });
    lines.push(finalLogLine({ time: 't0', takes: ['drm-05-e'], levels: EVAL_LEVELS, configHash: 'abc' }));
    expect(() => runEval(d)).toThrow('analysis reached');
    expect(lines).toHaveLength(1);
    expect(calls).toEqual(['drm-01-a@S-9']);
  });
  it('refuses when a take it would run is held-out per the id sources', () => {
    const bad = { ...sources, ids: { ...sources.ids, 'drm-01-a': { heldOut: true } } };
    const { d, calls, lines } = deps({ mode: 'selftest', sources: bad });
    expect(() => runEval(d)).toThrow(/refuses drm-01-a/);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});
export type { PoolItem };
