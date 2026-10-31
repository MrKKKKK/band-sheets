import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDrums } from '../../../../src/lib/drumParse';
import { checkOnsets } from './check';
import { kitAvailable, resetKits, type KitId } from './kits';
import { timeSig } from './notation';
import { renderDrum } from './render';
import { allDrumVariants } from './variants';

const byName = new Map(allDrumVariants().map((v) => [v.name, v]));
const V = (name: string) => byName.get(name)!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

// Golden wav hashes (same seed -> bit-identical wav; plan section 4). They depend on the pinned sample files and
// alphaTab 1.8.4; regenerate only together with a DRUM_SYNTH_VERSION bump.
const GOLDEN: [string, KitId, string][] = [
  ['syn-d1-shuffle8-kA-s1', 'A', '1bd3ecfd24d33ff8'],
  ['syn-d2-funk-kB-s4', 'B', '01ba152d0129641d'],
  ['syn-d3-six8-kC-s6', 'C', 'f702f44d5187cfa0'],
];

describe('rendered synthetic drums', { timeout: 300_000 }, () => {
  for (const [name, kit, hash] of GOLDEN) {
    it.skipIf(!kitAvailable(kit) || !kitAvailable('A'))(`${name}: same wav from cold caches, golden hash`, () => {
      resetKits();
      const a = renderDrum(V(name));
      resetKits();
      const b = renderDrum(V(name));
      expect(sha(a.wav)).toBe(sha(b.wav));
      expect(sha(a.wav)).toBe(hash);
      expect(a.clipped).toBe(0);
    });
  }

  for (const name of ['syn-d0-rock8-kA-s2', 'syn-d2-ballad-kB-s5', 'syn-d3-funk-kC-s7', 'syn-d1-ext-kB-s4', 'syn-d2-funk-kD-s11', 'syn-d3-rock8-kH-s12', 'syn-r1-funk-kA-s31', 'syn-r1-half-kD-s32', 'syn-r1-shuffle8-kH-s33']) {
    const kit = V(name).kit;
    it.skipIf(!kitAvailable(kit) || !kitAvailable('A'))(`${name}: every truth onset within 1 ms of the rendered sound`, () => {
      const c = checkOnsets(V(name));
      expect(c.checked).toBeGreaterThan(50);
      expect(c.passed).toBe(c.checked);
      expect(c.maxAbsSec).toBeLessThanOrEqual(0.001);
    });
  }

  it.skipIf(!kitAvailable('B'))('truth JSON: score parses back, hits match the truth, bars and times consistent', () => {
    const r = renderDrum(V('syn-d2-shuffle16-kB-s5'));
    const d = r.truth.drum;
    const p = parseDrums(d.score.tex, timeSig(d.score.ts));
    expect(p.ok && p.events).toEqual(d.score.events);
    expect(p.ok && p.shuffle).toBe('16');
    expect(d.truth.hits.length).toBe(r.truth.drums.length);
    expect(d.truth.barStartsSec.length).toBe(d.score.nBars + 1);
    expect(r.truth.swing).toEqual({ kind: '16', confidence: 1 });
    const ts = r.truth.drums.map((h) => h.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]).toBeGreaterThan(d.info.startSec - 0.06);
    expect(r.truth.source.audioSec).toBeGreaterThan(d.truth.barStartsSec.at(-1)!);
    expect(d.variant).toMatchObject({ heldOut: false, split: 'dev', kit: 'B', level: 'D2' });
  });

  it.skipIf(!kitAvailable('D'))('T12b R1: truth score parses back, tuning split, level R1, no clipping', () => {
    const r = renderDrum(V('syn-r1-rock8-kD-s31'));
    const d = r.truth.drum;
    const p = parseDrums(d.score.tex, timeSig(d.score.ts));
    expect(p.ok && p.events).toEqual(d.score.events);
    expect(d.variant).toMatchObject({ heldOut: false, split: 'tuning', kit: 'D', level: 'R1' });
    expect(r.clipped).toBe(0);
  });

  it.skipIf(!kitAvailable('D'))('kit D (T10b): truth score parses back, tuning split', () => {
    const r = renderDrum(V('syn-d1-ext-kD-s13'));
    const d = r.truth.drum;
    const p = parseDrums(d.score.tex, timeSig(d.score.ts));
    expect(p.ok && p.events).toEqual(d.score.events);
    expect(d.variant).toMatchObject({ heldOut: false, split: 'tuning', kit: 'D' });
    expect(r.clipped).toBe(0);
  });
});
