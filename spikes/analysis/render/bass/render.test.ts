import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { noteToPc } from '../../ts/bass/score';
import { checkBass } from './check';
import { renderBass } from './render';
import { resetTimbres, timbreAvailable, type TimbreId } from './timbres';
import { allBassVariants } from './variants';

const byName = new Map(allBassVariants().map((v) => [v.name, v]));
const V = (name: string) => byName.get(name)!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const ready = (t: TimbreId) => timbreAvailable(t) && timbreAvailable('A');

// Golden wav hashes (same seed -> bit-identical wav; plan section 4). They depend on the pinned sample files and
// alphaTab 1.8.4; regenerate only together with a BASS_SYNTH_VERSION bump.
const GOLDEN: [string, string][] = [
  ['syn-b0-walking-tA-s1', 'da7d3d21f60d8877'],
  ['syn-b1-whole-tA-s2', '4c65cb9afca70fcb'],
  ['syn-b2-sync16-tB-s4', 'abce102d21478f0e'],
  ['syn-b3-octave-tC-s6', '2789d9ad0f52c58d'],
];

describe('rendered synthetic bass', { timeout: 300_000 }, () => {
  for (const [name, hash] of GOLDEN) {
    it.skipIf(!ready(V(name).timbre))(`${name}: same wav from cold caches, golden hash`, () => {
      resetTimbres();
      const a = renderBass(V(name));
      resetTimbres();
      const b = renderBass(V(name));
      expect(sha(a.wav)).toBe(sha(b.wav));
      expect(sha(a.wav)).toBe(hash);
      expect(a.clipped).toBe(0);
    });
  }

  for (const name of ['syn-b0-octave-tA-s3', 'syn-b1-walking-tB-s5', 'syn-b2-rock8-tA-s4', 'syn-b3-sync16-tB-s4', 'syn-b3-twoBeat-tC-s7']) {
    it.skipIf(!ready(V(name).timbre))(`${name}: every bass onset within 1 ms of its truth, every chord head plays the written bass`, () => {
      const c = checkBass(V(name));
      expect(c.checked).toBeGreaterThan(30);
      expect(c.passed).toBe(c.checked);
      expect(c.maxAbsSec).toBeLessThanOrEqual(0.001);
      expect(c.headsOk).toBe(c.segments);
    });
  }

  it.skipIf(!ready('B'))('truth JSON: two truths per chord, bass notes, tracks per level, split flags', () => {
    for (const name of ['syn-b0-twoBeat-tB-s4', 'syn-b2-walking-tB-s5']) {
      const r = renderBass(V(name));
      const t = r.truth;
      const segs = t.bass.segments;
      expect(segs.length).toBe(t.chords!.length);
      for (const [i, s] of segs.entries()) {
        const c = t.chords![i];
        expect([s.start, s.end, s.written]).toEqual([c.start, c.end, c.bass ?? c.root]);
        expect(s.played % 12).toBe(noteToPc(s.written));
        expect(Math.abs(s.playedT - s.start)).toBeLessThanOrEqual(r.params.jitterSigmaSec * 2.5 + 1 / 44100); // placed on a whole sample
      }
      const starts = t.bassNotes.map((n) => n.start);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(t.bassNotes.every((n) => n.end > n.start)).toBe(true);
      expect(t.bass.cutNotes).toBe(0);
      expect(t.bass.variant).toMatchObject({ split: 'dev', heldOut: false, timbre: 'B' });
      expect(t.source.audioSec).toBeGreaterThan(t.source.durationSec);
      expect(t.beats!.length).toBe(64);
      if (t.bass.variant.level === 'B0') {
        expect([t.melody, t.drums, t.render!.tracks]).toEqual([undefined, undefined, ['Bass']]);
      } else {
        expect(t.render!.tracks).toEqual(['Drums', 'Piano', 'Melody', 'Bass']);
        expect(t.melody!.notes.length).toBeGreaterThan(0);
        expect(t.drums!.length).toBeGreaterThan(0);
        expect(t.render!.programs.Bass).toBe(33);
      }
    }
  });
});
