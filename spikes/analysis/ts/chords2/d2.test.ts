// Spike 8 T5: D2 (plan §2.2) on hand-made F1 notes and on hand-made additive tones through the real F1 (7-octave CQT).
// Generic synthetic fixtures only; nothing here reads synthetic material or recordings.
import { describe, expect, it } from 'vitest';
import type { ColumnChord } from '../dsp/chords';
import { lowCqt } from '../bass/lowCqt';
import { analyze, chordName, type Chords2Input } from './analyze';
import { appBassConfig, chords2ConfigHash, DEFAULT_CHORDS2_CONFIG, DEFAULT_D2_VALUES, resolveChords2Config, type D2Values } from './config';
import { applyD2, d2Candidates, evalAdded, smooth } from './d2';
import { DEFAULT_F1_CONFIG } from './front/config';
import { f1Beats, octaveCqt, type F1Beat, type F1Note } from './front/f1';
import { chords2Inputs } from './pipeline';

const F1 = DEFAULT_F1_CONFIG;
const V = (o: Partial<D2Values> = {}): D2Values => ({ ...DEFAULT_D2_VALUES, ...o });

describe('D2 step 4: ρ(d) and the reading, by hand (θ_low .3, θ .5)', () => {
  // C2 bass 4 (lowest: in the denominator only), E4 2, G4 0.5 (< θ_low x max 4 = 1.2: not sounding), Bb4 2.5, B4 1, A4 1.6
  // denominator = mean(4, 2) = 3 -> ρ(10) = 2.5 / 3, ρ(11) = 1 / 3, ρ(9) = 1.6 / 3
  const notes: F1Note[] = [
    { midi: 36, s: 4 },
    { midi: 64, s: 2 },
    { midi: 67, s: 0.5 },
    { midi: 70, s: 2.5 },
    { midi: 71, s: 1 },
    { midi: 69, s: 1.6 },
  ];
  it('E2: the stronger 7th (Bb), 6 and 7 both -> 7 with the 6th as a candidate; the weaker 7th is dropped', () => {
    const e = evalAdded(notes, 0, 'maj', V({ range: 'E2' }), F1);
    expect(e.rho[10]).toBeCloseTo(2.5 / 3, 12);
    expect(e.rho[11]).toBeCloseTo(1 / 3, 12);
    expect(e.rho[9]).toBeCloseTo(1.6 / 3, 12);
    expect(e.added).toBe('7');
    expect(e.evidence).toBeCloseTo(2.5 / 3 - 0.5, 12);
    expect(e.strong).toBe(true);
    expect(e.candIfAdded).toEqual(['6']);
    expect(e.candIfPlain).toEqual(['7', '6']);
  });
  it('E1: no 6th; maj7 at ρ 1/3 (>= θ_low) is not a candidate because the minor 7th is stronger', () => {
    const e = evalAdded(notes, 0, 'maj', V(), F1);
    expect(Object.keys(e.rho).map(Number).sort()).toEqual([10, 11]);
    expect(e.added).toBe('7');
    expect(e.candIfAdded).toEqual([]);
    expect(e.candIfPlain).toEqual(['7']);
  });
  it('6th >= θ and 7th between θ_low and θ: the 6th, the 7th as a candidate', () => {
    const n2: F1Note[] = [{ midi: 36, s: 4 }, { midi: 64, s: 2 }, { midi: 70, s: 1 }, { midi: 69, s: 2 }]; // ρ(10) 1/3, ρ(9) 2/3
    const e = evalAdded(n2, 0, 'maj', V({ range: 'E2' }), F1);
    expect(e.added).toBe('6');
    expect(e.evidence).toBeCloseTo(2 / 3 - 0.5, 12);
    expect(e.candIfAdded).toEqual(['7']);
  });
  it('min: E1 reads only min7; E2 adds m6 and mM7 (the stronger 7th); dim reads m7b5', () => {
    const am: F1Note[] = [{ midi: 45, s: 3 }, { midi: 60, s: 3 }, { midi: 64, s: 3 }, { midi: 68, s: 2.4 }]; // A2 | C4 E4 G#4: ρ(11) .8
    expect(evalAdded(am, 9, 'min', V(), F1).rho).toEqual({ 10: 0 });
    expect(evalAdded(am, 9, 'min', V({ range: 'E2' }), F1).added).toBe('mM7');
    const bdim: F1Note[] = [{ midi: 47, s: 3 }, { midi: 62, s: 3 }, { midi: 65, s: 3 }, { midi: 69, s: 2 }];
    expect(evalAdded(bdim, 11, 'dim', V({ range: 'E2' }), F1).added).toBe('m7b5');
  });
  it('no triad tone sounding: every ρ is 0, weak', () => {
    const e = evalAdded([], 0, 'maj', V(), F1);
    expect(e.rho).toEqual({ 10: 0, 11: 0 });
    expect(e.strong).toBe(false);
  });
});

