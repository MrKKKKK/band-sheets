import { describe, expect, it } from 'vitest';
import { checkTakes, finalGuard, FROZEN_HASHES, FROZEN_SETS, harnessFixLine, harnessOnlyBlock, HARNESS_FILES, INPUT_GAINS, synthVariants, type FinalGuardInput } from './heldout_eval';
import { bassConfigHash, enabledBassConfig } from './config';

const look3 = (o: object = {}) =>
  JSON.stringify({ kind: 'look', input: 'bass', lookPoint: 3, split: 'heldOut', heldOut: true, task: 'T13', takes: ['bas-05-e', 'bas-06-f'], synthetic: { split: 'heldOut', timbre: 'C', files: 48 }, configHashes: FROZEN_HASHES, commit: 'abc1234', inputGain: INPUT_GAINS, ...o });
const r3 = JSON.stringify({ kind: 'look', input: 'bass', lookPoint: 2, split: 'dev', heldOut: false, task: 'R3', takes: ['bas-01-a'] });
const reg = JSON.stringify({ kind: 'register', input: 'bass', take: 'bas-05-e', heldOut: true });
const ok: FinalGuardInput = { logText: [reg, r3, look3()].join('\n'), commit: 'abc1234', head: 'abc1234', porcelain: '', hashes: FROZEN_HASHES, done: false, changed: null };
const refusal = (o: Partial<FinalGuardInput>) => {
  const g = finalGuard({ ...ok, ...o });
  return 'refuse' in g ? g.refuse : null;
};

describe('FROZEN_SETS', () => {
  it('hash to the pair R2 / R3 scored (T8-equivalent, G2 default)', () => {
    expect(Object.values(FROZEN_SETS).map((o) => bassConfigHash(enabledBassConfig(o)))).toEqual(FROZEN_HASHES);
  });
});

describe('finalGuard', () => {
  it('passes with the one look-3 line, the logged commit, a clean HEAD and the frozen hashes', () => {
    const g = finalGuard(ok);
    expect('line' in g && g.line.takes).toEqual(['bas-05-e', 'bas-06-f']);
  });
  it('refuses without a look-3 line, or with two', () => {
    expect(refusal({ logText: [reg, r3].join('\n') })).toMatch(/found 0/);
    expect(refusal({ logText: null })).toMatch(/found 0/);
    expect(refusal({ logText: [look3(), look3()].join('\n') })).toMatch(/found 2/);
    expect(refusal({ logText: [look3(), look3({ lookPoint: 2 })].join('\n') })).toMatch(/found 2/);
  });
  it('refuses a line that is not the T13 held-out look', () => {
    expect(refusal({ logText: look3({ task: 'R4' }) })).toMatch(/not the T13/);
    expect(refusal({ logText: look3({ takes: [] }) })).toMatch(/not the T13/);
    expect(refusal({ logText: look3({ synthetic: { files: 0 } }) })).toMatch(/not the T13/);
  });
  it('refuses a second scoring run', () => {
    expect(refusal({ done: true })).toMatch(/already scored/);
  });
  it('needs the logged commit, git, a matching clean HEAD', () => {
    expect(refusal({ commit: undefined })).toMatch(/commit is required/);
    expect(refusal({ commit: 'fff0000' })).toMatch(/not HEAD/);
    expect(refusal({ head: null })).toMatch(/git failed/);
    expect(refusal({ porcelain: null })).toMatch(/git failed/);
    expect(refusal({ head: 'fff0000' })).toMatch(/HEAD/);
    expect(refusal({ porcelain: ' M ts/bass/config.ts' })).toMatch(/clean/);
  });
  it('refuses configs or input gains other than the frozen ones', () => {
    expect(refusal({ hashes: ['3f11c4c58c5a', '000000000000'] })).toMatch(/not the frozen/);
    expect(refusal({ logText: look3({ configHashes: ['e5b432a11e3c'] }) })).toMatch(/logged config hashes/);
    expect(refusal({ logText: look3({ inputGain: ['tuning-median-rms'] }) })).toMatch(/input gains/);
  });
});

