import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, cleanGenerated, gitCommit, mergeManifestVariants, peakStats, variantExtras } from './manifest';

describe('cleanGenerated', () => {
  it('removes only generated files from the given dirs', () => {
    const out = mkdtempSync(join(tmpdir(), 'manifest-'));
    for (const d of ['saints', 'etude', 'results']) mkdirSync(join(out, d));
    for (const f of ['saints/a.wav', 'saints/a.truth.json', 'etude/etude.bandsheet', 'etude/old.wav', 'saints/keep.txt', 'results/r.json'])
      writeFileSync(join(out, f), 'x');
    const removed = cleanGenerated(out, ['saints', 'etude', 'missing']);
    expect(removed).toHaveLength(4);
    expect(readdirSync(join(out, 'saints'))).toEqual(['keep.txt']);
    expect(readdirSync(join(out, 'etude'))).toEqual([]);
    expect(readdirSync(join(out, 'results'))).toEqual(['r.json']);
  });
});

describe('buildManifest', () => {
  it('carries metadata next to the variants', () => {
    const m = buildManifest(
      { alphaTab: '1.8.4', etudeSeed: 1, soundFont: 'sonivox.sf2', gitCommit: null, generatedAt: '2026-10-10T00:00:00Z', masterVolume: 0.7, tailSec: 2 },
      [{ name: 'x' }],
    );
    expect(m).toMatchObject({ alphaTab: '1.8.4', etudeSeed: 1, soundFont: 'sonivox.sf2', gitCommit: null });
    expect(m.variants).toEqual([{ name: 'x' }]);
  });
});

describe('gitCommit', () => {
  it('is null outside a repository', () => {
    expect(gitCommit(mkdtempSync(join(tmpdir(), 'nogit-')))).toBeNull();
  });
});

describe('peakStats', () => {
  it('reports the peak and clipped count', () => {
    expect(peakStats(new Float32Array([0.5, -0.9, 1.25, -1]))).toEqual({ peak: 1.25, clipped: 2 });
  });
});

describe('variantExtras', () => {
  it('always carries level and heldOut, with defaults for the spike 0 shape', () => {
    const base = { song: 'saints', mix: 'full', tempo: 116, swing: 'none', click: false, name: 'x' } as const;
    expect(variantExtras({ ...base })).toMatchObject({ level: 0, heldOut: false, comp: 'block4', soundFont: 'sonivox', pianoGainDb: 0 });
    expect(variantExtras({ ...base, level: 2, heldOut: true, comp: 'whole', etudeSeed: 2 })).toMatchObject({
      level: 2, heldOut: true, comp: 'whole', etudeSeed: 2,
    });
  });
});

describe('variantExtras (spike 2)', () => {
  const base = { song: 'etude', mix: 'piano', tempo: 124, swing: 'none', click: false, name: 'x' } as const;
  it('adds the spike 2 fields only when set', () => {
    expect(Object.keys(variantExtras({ ...base })).sort()).toEqual(['comp', 'heldOut', 'level', 'pianoGainDb', 'soundFont']);
    expect(
      variantExtras({ ...base, level: 'LR', lrGrade: 0, comp: 'rec', recSeed: 3, etudeForm: 'aaba', pickupBeats: 1, vocabShare: 0.2 }),
    ).toMatchObject({ level: 'LR', lrGrade: 0, comp: 'rec', recSeed: 3, etudeForm: 'aaba', pickupBeats: 1, vocabShare: 0.2 });
  });
});

describe('mergeManifestVariants', () => {
  it('keeps the variant order, prefers fresh entries, keeps old ones, drops unknown names', () => {
    const out = mergeManifestVariants(
      ['a', 'b', 'c', 'd'],
      [{ name: 'c', v: 2 }],
      [{ name: 'a', v: 1 }, { name: 'c', v: 1 }, { name: 'z', v: 1 }],
    );
    expect(out).toEqual([{ name: 'a', v: 1 }, { name: 'c', v: 2 }]);
  });
});
