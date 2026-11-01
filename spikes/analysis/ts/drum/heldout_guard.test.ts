import { describe, expect, it } from 'vitest';
import { hasDrumLook3, heldOutRefusal, lookPointBlock, type GuardSources } from './heldout_guard';

const lookLine = (take: string, heldOut: boolean) => JSON.stringify({ time: 't', kind: 'look', input: 'drum', lookPoint: 3, take, heldOut, variants: [take], configHash: 'abc' });

const src: GuardSources = {
  syn: [
    { name: 'syn-d1-rock8-kA-s1', wav: 'syn-d1-rock8-kA-s1.wav', split: 'tuning', heldOut: false },
    { name: 'syn-d1-rock8-kC-s6', wav: 'syn-d1-rock8-kC-s6.wav', split: 'heldOut', heldOut: true },
  ],
  rec: [
    { name: 'drm-01-a', heldOut: false },
    { name: 'drm-05-e', heldOut: true },
  ],
  ids: { 'drm-01-a': { heldOut: false }, 'drm-05-e': { heldOut: true } },
};

describe('heldOutRefusal', () => {
  it('lets tuning / dev synthetic and dev recordings through', () => {
    expect(heldOutRefusal('out/drum/syn-d1-rock8-kA-s1.wav', src)).toBeNull();
    expect(heldOutRefusal('drm-01-a', src)).toBeNull();
  });
  it('refuses held-out synthetic by name, wav and truth path', () => {
    for (const p of ['syn-d1-rock8-kC-s6', 'out/drum/syn-d1-rock8-kC-s6.wav', 'out/drum/syn-d1-rock8-kC-s6.truth.json']) expect(heldOutRefusal(p, src)).toMatchObject({ heldOut: true });
  });
  it('refuses held-out recordings by manifest or by the ids file alone', () => {
    expect(heldOutRefusal('drm-05-e', src)).toMatchObject({ heldOut: true });
    expect(heldOutRefusal('recordings/drm-05-e.wav', { ...src, rec: null })).toMatchObject({ heldOut: true });
    expect(heldOutRefusal('drm-05-e', { ...src, ids: null })).toMatchObject({ heldOut: true });
  });
  it('refuses for good (not liftable) when the flag cannot be verified', () => {
    expect(heldOutRefusal('recordings/drm-02-b.wav', { syn: src.syn, rec: null, ids: null })).toMatchObject({ heldOut: false });
    expect(heldOutRefusal('syn-d0-x', { syn: null, rec: src.rec, ids: src.ids })).toMatchObject({ heldOut: false });
  });
});

describe('lookPointBlock', () => {
  const ok = { lookPoint: 3, logText: null, porcelain: '' };
  it('needs look point 3, a clean tree and no earlier look-3 line', () => {
    expect(lookPointBlock(ok)).toBeNull();
    expect(lookPointBlock({ ...ok, lookPoint: undefined })).toMatch(/--look-point 3/);
    expect(lookPointBlock({ ...ok, lookPoint: 2 })).toMatch(/once/);
    expect(lookPointBlock({ ...ok, porcelain: ' M x.ts\n' })).toMatch(/clean/);
    expect(lookPointBlock({ ...ok, porcelain: null })).toMatch(/clean/);
    const line = lookLine('drm-05-e', true);
    expect(hasDrumLook3([JSON.parse(line)])).toBe(true);
    expect(lookPointBlock({ ...ok, logText: line + '\n' })).toMatch(/already exists/);
  });
  it('a dev look-3 line or another input does not count', () => {
    const dev = lookLine('drm-01-a', false);
    expect(lookPointBlock({ lookPoint: 3, logText: dev + '\n', porcelain: '' })).toBeNull();
    expect(lookPointBlock({ lookPoint: 3, logText: JSON.stringify({ kind: 'look', input: 'hum', lookPoint: 3, heldOut: true }) + '\n', porcelain: '' })).toBeNull();
  });
});
