import { beforeEach, describe, expect, it } from 'vitest';
import { stubNoNetwork } from '../parity/noNetwork';
import { DEFAULT_BASS_CONFIG, resolveBassConfig } from './config';
import { LOW_SR, lowCqt, type LowCqt } from './lowCqt';
import { candidateCount, salience, segmentBass, type SegmentSpan } from './segmentBass';

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const db = (d: number) => 10 ** (d / 20);

/** One note: partials [harmonic number, linear amplitude], exponential decay, 5 ms attack. */
interface Note {
  midi: number;
  start: number;
  dur: number;
  partials: [number, number][];
}
function render(notes: Note[], sec: number): Float32Array {
  const y = new Float32Array(Math.round(sec * LOW_SR));
  for (const n of notes) {
    const f0 = hz(n.midi);
    const i0 = Math.round(n.start * LOW_SR);
    const len = Math.round(n.dur * LOW_SR);
    for (let i = 0; i < len && i0 + i < y.length; i++) {
      const t = i / LOW_SR;
      const env = Math.min(1, t / 0.005) * Math.exp(-t / 1.5) * Math.min(1, (len - i) / (0.01 * LOW_SR));
      let s = 0;
      for (const [h, a] of n.partials) s += a * Math.sin(2 * Math.PI * f0 * h * t);
      y[i0 + i] += 0.1 * env * s;
    }
  }
  return y;
}
/** Bass-like spectrum: 1/h amplitudes for h = 1..6. */
const bassPartials = (): [number, number][] => [1, 2, 3, 4, 5, 6].map((h) => [h, 1 / h]);
/** Piano-ish: 8 partials, 1/h. */
const pianoPartials = (): [number, number][] => [1, 2, 3, 4, 5, 6, 7, 8].map((h) => [h, 0.8 / h]);

const BEAT = 0.5;
const beats = (n: number, t0 = 0.5) => Array.from({ length: n }, (_, i) => t0 + i * BEAT);
const SEG: SegmentSpan = { start: 0.5, end: 2.5 }; // one 4-beat segment
const cfg = DEFAULT_BASS_CONFIG;
const low = (y: Float32Array): LowCqt => lowCqt(y, cfg.lowCqt, { tuning: 0 });
const one = (y: Float32Array) => segmentBass(low(y), [SEG], beats(5), cfg.segment)[0];