describe('D2 step 5: the 2-state smoothing, one switch penalty', () => {
  it('penalty 0 = the threshold (ρ >= θ adds)', () => {
    expect(Array.from(smooth([-0.1, 0, 0.2, -0.3], 0))).toEqual([0, 1, 1, 0]);
  });
  it('a blip in the middle of a run needs more than two switches; one at the end, one', () => {
    expect(Array.from(smooth([-0.2, -0.2, 0.15, -0.2, -0.2], 0.1))).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(smooth([-0.2, -0.2, 0.25, -0.2, -0.2], 0.1))).toEqual([0, 0, 1, 0, 0]);
    expect(Array.from(smooth([-0.2, 0.08], 0.1))).toEqual([0, 0]);
    expect(Array.from(smooth([-0.2, 0.12], 0.1))).toEqual([0, 1]);
    expect(Array.from(smooth([0.3, -0.05, 0.3], 0.1))).toEqual([1, 1, 1]); // a short dip is bridged
    expect(smooth([], 0.1).length).toBe(0);
  });
});

const col = (root: number | null, quality: string): ColumnChord => ({ root, quality, confidence: 0.9, bass: null, posterior: null as unknown as Float64Array });
const beat = (notes: F1Note[]): F1Beat => ({ start: 0, end: 0, notes });
const C: F1Note[] = [{ midi: 48, s: 3 }, { midi: 60, s: 3 }, { midi: 64, s: 3 }, { midi: 67, s: 3 }];
const C7: F1Note[] = [...C, { midi: 70, s: 3 }];
const Cmaj7: F1Note[] = [...C, { midi: 71, s: 3 }];
const AM: F1Note[] = [{ midi: 45, s: 3 }, { midi: 57, s: 3 }, { midi: 60, s: 3 }, { midi: 64, s: 3 }];
const C7weak: F1Note[] = [...C, { midi: 70, s: 1.2 }]; // ρ .4: a candidate only

describe('applyD2 over V0 columns', () => {
  it('re-decides the added tone per column (V0 7 / maj7 -> triad first), passes aug / no-chord through, perBeat 2', () => {
    const cols = [col(0, 'maj'), col(0, 'maj'), col(0, '7'), col(0, 'maj7'), col(0, 'maj'), col(0, 'maj'), col(8, 'aug'), col(null, 'maj')];
    const out = applyD2(cols, [beat(C), beat(C7), beat(Cmaj7), beat(C7)], 2, V(), F1);
    expect(out.columns.map((c) => chordName(c.root, c.quality))).toEqual(['C', 'C', 'C7', 'C7', 'Cmaj7', 'Cmaj7', 'G#aug', 'N']);
    expect(out.columns[0].confidence).toBe(0.9);
  });
  it('a different root or triad starts a new run; a weak smoothed-on column names its neighbours\' added tone', () => {
    const out = applyD2([col(0, 'maj'), col(0, 'maj'), col(0, 'maj'), col(9, 'min')], [beat(C7), beat([]), beat(C7), beat(AM)], 1, V({ switchPenalty: 1 }), F1);
    expect(out.columns.map((c) => chordName(c.root, c.quality))).toEqual(['C7', 'C7', 'C7', 'Am']);
  });
  it('candidate only between θ_low and θ', () => {
    const out = applyD2([col(0, 'maj'), col(0, 'maj')], [beat(C7weak), beat(C7weak)], 1, V(), F1);
    expect(out.columns.map((c) => c.quality)).toEqual(['maj', 'maj']);
    expect(out.cands).toEqual([['7'], ['7']]);
  });
  it('F1 beats must match the columns', () => {
    expect(() => applyD2([col(0, 'maj')], [], 1, V(), F1)).toThrow(/F1 beats/);
  });
});

