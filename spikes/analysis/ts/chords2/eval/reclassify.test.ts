import { describe, expect, it } from 'vitest';
import { startGuard, type Registry } from './guard';
import { reclassifyPlan, SPIKE6_IDS, takeFiles } from './reclassify';

const T = '2026-11-14T00:00:00Z';
const C = 'c'.repeat(40);
const spike6: Registry = Object.fromEntries(SPIKE6_IDS.map((id) => [id, { letter: id.slice(-1), heldOut: /-[ef]$/.test(id) }]));
const ok = (r: ReturnType<typeof reclassifyPlan>) => {
  if ('refuse' in r) throw new Error(r.refuse);
  return r;
};

describe('reclassifyPlan', () => {
  it('registers all six as dev, keeps where they came from, and writes one reclassify line', () => {
    const p = ok(reclassifyPlan(spike6, null, null, C, T));
    expect(Object.keys(p.registry)).toEqual(SPIKE6_IDS);
    expect(Object.values(p.registry).every((e) => e.heldOut === false && e.split === 'dev')).toBe(true);
    expect(p.registry['bas-05-e'].from).toEqual({ spike: 6, heldOut: true });
    expect(p.registry['bas-01-a'].from).toEqual({ spike: 6, heldOut: false });
    expect(p.line).toMatchObject({ kind: 'reclassify', input: 'chords2', task: 'T1', split: 'dev', heldOut: false, takes: SPIKE6_IDS, commit: C, spike6: { heldOut: ['bas-05-e', 'bas-06-f'], heldOutLooks: 1 } });
    expect(String((p.line as Record<string, unknown>).decision)).toMatch(/decision 6/);
  });
  it('keeps other spike 7 entries', () => {
    const p = ok(reclassifyPlan(spike6, { 'chd-01-a': { heldOut: false, split: 'dev' } }, null, C, T));
    expect(Object.keys(p.registry)).toHaveLength(7);
  });
  it('lets e/f into a dev look afterwards and keeps them out of the hold-out look', () => {
    const p = ok(reclassifyPlan(spike6, null, null, C, T));
    const git = { commit: C.slice(0, 7), head: C, porcelain: '', changed: null };
    const req = { look: 's8-dev-1' as const, task: 'R2', reason: 'r', configHashes: ['h'], takes: ['bas-05-e', 'bas-06-f'] };
    expect(startGuard(null, p.registry, req, git, T)).toHaveProperty('line');
    const counted = JSON.stringify({ kind: 'count', input: 'chords2', task: 'T2' }) + '\n';
    expect(startGuard(counted, p.registry, { ...req, look: 's8-heldout' }, git, T)).toMatchObject({ refuse: expect.stringMatching(/registered as dev/) });
  });
  it('refuses a second time, an unexpected spike 6 registry, or a missing one', () => {
    const p = ok(reclassifyPlan(spike6, null, null, C, T));
    expect(reclassifyPlan(spike6, p.registry, null, C, T)).toMatchObject({ refuse: expect.stringMatching(/already registered/) });
    expect(reclassifyPlan(spike6, null, JSON.stringify(p.line) + '\n', C, T)).toMatchObject({ refuse: expect.stringMatching(/already has a chords2 reclassify/) });
    expect(reclassifyPlan(null, null, null, C, T)).toMatchObject({ refuse: expect.stringMatching(/missing/) });
    const { ['bas-06-f']: _gone, ...five } = spike6;
    expect(reclassifyPlan(five, null, null, C, T)).toMatchObject({ refuse: expect.stringMatching(/lists 5 ids/) });
    expect(reclassifyPlan({ ...spike6, 'bas-05-e': { letter: 'e', heldOut: false } }, null, null, C, T)).toMatchObject({ refuse: expect.stringMatching(/held-out flag/) });
  });
  it('copies the audio, the truth and the original chart text of each take', () => {
    expect(takeFiles('bas-01-a')).toEqual(['bas-01-a.wav', 'bas-01-a.truth.json', 'bas-originals/bas-01-a.txt']);
  });
});