describe('segmentBass (B-1)', () => {
  beforeEach(() => stubNoNetwork());

  it('candidates span C1-B3 with the default 5 octaves and 4 harmonics', () => {
    const l = low(new Float32Array(LOW_SR * 2));
    expect(l.midi0).toBe(24);
    expect(candidateCount(l, cfg.segment.harmonics)).toBe(36);
  });

  it('a plain bass note: right pitch class and octave, high confidence', () => {
    const r = one(render([{ midi: 33, start: 0.5, dur: 2, partials: bassPartials() }], 3)); // A1
    expect(r.pc).toBe(9);
    expect(r.midi).toBe(33);
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it('octave trap: 2nd harmonic 18 dB above the fundamental -> still E1, not E2', () => {
    const p: [number, number][] = [
      [1, 1],
      [2, db(18)],
      [3, 0.5 * db(18)],
      [4, 0.3 * db(18)],
    ];
    const r = one(render([{ midi: 28, start: 0.5, dur: 2, partials: p }], 3));
    expect(r.pc).toBe(4);
    expect(r.midi).toBe(28);
  });

  it('fifth trap: 3rd harmonic 12 dB above the fundamental -> C2, not G', () => {
    const p: [number, number][] = [
      [1, 1],
      [2, db(6)],
      [3, db(12)],
      [4, 0.5],
    ];
    const r = one(render([{ midi: 36, start: 0.5, dur: 2, partials: p }], 3));
    expect(r.pc).toBe(0);
    expect(r.midi).toBe(36);
  });

  it('missing fundamental (phone low cut): harmonics 2-5 only -> A1', () => {
    const p: [number, number][] = [2, 3, 4, 5].map((h) => [h, 1 / h]);
    const r = one(render([{ midi: 33, start: 0.5, dur: 2, partials: p }], 3));
    expect(r.pc).toBe(9);
    expect(r.midi).toBe(33);
  });

  it('left hand 1-5-8 arpeggio (C2 G2 C3 G2): the root C, not the fifth', () => {
    const notes = [36, 43, 48, 43].map((midi, i) => ({ midi, start: 0.5 + i * BEAT, dur: BEAT, partials: pianoPartials() }));
    expect(one(render(notes, 3)).pc).toBe(0);
  });

  it('piano left hand on the root (C2 + C major triad) while the bass plays /E (E1): E', () => {
    const notes: Note[] = [
      { midi: 28, start: 0.5, dur: 2, partials: bassPartials() },
      { midi: 36, start: 0.5, dur: 2, partials: pianoPartials().map(([h, a]) => [h, 0.6 * a] as [number, number]) },
      ...[60, 64, 67].map((midi) => ({ midi, start: 0.5, dur: 2, partials: pianoPartials().map(([h, a]) => [h, 0.5 * a] as [number, number]) })),
    ];
    const r = one(render(notes, 3));
    expect(r.pc).toBe(4);
    expect(r.second.pc).toBe(0); // the piano's root is the runner-up
  });

  it('walking bass: the head-beat note wins over passing notes (C E F F# -> C)', () => {
    const notes = [36, 40, 41, 42].map((midi, i) => ({ midi, start: 0.5 + i * BEAT, dur: BEAT, partials: bassPartials() }));
    expect(one(render(notes, 3)).pc).toBe(0);
  });

  it('several segments in one call; silence -> confidence 0', () => {
    const y = render(
      [
        { midi: 31, start: 0.5, dur: 1, partials: bassPartials() },
        { midi: 35, start: 1.5, dur: 1, partials: bassPartials() },
      ],
      3,
    );
    const r = segmentBass(low(y), [{ start: 0.5, end: 1.5 }, { start: 1.5, end: 2.5 }], beats(5), cfg.segment);
    expect(r.map((x) => x.pc)).toEqual([7, 11]);
    expect(one(new Float32Array(LOW_SR * 3)).confidence).toBe(0);
  });

  it('T12: salience is computed once per spectrogram and harmonic count; one call per segment = one call for all', () => {
    const y = render(
      [
        { midi: 31, start: 0.5, dur: 1, partials: bassPartials() },
        { midi: 35, start: 1.5, dur: 1, partials: bassPartials() },
      ],
      3,
    );
    const l = low(y);
    const s4 = salience(l, 4);
    expect(salience(l, 4)).toBe(s4);
    expect(salience(l, 2)).not.toBe(s4);
    expect(salience(low(y), 4)).not.toBe(s4);
    expect(Array.from(salience(low(y), 4).sal)).toEqual(Array.from(s4.sal));
    const segs = [{ start: 0.5, end: 1.5 }, { start: 1.5, end: 2.5 }];
    expect(segs.map((s) => segmentBass(l, [s], beats(5), cfg.segment)[0])).toEqual(segmentBass(low(y), segs, beats(5), cfg.segment));
  });

  it('lowCqt rejects a bins-per-octave that is not a multiple of 12; too few octaves for the harmonics throw', () => {
    expect(() => lowCqt(new Float32Array(LOW_SR), { ...cfg.lowCqt, binsPerOctave: 30 }, { tuning: 0 })).toThrow(/multiple of 12/);
    const l = lowCqt(new Float32Array(LOW_SR * 2), { ...cfg.lowCqt, octaves: 2 }, { tuning: 0 });
    expect(() => segmentBass(l, [SEG], beats(5), resolveBassConfig({ segment: { harmonics: 4 } }).segment)).toThrow(/too few octaves/);
    expect(() => segmentBass(low(new Float32Array(LOW_SR * 2)), [SEG], beats(5), { ...cfg.segment, method: 4 })).toThrow(/removed in T5/);
  });
});