describe('d2Candidates: the segment\'s readings', () => {
  it('held by at least half of the columns, most first; the answer itself skipped', () => {
    expect(d2Candidates([['7'], ['7', '6'], ['6'], []], 0, 4, 0, 'maj', 'E2')).toEqual([{ root: 0, quality: '7' }, { root: 0, quality: '6' }]);
    expect(d2Candidates([['7'], [], [], []], 0, 4, 0, 'maj', 'E1')).toEqual([]);
    expect(d2Candidates([['7'], ['7']], 0, 2, 0, '7', 'E1')).toEqual([]);
  });
  it('E2: the identical pair\'s other reading always first (spike 7 decision 8); E1 has no pair', () => {
    expect(d2Candidates([[], []], 0, 2, 9, 'm6', 'E2')).toEqual([{ root: 6, quality: 'm7b5' }]);
    expect(d2Candidates([['m6'], ['m6']], 0, 2, 9, 'min7', 'E2')).toEqual([{ root: 0, quality: '6' }, { root: 9, quality: 'm6' }]);
    expect(d2Candidates([[], []], 0, 2, 9, 'min7', 'E1')).toEqual([]);
  });
});

/* ------------------------------------------------------------ synthetic audio through the real F1 (done conditions) */

const SR = 22050;
const TIMBRES = {
  plain: [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12, 0.11, 0.1],
  strong23: [0.6, 1, 0.8, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1, 0.08], // 2nd / 3rd partials above the fundamental
};
const BEAT = 0.5;
/** One chord per beat (MIDI lists), each struck on its beat (10 ms attack and release), peak 0.3. */
function struck(chords: readonly (readonly number[])[], amps: readonly number[]): Float32Array {
  const m = Math.round(BEAT * SR);
  const y = new Float32Array(m * chords.length);
  chords.forEach((midis, c) => {
    for (const midi of midis) {
      const f0 = 440 * 2 ** ((midi - 69) / 12);
      amps.forEach((a, i) => {
        const f = f0 * (i + 1);
        if (f >= SR / 2 - 200) return;
        const w = (2 * Math.PI * f) / SR;
        const ph = (i * 1.7 + midi) % (2 * Math.PI);
        for (let k = 0; k < m; k++) y[c * m + k] += a * Math.min(1, k / (0.01 * SR), (m - k) / (0.01 * SR)) * Math.exp(-k / (3 * SR)) * Math.sin(w * k + ph);
      });
    }
  });
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let k = 0; k < y.length; k++) y[k] *= 0.3 / peak;
  return y;
}
/** chords2 input of `nb` beats at perBeat 2 whose (hand-made) chroma is one triad: V0 reads that triad on every column. */
function triadInput(nb: number, pcs: readonly number[], f1: F1Beat[]): Chords2Input {
  const n = nb * 2;
  const chroma = new Float64Array(12 * n);
  for (const p of pcs) for (let t = 0; t < n; t++) chroma[p * n + t] = 1;
  return { chroma, n, perBeat: 2, barKeys: [], barOfBeat: Array.from({ length: nb }, (_, i) => Math.floor(i / 4)), f1Beats: f1 };
}
const runD2 = (chords: number[][], pcs: number[], amps: readonly number[], d2: Partial<D2Values>) => {
  const y = struck(chords, amps);
  const fb = f1Beats(octaveCqt(y, F1, { tuning: 0 }), chords.map((_, i) => i * BEAT), chords.length * BEAT);
  return analyze(triadInput(chords.length, pcs, fb), resolveChords2Config({ d2 }));
};
const names = (o: ReturnType<typeof analyze>) => o.segments.map((s) => chordName(s.root, s.quality));

describe('D2 on synthetic tones (plan §7 T5 done conditions)', () => {
  const c = [48, 60, 64, 67]; // C3 | C4 E4 G4
  for (const [tname, amps] of Object.entries(TIMBRES)) {
    it(`C – C7 (2 beats each) are two segments, ${tname}`, () => {
      const o = runD2([c, c, [...c, 70], [...c, 70]], [0, 4, 7], amps, {});
      expect(names(o)).toEqual(['C', 'C7']);
      expect(o.segments.map((s) => [s.startBeat, s.endBeat])).toEqual([[0, 4], [4, 8]]);
    });
    it(`the inner-voice cliché Am – AmM7 – Am7 – Am6 (2 beats each, E2) is four segments, ${tname}`, () => {
      // A2 | A3 -> G#3 -> G3 -> F#3 under C4 E4
      const line = [57, 56, 55, 54].flatMap((m) => [[45, m, 60, 64], [45, m, 60, 64]]);
      const o = runD2(line, [9, 0, 4], amps, { range: 'E2' });
      expect(names(o)).toEqual(['Am', 'AmM7', 'Am7', 'Am6']);
      // Am6 = F#m7b5: the other reading of the identical pair comes first (spike 7 decision 8)
      expect(o.segments[3].chordCandidates?.[0]).toEqual({ root: 6, quality: 'm7b5' });
      expect(o.segments[2].chordCandidates?.[0]).toEqual({ root: 0, quality: '6' }); // Am7 = C6
    });
  }
  it('E1 cannot name the cliché\'s mM7 / m6: they stay Am (the 7th range only)', () => {
    const line = [57, 56, 55, 54].flatMap((m) => [[45, m, 60, 64], [45, m, 60, 64]]);
    expect(names(runD2(line, [9, 0, 4], TIMBRES.plain, {}))).toEqual(['Am', 'Am7', 'Am']);
  });
});

