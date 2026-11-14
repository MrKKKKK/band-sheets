import { describe, expect, it } from 'vitest';
import { DEV_LOOK_INPUT, devLookCount, devLookLine, heldOutRefusal, selectVariants, type GuardSources } from './heldout_guard';

const syn = [
  { name: 'syn-b0-whole-tA-s1', wav: 'syn-b0-whole-tA-s1.wav', split: 'tuning', heldOut: false, timbre: 'A' },
  { name: 'syn-b0-whole-tB-s4', wav: 'syn-b0-whole-tB-s4.wav', split: 'dev', heldOut: false, timbre: 'B' },
  { name: 'syn-b0-whole-tC-s6', wav: 'syn-b0-whole-tC-s6.wav', split: 'heldOut', heldOut: true, timbre: 'C' },
  { name: 'syn-b1-rock8-tA-s9', wav: 'x.wav', split: 'tuning', heldOut: false, timbre: 'C' }, // mislabelled: timbre C wins
];
const src: GuardSources = { syn, rec: null, ids: { 'bas-01-a': { heldOut: false }, 'bas-02-e': { heldOut: true } } };

describe('bass held-out guard', () => {
  it('passes tuning / dev synthetic variants and dev recordings', () => {
    expect(heldOutRefusal('out/bass/syn-b0-whole-tA-s1.wav', src)).toBeNull();
    expect(heldOutRefusal('syn-b0-whole-tB-s4.truth.json', src)).toBeNull();
    expect(heldOutRefusal('recordings/bas-01-a.wav', src)).toBeNull();
  });
  it('refuses held-out variants, timbre C by name or field, held-out recordings', () => {
    expect(heldOutRefusal('out/bass/syn-b0-whole-tC-s6.wav', src)).toMatch(/timbre C/);
    expect(heldOutRefusal('syn-b1-rock8-tA-s9', src)).toMatch(/held-out/);
    expect(heldOutRefusal('recordings/bas-02-e.wav', src)).toMatch(/held-out recording/);
  });
  it('refuses what it cannot verify', () => {
    expect(heldOutRefusal('syn-b0-whole-tA-s1.wav', { syn: null, rec: null, ids: null })).toMatch(/cannot verify/);
    expect(heldOutRefusal('syn-b0-unknown-tA-s1.wav', src)).toMatch(/not in the manifest/);
    expect(heldOutRefusal('recordings/bas-09-c.wav', src)).toMatch(/unverifiable/);
    expect(heldOutRefusal('/tmp/some.wav', { syn, rec: null, ids: null })).toMatch(/unverifiable/);
  });
  it('selectVariants never returns held-out entries and rejects other splits', () => {
    expect(selectVariants(syn, ['tuning', 'dev']).map((v) => v.name)).toEqual(['syn-b0-whole-tA-s1', 'syn-b0-whole-tB-s4']);
    expect(selectVariants(syn, ['tuning'], 'syn-b0-*').map((v) => v.name)).toEqual(['syn-b0-whole-tA-s1']);
    expect(() => selectVariants(syn, ['heldOut'])).toThrow(/only tuning/);
  });
  it('dev looks are logged lines and counted', () => {
    const line = devLookLine({ task: 'T5', reason: 'final check', configHash: 'abc', commit: 'x', files: 2, at: 't' });
    expect(JSON.parse(line)).toMatchObject({ kind: 'look', input: DEV_LOOK_INPUT, heldOut: false });
    const log = [line, JSON.stringify({ kind: 'register', input: 'bass' }), line].join('\n');
    expect(devLookCount(log)).toBe(2);
    expect(devLookCount(null)).toBe(0);
  });
});
