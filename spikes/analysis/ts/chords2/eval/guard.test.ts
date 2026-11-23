import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { allBassVariants } from '../../../render/bass/variants';
import { allVariants } from '../../../render/variants';
import {
  beginCount,
  beginLook,
  committedBlock,
  countGuard,
  doneGuard,
  harnessFixGuard,
  lookStatus,
  requireCommittedDryRun,
  startGuard,
  synthSplit,
  syntheticCheck,
  takesBlock,
  type CountRequest,
  type GitState,
  type GuardIo,
  type LogLine,
  type LookRequest,
  type Registry,
} from './guard';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const T = '2026-11-23T00:00:00Z';
const reg: Registry = {
  'bas-01-a': { letter: 'a', heldOut: false, split: 'dev' },
  'bas-05-e': { letter: 'e', heldOut: false, split: 'dev', from: { spike: 6, heldOut: true } },
  'chd-05-e': { letter: 'e', heldOut: true, split: 'heldOut' },
  'chd-09-x': { letter: 'x', heldOut: true, split: 'dev' }, // flags disagree
};
const dev1: LookRequest = { look: 's8-dev-1', task: 'T7', reason: 'look point 1 before G1', configHashes: ['abc123def456'], takes: ['bas-01-a', 'bas-05-e'] };
const held: LookRequest = { ...dev1, look: 's8-heldout', task: 'T12', takes: ['chd-05-e'] };
const clean: GitState = { commit: H1.slice(0, 7), head: H1, porcelain: '', changed: null };
const log = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
const lineOf = (r: { line: LogLine } | { refuse: string }) => {
  if ('refuse' in r) throw new Error(r.refuse);
  return r.line;
};
const refusal = (r: { line: LogLine } | { refuse: string }) => ('refuse' in r ? r.refuse : 'allowed');
const countReq: CountRequest = { task: 'T2', reason: 'decision 5', folders: ['spikes/analysis/recordings/chd-heldout-scores'] };
const COUNTED = log(lineOf(countGuard(null, countReq, clean, T)));
/** Spike 7's finished looks, as in the copied log: they must not count for spike 8. */
const S7 = log(...['dev-1', 'dev-2', 'dev-3'].flatMap((look) => [{ kind: 'look-start', input: 'chords2', look, commit: 'c'.repeat(40) }, { kind: 'look-done', input: 'chords2', look }]));
/** Runs a look start -> done on top of `text`. */
const run = (text: string, req: LookRequest, git = clean) => {
  const s = lineOf(startGuard(text, reg, req, git, T));
  return text + log(s, lineOf(doneGuard(text + log(s), req.look, T)));
};

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

