import { describe, expect, it } from 'vitest';
import { committedBlock, doneGuard, harnessFixGuard, lookStatus, startGuard, takesBlock, type GitState, type LookRequest, type Registry } from './guard';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const T = '2026-11-14T00:00:00Z';
const reg: Registry = {
  'bas-01-a': { letter: 'a', heldOut: false, split: 'dev' },
  'bas-05-e': { letter: 'e', heldOut: false, split: 'dev', from: { spike: 6, heldOut: true } },
  'chd-05-e': { letter: 'e', heldOut: true, split: 'heldOut' },
  'chd-09-x': { letter: 'x', heldOut: true, split: 'dev' }, // flags disagree
};
const dev1: LookRequest = { look: 'dev-1', task: 'R2', reason: 'look point 1 before G1', configHashes: ['abc123def456'], takes: ['bas-01-a', 'bas-05-e'] };
const clean: GitState = { commit: H1.slice(0, 7), head: H1, porcelain: '', changed: null };
const log = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const lineOf = (r: ReturnType<typeof startGuard>) => {
  if ('refuse' in r) throw new Error(r.refuse);
  return r.line;
};
const refusal = (r: ReturnType<typeof startGuard>) => ('refuse' in r ? r.refuse : 'allowed');

describe('committedBlock', () => {
  it('needs the commit, = HEAD by prefix, and a clean tree', () => {
    expect(committedBlock(clean)).toBeNull();
    expect(committedBlock({ ...clean, commit: undefined })).toMatch(/commit is required/);
    expect(committedBlock({ ...clean, commit: 'xyz' })).toMatch(/hex sha/);
    expect(committedBlock({ ...clean, commit: H2.slice(0, 7) })).toMatch(/is not HEAD/);
    expect(committedBlock({ ...clean, porcelain: ' M spikes/analysis/ts/x.ts' })).toMatch(/not clean/);
    expect(committedBlock({ ...clean, head: null })).toMatch(/GIT_DIR/);
  });
});

describe('takesBlock', () => {
  it('passes takes registered with the look split', () => {
    expect(takesBlock(reg, ['bas-01-a', 'bas-05-e'], 'dev')).toBeNull();
    expect(takesBlock(reg, ['chd-05-e'], 'heldOut')).toBeNull();
    expect(takesBlock(null, [], 'dev')).toBeNull();
  });
  it('refuses unregistered, other-split, inconsistent or unverifiable takes', () => {
    expect(takesBlock(reg, ['chd-05-e'], 'dev')).toMatch(/registered as heldOut/);
    expect(takesBlock(reg, ['bas-01-a'], 'heldOut')).toMatch(/registered as dev/);
    expect(takesBlock(reg, ['bas-07-g'], 'dev')).toMatch(/not registered/);
    expect(takesBlock(reg, ['chd-09-x'], 'dev')).toMatch(/disagree/);
    expect(takesBlock(null, ['bas-01-a'], 'dev')).toMatch(/missing or unreadable/);
  });
});

describe('startGuard: allow', () => {
  it('logs a fresh dev look with commit, config hash, reason, takes', () => {
    const l = lineOf(startGuard(null, reg, dev1, clean, T));
    expect(l).toEqual({ time: T, kind: 'look-start', input: 'chords2', look: 'dev-1', split: 'dev', heldOut: false, task: 'R2', commit: H1, configHashes: ['abc123def456'], takes: ['bas-01-a', 'bas-05-e'], reason: 'look point 1 before G1' });
  });
  it('allows each of the five dev look points once, and the hold-out once', () => {
    let text = '';
    for (const look of ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'] as const) {
      const l = lineOf(startGuard(text, reg, { ...dev1, look }, clean, T));
      text += log(l, (doneGuard(text + log(l), look, T) as { line: object }).line);
    }
    const h = lineOf(startGuard(text, reg, { ...dev1, look: 'heldout', takes: ['chd-05-e'], synthetic: { split: 'heldOut', files: 12 } }, clean, T));
    expect(h).toMatchObject({ look: 'heldout', split: 'heldOut', heldOut: true, synthetic: { split: 'heldOut', files: 12 } });
    expect(Object.values(lookStatus(text + log(h)))).toEqual(['done', 'done', 'done', 'done', 'done', 'started, not finished']);
  });
  it('ignores lines of other inputs (spike 6 bass lines)', () => {
    const other = log({ kind: 'look-start', input: 'bass', look: 'dev-1' }, { kind: 'look', input: 'bass', lookPoint: 1 });
    expect(refusal(startGuard(other, reg, dev1, clean, T))).toBe('allowed');
  });
});

