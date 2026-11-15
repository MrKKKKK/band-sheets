import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resetTimbres, timbreAvailable, SAMPLE_RATE } from '../bass/timbres';
import { checkC2 } from './check';
import { getPiano, p2Keys, p2Layer, pianoAvailable, resetPianos } from './pianos';
import { renderC2 } from './render';
import { allC2Variants, type C2Variant } from './variants';

const byName = new Map(allC2Variants().map((v) => [v.name, v]));
const V = (name: string) => byName.get(name)!;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const ready = (v: C2Variant) => pianoAvailable(v.piano) && pianoAvailable('P1') && (v.bass === null || timbreAvailable(v.bass));
const cold = () => {
  resetTimbres();
  resetPianos();
};

// Golden wav hashes (same seed -> bit-identical wav; plan T5). They depend on the pinned sample files and alphaTab
// 1.8.4; regenerate only together with a CHORDS2_SYNTH_VERSION bump.
const GOLDEN: [string, string][] = [
  ['c2-t-pair-a2-clean-s1', 'b575d4226adb44dd'],
  ['c2-d-pair-b9-human-s5', '8a9ee4d8b4dad3c6'],
  ['c2-h-pair-a6b5-piano-s8', '737b0ad56dc56ca4'],
  ['c2-t-v3-peaky-s2', 'b1e735d5e1379a7b'],
];

describe('rendered synthetic chords2', { timeout: 600_000 }, () => {
  for (const [name, hash] of GOLDEN) {
    it.skipIf(!ready(V(name)))(`${name}: same wav from cold caches, golden hash, no clipping`, () => {
      cold();
      const a = renderC2(V(name));
      cold();
      const b = renderC2(V(name));
      expect(sha(a.wav)).toBe(sha(b.wav));
      expect(sha(a.wav)).toBe(hash);
      expect(a.clipped).toBe(0);
      if (V(name).variation === 'peaky') expect(a.crestDb).toBeGreaterThan(24); // normalisation stays below -22 dBFS
    });
  }

  for (const name of ['c2-t-b-human-s3', 'c2-d-v2-lh15-s4', 'c2-h-v3-peaky-s9', 'c2-h-pair-p1-human-s9']) {
    it.skipIf(!ready(V(name)))(`${name}: every onset within 1 ms of its truth, every segment plays its truth chord's pitch classes`, () => {
      const c = checkC2(V(name));
      expect(c.checked).toBeGreaterThan(30);
      expect(c.passed).toBe(c.checked);
      expect(c.maxAbsSec).toBeLessThanOrEqual(0.001);
      expect(c.pcsBad).toEqual([]);
      expect(c.pcsOk).toBe(c.segments);
    });
  }

  it.skipIf(!ready(V('c2-t-pair-a6b5-piano-s1')))('truth JSON: chords on the grid, original qualities, rows and pairs, split flags', () => {
    const r = renderC2(V('c2-t-pair-a6b5-piano-s1'));
    const t = r.truth;
    expect(t.key).toEqual({ tonic: 'A', mode: 'minor', confidence: 1 });
    expect(t.chords.map((c) => c.text)).toEqual(['Am', 'E7', 'Am', 'AmM7/G#', 'Am7/G', 'Am6/F#', 'Fmaj7', 'E7', 'Am']);
    expect(t.chords[5]).toMatchObject({ root: 'A', quality: 'm6', originalQuality: 'm6', bass: 'F#' });
    const segs = t.chords2.segments;
    expect(segs[4].rows).toEqual([{ id: 'A6', truth: 'Am7/G', candidate: 'C6', conflict: true }]);
    expect(segs[5].rows).toEqual([{ id: 'B5', truth: 'Am6/F#', candidate: 'F#m7b5', conflict: true }]);
    expect(segs[3].pair).toBeUndefined();
    expect(segs[4].pair).toEqual({ other: 'C6', stage: 'V1' });
    for (const [i, c] of t.chords.entries()) {
      expect([segs[i].start, segs[i].end]).toEqual([c.start, c.end]);
      expect(t.beats.some((b) => Math.abs(b.t - c.start) < 1e-6)).toBe(true);
    }
    expect(t.chords2.variant).toMatchObject({ split: 'tuning', heldOut: false, piano: 'P1', bass: null, stage: 'V1' });
    expect(t.bassNotes.length).toBeGreaterThan(0); // piano only: the left hand's lowest notes
    expect(t.chords2.cutNotes).toBe(0);
    expect(t.source.audioSec).toBeGreaterThan(t.source.durationSec);
  });
});

describe('held-out piano P2', { timeout: 300_000 }, () => {
  it.skipIf(!pianoAvailable('P2'))('mapping: 23 sampled keys every 4 semitones (108 at the top), 3 layers by velocity', () => {
    const keys = p2Keys();
    expect(keys).toHaveLength(23);
    expect(keys.slice(0, 3).map((k) => k.key)).toEqual([21, 25, 29]);
    expect(keys[keys.length - 1].key).toBe(108);
    expect([p2Layer(30), p2Layer(56), p2Layer(95), p2Layer(96), p2Layer(127)]).toEqual([1, 2, 2, 3, 3]);
  });

  // Periodic at the note's period (normalized autocorrelation > .8) and clearly less so a semitone off: catches a
  // wrong mapping or re-pitch direction.
  it.skipIf(!pianoAvailable('P2'))('re-pitched voices sound at their MIDI note', () => {
    const p = getPiano('P2');
    const corr = (x: Float32Array, from: number, lag: number) => {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let i = from; i < from + 8192; i++) {
        a += x[i] * x[i + lag];
        b += x[i] * x[i];
        c += x[i + lag] * x[i + lag];
      }
      return a / Math.sqrt(b * c);
    };
    for (const m of [40, 47, 55, 60, 66, 71, 76]) {
      const v = p.voice(m, 80);
      const P = SAMPLE_RATE / (440 * 2 ** ((m - 69) / 12));
      const at = (period: number) => corr(v.x, v.onset + 4410, Math.round(period));
      expect(at(P), `${m}`).toBeGreaterThan(0.8);
      expect(at(P * 2 ** (1 / 12)), `${m} +1`).toBeLessThan(at(P));
      expect(at(P * 2 ** (-1 / 12)), `${m} -1`).toBeLessThan(at(P));
    }
  });
});
