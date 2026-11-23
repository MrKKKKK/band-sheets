// Spike 8 T3: the hold-out synthetic files (c2-h-*, seeds 8-9) must not change, and (same-seed determinism: render.test.ts).
// heldout-hashes.json = SHA-256 of every c2-h-*.wav as spike 7 rendered it (the 136 files; T2 re-rendered them with the
// same hashes). The hashes are compared only: no hold-out audio is opened or analysed here.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderC2 } from './render';
import { synthSplit } from '../../ts/chords2/eval/guard';
import { allDevVariants, allVariants } from '../variants';
import { allC2Variants } from './variants';
import { pianoAvailable } from './pianos';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const recorded: Record<string, string> = JSON.parse(readFileSync(new URL('./heldout-hashes.json', import.meta.url), 'utf8'));
const OUT = fileURLToPath(new URL('../../out/chords2/', import.meta.url));

describe('hold-out stays as it was', { timeout: 600_000 }, () => {
  const held = allC2Variants().filter((v) => v.heldOut);

  it('the hold-out file list is exactly the recorded one (no hold-out file added or removed)', () => {
    expect(held.map((v) => v.name).sort()).toEqual(Object.keys(recorded).sort());
    expect(held.every((v) => v.voicing7 === undefined)).toBe(true);
  });

  // skipped (reported as skipped, not passed) when no c2-h wav is on disk, e.g. a fresh checkout
  const onDisk = held.filter((v) => existsSync(`${OUT}${v.name}.wav`));
  it.skipIf(!onDisk.length)('every c2-h wav on disk (out/chords2) has its recorded hash (skipped: no c2-h wav in out/chords2)', () => {
    for (const v of onDisk) expect(sha(readFileSync(`${OUT}${v.name}.wav`)), v.name).toBe(recorded[v.name]);
  });

  // one hold-out file per set and seed, re-rendered now: the same bytes as spike 7 rendered
  it.skipIf(!pianoAvailable('P2'))('re-rendered hold-out files (one per set and seed) have the recorded hashes (skipped: piano sample P2 not available)', () => {
    const picked = ['b-human', 'v1-piano', 'v2-human', 'v3-lh15', 'pair-a1-human'].flatMap((t) => [8, 9].map((s) => `c2-h-${t}-s${s}`));
    for (const name of picked) {
      const v = held.find((x) => x.name === name)!;
      expect(sha(renderC2(v).wav), name).toBe(recorded[name]);
    }
  });

  it('synthSplit knows the new recipes: 7th voicings by their split, the dev L / LR set as dev, and no dev name is a tuning one', () => {
    for (const v of allC2Variants()) expect(synthSplit(v.name), v.name).toBe(v.split);
    const dev = allDevVariants();
    expect(dev.length).toBe(22);
    for (const v of dev) expect(synthSplit(v.name), v.name).toBe('dev');
    const old = new Set(allVariants().map((v) => v.name));
    expect(dev.every((v) => !old.has(v.name) && !v.heldOut)).toBe(true);
    expect(synthSplit('c2-x-unknown')).toBeNull();
  });
});