describe('synthetic file list (split and count)', () => {
  const b6 = allBassVariants();
  const s0 = allVariants();
  it('derives the split from the recipe, never from the caller', () => {
    expect(synthSplit('c2-t-b-clean-s1')).toBe('tuning');
    expect(synthSplit('c2-d-v1-human-s4')).toBe('dev');
    expect(synthSplit('c2-h-v3-peaky-s9')).toBe('heldOut');
    for (const s of ['tuning', 'dev', 'heldOut']) expect(synthSplit(b6.find((v) => v.split === s)!.name)).toBe(s);
    expect(synthSplit(s0.find((v) => v.heldOut)!.name)).toBe('heldOut');
    expect(synthSplit(s0.find((v) => !v.heldOut)!.name)).toBe('tuning');
    expect(synthSplit('my-new-l-set-01')).toBeNull();
    expect(synthSplit('c2-d-unknown')).toBeNull(); // right prefix, not in the recipe list: refused
    expect(synthSplit('c2-h-unknown')).toBe('heldOut');
  });
  it('dev look: dev files, tuning files as a watch; counts per split and a names hash (order-free)', () => {
    const r = syntheticCheck(['c2-d-v1-human-s4', 'c2-d-b-clean-s5', 'c2-t-b-clean-s1'], 'dev');
    expect(r).toEqual({ line: { files: 3, splits: { dev: 2, tuning: 1 }, namesSha: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    expect(syntheticCheck(['c2-t-b-clean-s1', 'c2-d-b-clean-s5', 'c2-d-v1-human-s4'], 'dev')).toEqual(r);
    expect(syntheticCheck(undefined, 'dev')).toEqual({});
  });
  it('refuses held-out files in a dev look, dev / tuning files in the hold-out look, unknown names and duplicates', () => {
    expect(syntheticCheck(['c2-d-v1-human-s4', 'c2-h-v3-peaky-s9'], 'dev')).toEqual({ refuse: expect.stringMatching(/c2-h-v3-peaky-s9: heldOut file in a dev look/) });
    expect(syntheticCheck([b6.find((v) => v.split === 'heldOut')!.name], 'dev')).toMatchObject({ refuse: expect.stringMatching(/heldOut file/) });
    expect(syntheticCheck(['c2-h-v3-peaky-s9', 'c2-d-v1-human-s4'], 'heldOut')).toMatchObject({ refuse: expect.stringMatching(/dev file in a heldOut look/) });
    expect(syntheticCheck(['c2-t-b-clean-s1'], 'heldOut')).toMatchObject({ refuse: expect.stringMatching(/tuning file/) });
    expect(syntheticCheck(['my-new-l-set-01'], 'dev')).toMatchObject({ refuse: expect.stringMatching(/not a known synthetic recipe/) });
    expect(syntheticCheck(['c2-d-v1-human-s4', 'c2-d-v1-human-s4'], 'dev')).toMatchObject({ refuse: expect.stringMatching(/duplicates/) });
  });
  it('startGuard logs the checked list and needs files of the look split (a tuning watch alone is not a look)', () => {
    const l = lineOf(startGuard(null, reg, { ...dev1, takes: [], synthetic: ['c2-d-v1-human-s4', 'c2-t-b-clean-s1'] }, clean, T));
    expect(l.synthetic).toMatchObject({ files: 2, splits: { dev: 1, tuning: 1 } });
    expect(refusal(startGuard(null, reg, { ...dev1, takes: [], synthetic: ['c2-t-b-clean-s1'] }, clean, T))).toMatch(/neither takes nor synthetic files of its split/);
    expect(refusal(startGuard(null, reg, { ...dev1, synthetic: ['c2-h-v3-peaky-s9'] }, clean, T))).toMatch(/heldOut file in a dev look/);
  });
});

describe('startGuard: allow', () => {
  it('logs a fresh dev look with commit, config hash, reason, takes', () => {
    expect(lineOf(startGuard(S7, reg, dev1, clean, T))).toEqual({ time: T, kind: 'look-start', input: 'chords2', look: 's8-dev-1', split: 'dev', heldOut: false, task: 'T7', commit: H1, configHashes: ['abc123def456'], takes: ['bas-01-a', 'bas-05-e'], reason: 'look point 1 before G1' });
  });
  it('runs the three dev looks in order, then the hold-out once (after the count)', () => {
    let text = S7 + COUNTED;
    for (const look of ['s8-dev-1', 's8-dev-2', 's8-dev-3'] as const) text = run(text, { ...dev1, look });
    const h = lineOf(startGuard(text, reg, { ...held, synthetic: ['c2-h-v3-peaky-s9'] }, clean, T));
    expect(h).toMatchObject({ look: 's8-heldout', split: 'heldOut', heldOut: true, synthetic: { files: 1, splits: { heldOut: 1 } } });
    const st = lookStatus(text + log(h));
    expect([st['s8-dev-1'], st['s8-dev-2'], st['s8-dev-3'], st['s8-heldout']]).toEqual(['done', 'done', 'done', 'started, not finished']);
    expect(st['dev-1']).toBe('done (spike 7, closed)');
    expect(st.heldout).toBe('unused (spike 7, closed)');
  });
  it('the hold-out may follow fewer dev looks (F2 skipped: T9 is s8-dev-2)', () => {
    const text = run(run(COUNTED, dev1), { ...dev1, look: 's8-dev-2' });
    expect(refusal(startGuard(text, reg, held, clean, T))).toBe('allowed');
  });
  it('ignores lines of other inputs (spike 6 bass lines)', () => {
    const other = log({ kind: 'look-start', input: 'bass', look: 's8-dev-1' }, { kind: 'look', input: 'bass', lookPoint: 1 });
    expect(refusal(startGuard(other, reg, dev1, clean, T))).toBe('allowed');
  });
});

describe('startGuard: refuse', () => {
  it('refuses unknown looks and spike 7 look names (closed)', () => {
    expect(refusal(startGuard(null, reg, { ...dev1, look: 's8-dev-4' as never }, clean, T))).toMatch(/unknown look/);
    for (const look of ['dev-4', 'dev-5', 'heldout'] as const) expect(refusal(startGuard(S7, reg, { ...dev1, look }, clean, T))).toMatch(/spike 7 look name, closed/);
    expect(harnessFixGuard(S7, 'dev-1', ['spikes/analysis/ts/chords2/eval/score.ts'], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/unknown look/) });
  });
  it('enforces the order: dev looks one after another, nothing after a later look, the hold-out last', () => {
    expect(refusal(startGuard(null, reg, { ...dev1, look: 's8-dev-2' }, clean, T))).toMatch(/s8-dev-1 is not done/);
    const started = log(lineOf(startGuard(null, reg, dev1, clean, T)));
    expect(refusal(startGuard(started, reg, { ...dev1, look: 's8-dev-2' }, clean, T))).toMatch(/s8-dev-1 is not done/);
    const two = run(run(COUNTED, dev1), { ...dev1, look: 's8-dev-2' });
    expect(refusal(startGuard(two, reg, { ...dev1, look: 's8-dev-1' }, clean, T))).toMatch(/s8-dev-2 has already started/);
    const h = two + log(lineOf(startGuard(two, reg, held, clean, T)));
    expect(refusal(startGuard(h, reg, { ...dev1, look: 's8-dev-3' }, clean, T))).toMatch(/s8-heldout has already started/);
  });
  it('refuses the hold-out before the count, and while a dev look is unfinished', () => {
    expect(refusal(startGuard(run('', dev1), reg, held, clean, T))).toMatch(/not counted/);
    const open = COUNTED + log(lineOf(startGuard(COUNTED, reg, dev1, clean, T)));
    expect(refusal(startGuard(open, reg, held, clean, T))).toMatch(/s8-dev-1 started and never finished/);
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
    expect(refusal(startGuard(run(COUNTED, dev1), reg, { ...held, takes: ['bas-01-a'] }, clean, T))).toMatch(/registered as dev/);
  });
  it('refuses a second run of a finished look', () => {
    const text = run('', dev1);
    expect(refusal(startGuard(text, reg, dev1, clean, T))).toMatch(/already run to the end/);
    expect(doneGuard(text, 's8-dev-1', T)).toEqual({ refuse: 'look s8-dev-1 is already done' });
  });
});

describe('crashed midway (start without done)', () => {
  const start = lineOf(startGuard(null, reg, dev1, clean, T));
  const crashed = log(start);
  const files = ['spikes/analysis/ts/chords2/eval/score.ts', 'spikes/analysis/ts/chords2/eval/score.test.ts'];
  const fix = lineOf(harnessFixGuard(crashed, 's8-dev-1', files, 'crashed on a flat-spelled root', T));
  const fixed = crashed + log(fix);
  const later: GitState = { commit: H2.slice(0, 9), head: H2, porcelain: '', changed: [files[0]] };

  it('counts as looked: a second start is refused without a harness-fix line', () => {
    expect(refusal(startGuard(crashed, reg, dev1, clean, T))).toMatch(/never finished: it counts as looked/);
    expect(refusal(startGuard(crashed, reg, dev1, later, T))).toMatch(/needs one harness-fix line/);
    expect(lookStatus(crashed)['s8-dev-1']).toBe('started, not finished');
  });
  it('harness-fix line: written before the fix, lists harness files only, once', () => {
    expect(fix).toEqual({ time: T, kind: 'harness-fix', input: 'chords2', look: 's8-dev-1', fixes: H1, files, reason: 'crashed on a flat-spelled root' });
    expect(harnessFixGuard(fixed, 's8-dev-1', files, 'again', T)).toMatchObject({ refuse: expect.stringMatching(/already has a harness-fix/) });
    expect(harnessFixGuard(crashed, 's8-dev-1', ['spikes/analysis/ts/chords2/config.ts'], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/only scoring-harness files/) });
    expect(harnessFixGuard(crashed, 's8-dev-1', ['spikes/analysis/ts/chords2/eval/../config.ts'], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/only scoring-harness/) });
    expect(harnessFixGuard(crashed, 's8-dev-1', [], 'x', T)).toMatchObject({ refuse: expect.stringMatching(/list the files/) });
    expect(harnessFixGuard(crashed, 's8-dev-1', files, '', T)).toMatchObject({ refuse: expect.stringMatching(/reason/) });
    expect(harnessFixGuard(null, 's8-dev-1', files, 'x', T)).toMatchObject({ refuse: expect.stringMatching(/0 starts/) });
    const done = crashed + log(lineOf(doneGuard(crashed, 's8-dev-1', T)));
    expect(harnessFixGuard(done, 's8-dev-1', files, 'x', T)).toMatchObject({ refuse: expect.stringMatching(/is done/) });
  });
  it('allows ONE re-run at a clean later commit that changes listed files only', () => {
    const l = lineOf(startGuard(fixed, reg, dev1, later, T));
    expect(l).toMatchObject({ kind: 'look-start', look: 's8-dev-1', commit: H2, rerunOf: T });
    expect(lookStatus(fixed + log(l))['s8-dev-1']).toBe('started, not finished (harness-fix logged)');
    expect(refusal(startGuard(fixed + log(l), reg, dev1, later, T))).toMatch(/already re-run once/);
    const done = fixed + log(l) + log(lineOf(doneGuard(fixed + log(l), 's8-dev-1', T)));
    expect(lookStatus(done)['s8-dev-1']).toBe('done (re-run once)');
  });
  it('refuses the re-run at the old commit, with other changes, dirty, or other settings / files', () => {
    expect(refusal(startGuard(fixed, reg, dev1, clean, T))).toMatch(/commit the harness fix first/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, changed: [files[0], 'spikes/analysis/ts/chords2/config.ts'] }, T))).toMatch(/outside the harness-fix list/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, changed: null }, T))).toMatch(/git diff/);
    expect(refusal(startGuard(fixed, reg, dev1, { ...later, porcelain: ' M a' }, T))).toMatch(/not clean/);
    expect(refusal(startGuard(fixed, reg, { ...dev1, configHashes: ['ffffffffffff'] }, later, T))).toMatch(/must use/);
    expect(refusal(startGuard(fixed, reg, { ...dev1, takes: ['bas-01-a'] }, later, T))).toMatch(/must use/);
    expect(refusal(startGuard(fixed, reg, { ...dev1, synthetic: ['c2-d-v1-human-s4'] }, later, T))).toMatch(/must use/);
  });
});