describe('checkTakes', () => {
  const src = {
    syn: [],
    rec: [
      { name: 'bas-01-a', heldOut: false },
      { name: 'bas-05-e', heldOut: true },
    ],
    ids: { 'bas-01-a': { heldOut: false }, 'bas-05-e': { heldOut: true } },
  };
  it('accepts held-out takes for the final run and dev takes for the selftest only', () => {
    expect(() => checkTakes(['bas-05-e'], src, true)).not.toThrow();
    expect(() => checkTakes(['bas-01-a'], src, false)).not.toThrow();
    expect(() => checkTakes(['bas-01-a'], src, true)).toThrow(/not held out/);
    expect(() => checkTakes(['bas-05-e'], src, false)).toThrow(/not dev/);
  });
  it('refuses disagreeing registries and unlisted takes', () => {
    expect(() => checkTakes(['bas-05-e'], { ...src, rec: [{ name: 'bas-05-e', heldOut: false }] }, true)).toThrow(/every registry/);
    expect(() => checkTakes(['bas-07-g'], src, true)).toThrow(/unverifiable/);
  });
});

describe('synthVariants', () => {
  const v = (name: string, split: string, timbre: string, heldOut: boolean) => ({ name, split, timbre, heldOut, level: 'B0', wav: `${name}.wav`, truth: `${name}.truth.json` });
  const all = [v('syn-b0-x-tA-s1', 'tuning', 'A', false), v('syn-b0-x-tA-s4', 'dev', 'A', false), v('syn-b0-x-tC-s6', 'heldOut', 'C', true)];
  it('selects the held-out split or the tuning split only', () => {
    expect(synthVariants(all, 'heldOut').map((x) => x.name)).toEqual(['syn-b0-x-tC-s6']);
    expect(synthVariants(all, 'tuning').map((x) => x.name)).toEqual(['syn-b0-x-tA-s1']);
  });
  it('refuses held-out flags that disagree', () => {
    expect(() => synthVariants([...all, v('syn-b0-y-tC-s1', 'tuning', 'C', false)], 'heldOut')).toThrow(/disagree/);
  });
});

describe('harness fix after the look', () => {
  const fix = (o: object = {}) => JSON.stringify({ kind: 'harness-fix', input: 'bass', task: 'T13', lookPoint: 3, fixes: 'abc1234', commit: 'def5678', ...o });
  const later: FinalGuardInput = { ...ok, commit: 'def5678', head: 'def5678', changed: [HARNESS_FILES[0], HARNESS_FILES[1]] };
  const fixRefusal = (o: Partial<FinalGuardInput>, reason = 'flat root crash') => {
    const r = harnessFixLine({ ...later, ...o }, reason, '2026-11-14T00:00:00Z');
    return 'refuse' in r ? r.refuse : null;
  };
  it('logs one linked line for a clean later commit that touches harness files only', () => {
    const r = harnessFixLine(later, 'flat root crash', '2026-11-14T00:00:00Z');
    expect('line' in r && JSON.parse(r.line)).toMatchObject({ kind: 'harness-fix', fixes: 'abc1234', commit: 'def5678', files: later.changed });
  });
  it('refuses the fix line without the look, after scoring, twice, dirty, at the logged commit, or beyond the harness', () => {
    expect(fixRefusal({ logText: r3 })).toMatch(/found 0/);
    expect(fixRefusal({ done: true })).toMatch(/already scored/);
    expect(fixRefusal({ logText: [look3(), fix()].join('\n') })).toMatch(/already exists/);
    expect(fixRefusal({ porcelain: ' M x' })).toMatch(/clean/);
    expect(fixRefusal({ head: 'abc1234', commit: 'abc1234' })).toMatch(/commit the fix first/);
    expect(fixRefusal({ commit: 'abc1234' })).toMatch(/not HEAD/);
    expect(fixRefusal({ changed: [...HARNESS_FILES, 'spikes/analysis/ts/bass/config.ts'] })).toMatch(/outside the scoring harness/);
    expect(fixRefusal({}, ' ')).toMatch(/reason/);
  });
  it('lets the final run accept the fix commit only with that line and a harness-only diff', () => {
    const withFix = { ...later, logText: [look3(), fix()].join('\n') };
    expect(finalGuard(withFix)).toHaveProperty('line');
    expect(refusal({ ...later })).toMatch(/harness-fix/);
    expect(refusal({ ...withFix, changed: ['spikes/analysis/ts/dsp/chords.ts'] })).toMatch(/outside/);
    expect(refusal({ ...withFix, changed: null })).toMatch(/diff failed/);
    expect(refusal({ ...withFix, head: 'fff0000', commit: 'fff0000' })).toMatch(/harness-fix/);
    expect(refusal({ ...ok, logText: [look3(), fix()].join('\n') })).toMatch(/HEAD must be its commit/);
  });
  it('harnessOnlyBlock', () => {
    expect(harnessOnlyBlock(HARNESS_FILES)).toBeNull();
    expect(harnessOnlyBlock([])).toBeNull();
    expect(harnessOnlyBlock(['spikes/analysis/ts/bass/slash.ts'])).toMatch(/outside/);
  });
});