describe('D2 config and hashes', () => {
  it('off by default; all-off and app-bass hashes unchanged; on adds d2 and the F1 values (pinned)', () => {
    expect(DEFAULT_CHORDS2_CONFIG.d2).toBeUndefined();
    expect(DEFAULT_CHORDS2_CONFIG.f1).toBeUndefined();
    expect(chords2ConfigHash()).toBe('607593f71c46');
    expect(chords2ConfigHash(resolveChords2Config({ d2: false }))).toBe('607593f71c46');
    const on = resolveChords2Config({ d2: true });
    expect(on.d2).toEqual(DEFAULT_D2_VALUES);
    expect(on.f1).toEqual(DEFAULT_F1_CONFIG);
    expect(chords2ConfigHash(on)).toBe(D2_ON_PIN);
    expect(chords2ConfigHash(resolveChords2Config({ d2: {} }))).toBe(D2_ON_PIN);
    expect(chords2ConfigHash(resolveChords2Config({ d2: { range: 'E2' } }))).not.toBe(D2_ON_PIN);
    expect(resolveChords2Config({ octaveChroma: true }).f1).toEqual(DEFAULT_F1_CONFIG);
    expect(resolveChords2Config({ d2: true, f1: { stopRatio: 0.1 } }).f1?.stopRatio).toBe(0.1);
  });
  it('refuses bad values, D2 off a V0 stage, and F1 values without D1 / D2', () => {
    expect(() => resolveChords2Config({ d2: { theta: 0.2 } })).toThrow(/thetaLow <= theta/);
    expect(() => resolveChords2Config({ d2: { range: 'E3' } })).toThrow(/range/);
    expect(() => resolveChords2Config({ d2: { nope: 1 } })).toThrow(/unknown chords2 config key: d2.nope/);
    expect(() => resolveChords2Config({ d2: true, stage: 'V1' })).toThrow(/stage must be V0/);
    expect(() => resolveChords2Config({ f1: { stopRatio: 0.1 } })).toThrow(/need octaveChroma or d2/);
    expect(() => analyze({ chroma: new Float64Array(12), n: 1, perBeat: 1, barKeys: [], barOfBeat: [0] }, resolveChords2Config({ d2: true }))).toThrow(/f1Beats/);
  });
});

describe('chords2Inputs: one 7-octave CQT for F1 and the bass stage (decision 10)', () => {
  const y = struck([[45, 57, 60, 64], [45, 57, 60, 64], [45, 55, 60, 64], [45, 55, 60, 64]], TIMBRES.plain);
  const times = [0, 0.5, 1, 1.5];
  const base = triadInput(4, [9, 0, 4], []);
  const { f1Beats: _, ...input } = base;
  const bass = appBassConfig().lowCqt;
  it('without F1: the bass stage\'s own CQT, the input untouched', () => {
    const r = chords2Inputs(y, times, 2, input, DEFAULT_CHORDS2_CONFIG, bass);
    expect(r.input).toBe(input);
    expect(Array.from(r.low.semi)).toEqual(Array.from(lowCqt(y, bass).semi));
  });
  it('D2: f1Beats per beat, no f1Chroma; D1 + D2: f1Chroma too; the bass CQT is the lower 5 octaves of the same CQT', () => {
    const r = chords2Inputs(y, times, 2, input, resolveChords2Config({ d2: true }), bass);
    expect(r.input.f1Beats).toHaveLength(4);
    expect(r.input.f1Chroma).toBeUndefined();
    expect(r.low.nSemis).toBe(60);
    const own = lowCqt(y, bass);
    expect(r.low.cols).toBe(own.cols);
    const both = chords2Inputs(y, times, 2, input, resolveChords2Config({ d2: true, octaveChroma: true }), bass);
    expect(both.input.f1Chroma).toHaveLength(12 * 8);
    expect(names(analyze(both.input, resolveChords2Config({ d2: true, octaveChroma: true })))).toEqual(['Am', 'Am7']);
  });
});

/** chords2ConfigHash of resolveChords2Config({ d2: true }) (DEFAULT_D2_VALUES + DEFAULT_F1_CONFIG): moves with any D2 / F1 value. */
const D2_ON_PIN = '944e04c507d1';