describe('the hold-out count line', () => {
  it('is logged once, with task, commit and folders, on committed clean code', () => {
    expect(lineOf(countGuard(S7, countReq, clean, T))).toEqual({ time: T, kind: 'count', input: 'chords2', task: 'T2', commit: H1, folders: countReq.folders, reason: 'decision 5' });
    expect(refusal(countGuard(COUNTED, countReq, clean, T))).toMatch(/already counted/);
  });
  it('refuses without task / reason / folders, off HEAD, dirty, and after the hold-out look started', () => {
    expect(refusal(countGuard(null, { ...countReq, task: '' }, clean, T))).toMatch(/task/);
    expect(refusal(countGuard(null, { ...countReq, folders: [] }, clean, T))).toMatch(/folders/);
    expect(refusal(countGuard(null, countReq, { ...clean, commit: undefined }, T))).toMatch(/commit is required/);
    expect(refusal(countGuard(null, countReq, { ...clean, porcelain: '?? x' }, T))).toMatch(/not clean/);
    const opened = log({ kind: 'look-start', input: 'chords2', look: 's8-heldout' });
    expect(refusal(countGuard(opened, countReq, clean, T))).toMatch(/hold-out look has started/);
  });
});

describe('impure side on a temporary log (the paths before they are used)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const io = (git: GitState = clean): GuardIo => {
    let k = 0;
    return { log: join(dir, 'heldout-log.jsonl'), registry: () => reg, gitState: (commit) => ({ ...git, commit }), now: () => `2026-11-23T00:00:0${k++}Z` };
  };
  const kinds = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => `${JSON.parse(l).kind}:${JSON.parse(l).look ?? ''}`);

  it('hold-out: count -> dev look -> started -> done; a second start is refused', () => {
    dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const o = io();
    expect(() => beginLook(held, H1.slice(0, 7), o)).toThrow(/not counted/);
    beginCount(countReq, H1.slice(0, 7), o);
    expect(() => beginCount(countReq, H1.slice(0, 7), o)).toThrow(/already counted/);
    beginLook(dev1, H1.slice(0, 7), o).finish();
    const h = beginLook(held, H1.slice(0, 7), o);
    expect(h.line).toMatchObject({ kind: 'look-start', look: 's8-heldout', heldOut: true, commit: H1 });
    h.finish();
    expect(() => h.finish()).toThrow(/already done/);
    expect(() => beginLook(held, H1.slice(0, 7), o)).toThrow(/already run to the end/);
    expect(kinds(o.log)).toEqual(['count:', 'look-start:s8-dev-1', 'look-done:s8-dev-1', 'look-start:s8-heldout', 'look-done:s8-heldout']);
  });
  it('hold-out interrupted: the start alone counts as looked; one harness-fix re-run, then done', () => {
    dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const o = io();
    beginCount(countReq, H1.slice(0, 7), o);
    beginLook(held, H1.slice(0, 7), o); // crashed before finish()
    expect(() => beginLook(held, H1.slice(0, 7), o)).toThrow(/never finished: it counts as looked/);
    const files = ['spikes/analysis/ts/chords2/eval/score.ts'];
    const fixText = readFileSync(o.log, 'utf8');
    appendFileSync(o.log, JSON.stringify(lineOf(harnessFixGuard(fixText, 's8-heldout', files, 'crashed', T))) + '\n');
    const o2 = { ...io({ commit: undefined, head: H2, porcelain: '', changed: files }), log: o.log };
    const r = beginLook(held, H2.slice(0, 7), o2);
    expect(r.line).toMatchObject({ look: 's8-heldout', commit: H2, rerunOf: expect.any(String) });
    r.finish();
    expect(lookStatus(readFileSync(o.log, 'utf8'))['s8-heldout']).toBe('done (re-run once)');
    expect(kinds(o.log)).toEqual(['count:', 'look-start:s8-heldout', 'harness-fix:s8-heldout', 'look-start:s8-heldout', 'look-done:s8-heldout']);
  });
  it('a refused start appends nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const o = io({ ...clean, porcelain: ' M x' });
    expect(() => beginLook(dev1, H1.slice(0, 7), o)).toThrow(/not clean/);
    expect(() => beginCount(countReq, H1.slice(0, 7), o)).toThrow(/not clean/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('dry runs need the commit too (the check is not empty)', () => {
  const head = { gitState: (commit: string | undefined) => ({ ...clean, commit }) };
  it('refuses without --commit even though HEAD is known, passes with it', () => {
    expect(() => requireCommittedDryRun([], head)).toThrow(/commit is required/);
    expect(() => requireCommittedDryRun(['--commit', H1.slice(0, 7)], head)).not.toThrow();
    expect(() => requireCommittedDryRun(['--commit', H2.slice(0, 7)], head)).toThrow(/not HEAD/);
  });
  it('no chords2 tool passes HEAD as the commit', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tools = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const bad = tools.filter((f) => /rev-parse', 'HEAD'\]\)\s*\?\?|commit:\s*git\(\['rev-parse'/.test(readFileSync(join(here, f), 'utf8')));
    expect(bad).toEqual([]);
  });
});