describe('startGuard: refuse', () => {
  it('refuses a sixth dev look point and unknown looks', () => {
    expect(refusal(startGuard(null, reg, { ...dev1, look: 'dev-6' as never }, clean, T))).toMatch(/unknown look/);
  });
  it('refuses a missing task, reason or config hash, and an empty look', () => {
    expect(refusal(startGuard(null, reg, { ...dev1, reason: ' ' }, clean, T))).toMatch(/reason/);
    expect(refusal(startGuard(null, reg, { ...dev1, task: '' }, clean, T))).toMatch(/task/);
    expect(refusal(startGuard(null, reg, { ...dev1, configHashes: [] }, clean, T))).toMatch(/config hash/);
    expect(refusal(startGuard(null, reg, { ...dev1, configHashes: [''] }, clean, T))).toMatch(/config hash/);
    expect(refusal(startGuard(null, reg, { ...dev1, takes: [] }, clean, T))).toMatch(/neither takes nor synthetic/);
  });
  it('refuses without the commit, off HEAD, on a dirty tree', () => {
    expect(refusal(startGuard(null, reg, dev1, { ...clean, commit: undefined }, T))).toMatch(/commit is required/);
    expect(refusal(startGuard(null, reg, dev1, { ...clean, commit: H2.slice(0, 8) }, T))).toMatch(/not HEAD/);
    expect(refusal(startGuard(null, reg, dev1, { ...clean, porcelain: '?? x' }, T))).toMatch(/not clean/);
  });
  it('refuses held-out takes in a dev look and dev takes in the hold-out look', () => {
    expect(refusal(startGuard(null, reg, { ...dev1, takes: ['chd-05-e'] }, clean, T))).toMatch(/registered as heldOut/);
    expect(refusal(startGuard(null, reg, { ...dev1, look: 'heldout' }, clean, T))).toMatch(/registered as dev/);
  });
  it('refuses a second run of a finished look', () => {
    const s = lineOf(startGuard(null, reg, dev1, clean, T));
    const text = log(s, (doneGuard(log(s), 'dev-1', T) as { line: object }).line);
    expect(refusal(startGuard(text, reg, dev1, clean, T))).toMatch(/already run to the end/);
    expect(doneGuard(text, 'dev-1', T)).toEqual({ refuse: 'look dev-1 is already done' });
  });
});

describe('crashed midway (start without done)', () => {
  const start = lineOf(startGuard(null, reg, dev1, clean, T));
  const crashed = log(start);
  const files = ['spikes/analysis/ts/chords2/eval/score.ts', 'spikes/analysis/ts/chords2/eval/score.test.ts'];
  const fix = (harnessFixGuard(crashed, 'dev-1', files, 'crashed on a flat-spelled root', T) as { line: object }).line;
  const fixed = crashed + log(fix);
  const later: GitState = { commit: H2.slice(0, 9), head: H2, porcelain: '', changed: [files[0]] };

  it('counts as looked: a second start is refused without a harness-fix line', () => {
    expect(refusal(startGuard(crashed, reg, dev1, clean, T))).toMatch(/never finished: it counts as looked/);
    expect(refusal(startGuard(crashed, reg, dev1, later, T))).toMatch(/needs one harness-fix line/);
    expect(lookStatus(crashed)['dev-1']).toBe('started, not finished');
  });
  it('the hold-out start marker refuses a second start the same way', () => {
    const h = { ...dev1, look: 'heldout' as const, takes: ['chd-05-e'] };
    const text = log(lineOf(startGuard(null, reg, h, clean, T)));
    expect(refusal(startGuard(text, reg, h, clean, T))).toMatch(/never finished/);
  });
  it('harness-fix line: written before the fix, lists harness files only, once', () => {
    expect(fix).toEqual({ time: T, kind: 'harness-fix', input: 'chords2', look: 'dev-1', fixes: H1, files, reason: 'crashed on a flat-spelled root' });
    expect(harnessFixGuard(fixed, 'dev-1', files, 'again', T)).toMatchObject({ refuse: expect.stringMatching(/already has a harness-fix/) });
    expect(harnessFixGuard(crashed, 'dev-1', ['spikes/analysis/ts/chords2/config.ts'], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/only scoring-harness files/) });
    expect(harnessFixGuard(crashed, 'dev-1', ['spikes/analysis/ts/chords2/eval/../config.ts'], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/only scoring-harness/) });
    expect(harnessFixGuard(crashed, 'dev-1', [], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/list the files/) });
    expect(harnessFixGuard(crashed, 'dev-1', files, '', T)).toMatchObject({ refuse: expect.stringMatching(/reason/) });
    expect(harnessFixGuard(null, 'dev-1', files, 'x', T)).toMatchObject({ refuse: expect.stringMatching(/0 starts/) });
    const done = crashed + log((doneGuard(crashed, 'dev-1', T) as { line: object }).line);
    expect(harnessFixGuard(done, 'dev-1', files, 'x', T)).toMatchObject({ refuse: expect.stringMatching(/is done/) });
  });
  it('allows ONE re-run at a clean later commit that changes listed files only', () => {
    const l = lineOf(startGuard(fixed, reg, dev1, later, T));
    expect(l).toMatchObject({ kind: 'look-start', look: 'dev-1', commit: H2, rerunOf: T });
    expect(lookStatus(fixed + log(l))['dev-1']).toBe('started, not finished (harness-fix logged)');
    expect(refusal(startGuard(fixed + log(l), reg, dev1, later, T))).toMatch(/already re-run once/);
    const done = fixed + log(l) + log((doneGuard(fixed + log(l), 'dev-1', T) as { line: object }).line);
    expect(lookStatus(done)['dev-1']).toBe('done (re-run once)');
  });
  it('refuses the re-run at the old commit, with other changes, dirty, or other settings', () => {
    expect(refusal(startGuard(fixed, reg, dev1, clean, T))).toMatch(/commit the harness fix first/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, changed: [files[0], 'spikes/analysis/ts/chords2/config.ts'] }, T))).toMatch(/outside the harness-fix list/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, changed: null }, T))).toMatch(/git diff/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, porcelain: ' M a' }, T))).toMatch(/not clean/);
    expect(refusal(startGuard(fixed, reg, { ...dev1, configHashes: ['ffffffffffff'] }, later, T))).toMatch(/same|must use/);
    expect(refusal(startGuard(fixed, reg, { ...dev1, takes: ['bas-01-a'] }, later, T))).toMatch(/must use/);
  });
});
