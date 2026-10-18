import { describe, expect, it } from 'vitest';
import { heldOutRunBlock, parseHeldOutMode, type HeldOutGuardInput } from './heldout_log';

const L = (o: object) => JSON.stringify(o);
const SPIKE2 = L({ kind: 'look', input: 'rec', lookPoint: 3 }); // another spike's look 3 must not count
const LOOK3 = L({ kind: 'look', input: 'hum', lookPoint: 3 });
const RESCORE = L({ kind: 'rescore-m1', input: 'hum', lookPoint: 3 });
const base: HeldOutGuardInput = { run: 'final-heldout', configHash: 'h', frozenHash: 'h', logText: SPIKE2 + '\n', porcelain: '' };

describe('heldOutRunBlock', () => {
  it('final: runs on a clean tree with the frozen config when only another input has a look-3 line', () => {
    expect(heldOutRunBlock(base)).toBeNull();
    expect(heldOutRunBlock({ ...base, logText: null })).toBeNull();
  });
  it('final: refuses a wrong hash, a dirty tree, failing git, and a second run', () => {
    expect(heldOutRunBlock({ ...base, configHash: 'x' })).toMatch(/frozen/);
    expect(heldOutRunBlock({ ...base, porcelain: ' M a.ts' })).toMatch(/clean/);
    expect(heldOutRunBlock({ ...base, porcelain: null })).toMatch(/clean/);
    expect(heldOutRunBlock({ ...base, logText: SPIKE2 + '\n' + LOOK3 + '\n' })).toMatch(/already exists/);
  });
  it('rescore: needs the look-3 line, refuses when a rescore line exists', () => {
    const r = { ...base, run: 'rescore-m1' as const };
    expect(heldOutRunBlock({ ...r, logText: SPIKE2 + '\n' })).toMatch(/no hum look-3/);
    expect(heldOutRunBlock({ ...r, logText: null })).toMatch(/no hum look-3/);
    expect(heldOutRunBlock({ ...r, logText: LOOK3 + '\n' })).toBeNull();
    expect(heldOutRunBlock({ ...r, logText: LOOK3 + '\n' + RESCORE + '\n' })).toMatch(/rescore-m1 line already exists/);
  });
  it('rescore: wrong hash or dirty tree refuse as well; a rescore line does not count as the original look', () => {
    const r = { ...base, run: 'rescore-m1' as const, logText: LOOK3 + '\n' };
    expect(heldOutRunBlock({ ...r, configHash: 'x' })).toMatch(/frozen/);
    expect(heldOutRunBlock({ ...r, porcelain: '?? x' })).toMatch(/clean/);
    expect(heldOutRunBlock({ ...r, logText: RESCORE + '\n' })).toMatch(/no hum look-3/);
    expect(heldOutRunBlock({ ...base, logText: RESCORE + '\n' })).toBeNull(); // final is not blocked by a rescore line alone
  });
});

describe('parseHeldOutMode', () => {
  it('picks the mode and refuses ambiguous / incomplete command lines', () => {
    expect(parseHeldOutMode(['--selftest'])).toBe('selftest');
    expect(parseHeldOutMode(['--final-heldout'])).toBe('final-heldout');
    expect(parseHeldOutMode(['--rescore-m1', '--final-heldout'])).toBe('rescore-m1');
    expect(() => parseHeldOutMode([])).toThrow();
    expect(() => parseHeldOutMode(['--selftest', '--final-heldout'])).toThrow();
    expect(() => parseHeldOutMode(['--rescore-m1'])).toThrow();
    expect(() => parseHeldOutMode(['--rescore-m1', '--selftest'])).toThrow();
  });
});
