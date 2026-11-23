// Spike 8 T4: the F1 front end on hand-made additive tones (plan §2.1 「寄せ残しが足す音に化ける形」, §7 T4). Every case
// goes through the real 7-octave CQT; nothing here reads synthetic material or recordings.
import { describe, expect, it } from 'vitest';
import { DEFAULT_F1_CONFIG, f1ConfigHash, resolveF1Config } from './config';
import { bassCqtFrom, bassView, f1Beats, harmonicOffsets, lowestNote, octaveCqt, pcStrength, strengthRow, type F1Note } from './f1';
import { addedRatio } from './ratio';
import { lowCqt } from '../../bass/lowCqt';
import { appBassConfig } from '../config';

/** θ_low pinned to the 0.3 T4 measured with, NOT read from DEFAULT_D2_VALUES: tuning θ_low (T7) must not move these done-condition lines. */
const THETA_LOW = 0.3;

const SR = 22050;
/** 1/h roll-off (a plain string-like tone). */
const PLAIN = [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12, 0.11, 0.1];
/** 2nd and 3rd harmonics stronger than the fundamental (plan §7 T4: the timbre that tempts octave / fifth errors). */
const STRONG23 = [0.6, 1, 0.8, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1, 0.08];
const TIMBRES = { PLAIN, STRONG23 } as const;

/** Sum of harmonic tones (MIDI, partial amplitudes; 10 ms attack, slow decay), 2 s, peak about 0.3. */
function tones(notes: readonly { midi: number; amps: readonly number[]; gain?: number }[], sec = 2): Float32Array {
  const n = Math.round(sec * SR);
  const y = new Float32Array(n);
  for (const { midi, amps, gain = 1 } of notes) {
    const f0 = 440 * 2 ** ((midi - 69) / 12);
    amps.forEach((a, i) => {
      const f = f0 * (i + 1);
      if (f >= SR / 2 - 200) return;
      const w = (2 * Math.PI * f) / SR;
      const ph = (i * 1.7 + midi) % (2 * Math.PI);
      for (let k = 0; k < n; k++) y[k] += gain * a * Math.min(1, k / (0.01 * SR)) * Math.exp(-k / (3 * SR)) * Math.sin(w * k + ph);
    });
  }
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let k = 0; k < n; k++) y[k] *= 0.3 / peak;
  return y;
}

/** F1 notes of the one beat [0.25, 1.75) s. */
function notesOf(y: Float32Array): F1Note[] {
  const low = octaveCqt(y, DEFAULT_F1_CONFIG, { tuning: 0 });
  return f1Beats(low, [0.25], 1.75)[0].notes;
}

const C_MAJ = [0, 4, 7];
/** Fake added tones of plan §2.1 on a C chord: 6th A (1/3 phantom), m7 Bb (7th partial), M7 B (3rd's 3rd partial), 9th D (5th's 3rd partial). */
const FAKES = { A: 9, Bb: 10, B: 11, D: 2 } as const;
const rho = (notes: F1Note[], d: number) => addedRatio(notes, 0, C_MAJ, d, THETA_LOW);

/** The voicings of plan §7 T4 (MIDI): C/E, left hand 1-5-8, octaves, C close, C open. */
const VOICINGS: Record<string, number[]> = {
  'C/E': [40, 60, 64, 67], // E2 bass, C4 E4 G4
  'left hand 1-5-8': [36, 43, 48, 64, 67, 72], // C2 G2 C3 | E4 G4 C5
  octaves: [36, 48, 60, 64, 67], // C2 C3 C4 | E4 G4
  'C close': [48, 60, 64, 67], // C3 | C4 E4 G4
  'C open': [36, 55, 64, 72], // C2 G3 E4 C5
};

describe('F1: fake added tones stay below θ_low (plan §2.1, §7 T4)', () => {
  for (const [tname, amps] of Object.entries(TIMBRES)) {
    for (const [vname, midis] of Object.entries(VOICINGS)) {
      it(`${vname}, ${tname}`, () => {
        const notes = notesOf(tones(midis.map((midi) => ({ midi, amps }))));
        for (const [fake, d] of Object.entries(FAKES)) expect(rho(notes, d), `${fake} ρ`).toBeLessThan(THETA_LOW);
        // the chord itself is there: every triad tone sounds (ρ of the 3rd and 5th well above θ_low)
        for (const d of [4, 7]) expect(rho(notes, d), `triad ${d}`).toBeGreaterThan(THETA_LOW);
      });
    }
  }

  it('a real C7 / Cmaj7 / C6 added tone passes θ_low (same voicing, the 4th note added)', () => {
    for (const amps of Object.values(TIMBRES)) {
      for (const d of [9, 10, 11]) {
        const notes = notesOf(tones([48, 60, 64, 67, 60 + d].map((midi) => ({ midi, amps }))));
        expect(rho(notes, d), `d ${d}`).toBeGreaterThanOrEqual(THETA_LOW);
      }
    }
  });
});

describe('F1: single notes (plan §7 T4)', () => {
  for (const [tname, amps] of Object.entries(TIMBRES)) {
    it(`bass A1 alone gives no G (its 7th partial), ${tname}`, () => {
      const notes = notesOf(tones([{ midi: 33, amps }]));
      expect(notes.map((n) => n.midi % 12)).not.toContain(7);
      expect(lowestNote(notes)?.midi).toBe(33);
    });
    it(`E3 alone gives no A1 / A2 (the 1/3 phantom), ${tname}`, () => {
      const notes = notesOf(tones([{ midi: 52, amps }]));
      expect(notes.map((n) => n.midi)).not.toContain(33);
      expect(notes.map((n) => n.midi)).not.toContain(45);
      expect(notes[0].midi).toBe(52);
    });
  }
});

describe('F1 helpers', () => {
  it('harmonic offsets are round(12 log2 h)', () => {
    expect(harmonicOffsets(8)).toEqual([0, 12, 19, 24, 28, 31, 34, 36]);
  });

  it('pcStrength: max over octaves; the lowest note only in the denominator view; below C2 not a pitch output', () => {
    const notes: F1Note[] = [
      { midi: 28, s: 5 }, // E1: the bass (lowest), below the output range
      { midi: 48, s: 1 },
      { midi: 60, s: 2 },
      { midi: 64, s: 1.5 },
    ];
    const num = pcStrength(notes, true);
    const den = pcStrength(notes, false);
    expect(num[0]).toBe(2);
    expect(num[4]).toBe(1.5);
    expect(den[4]).toBe(5);
    const row = strengthRow(notes);
    expect(row.length).toBe(48);
    expect(row[60 - 36]).toBe(2);
  });

  it('addedRatio = s(root + d) / mean of the sounding triad tones (θ_low x max)', () => {
    const notes: F1Note[] = [
      { midi: 36, s: 4 }, // C2 bass
      { midi: 64, s: 2 }, // E4
      { midi: 67, s: 0.5 }, // G4: below θ_low x 4 = 1.2, not in the denominator
      { midi: 70, s: 1.5 }, // Bb4
    ];
    expect(addedRatio(notes, 0, C_MAJ, 10, 0.3)).toBeCloseTo(1.5 / 3, 10);
    expect(addedRatio([], 0, C_MAJ, 10, 0.3)).toBe(0);
  });

  it('config hash is pinned (a value change must update docs/audio-spike8-t4.md)', () => {
    expect(f1ConfigHash()).toBe('cbf11a42c101');
    expect(f1ConfigHash(resolveF1Config({}))).toBe('cbf11a42c101');
    expect(() => resolveF1Config({ nope: 1 } as never)).toThrow(/unknown/);
  });
});

describe('bassView: the lower 5 octaves of the 7-octave CQT', () => {
  it('has the bass layout and values close to the bass stage own CQT (equality of the bass OUTPUT is checked by cli.ts share)', () => {
    const y = tones([{ midi: 33, amps: STRONG23 }, ...[57, 60, 64].map((midi) => ({ midi, amps: PLAIN }))]);
    const b = appBassConfig().lowCqt;
    const own = lowCqt(y, b, { tuning: 0 });
    const view = bassView(octaveCqt(y, DEFAULT_F1_CONFIG, { tuning: 0 }), b);
    expect(view.nSemis).toBe(own.nSemis);
    expect(view.cols).toBe(own.cols);
    let peak = 0;
    let diff = 0;
    for (let i = 0; i < own.semi.length; i++) {
      peak = Math.max(peak, own.semi[i]);
      diff = Math.max(diff, Math.abs(own.semi[i] - view.semi[i]));
    }
    expect(diff / peak).toBeLessThan(1e-4);
    expect(bassCqtFrom(y, octaveCqt(y, DEFAULT_F1_CONFIG, { tuning: 0 }), b).nSemis).toBe(60);
  });

  it('bassCqtFrom computes its own CQT where the 7-octave plan has one column fewer (about 0.6 % of lengths)', () => {
    const b = appBassConfig().lowCqt;
    const y = tones([{ midi: 45, amps: PLAIN }], 100349 / SR); // 197 columns at 5 octaves, 196 at 7
    const wide = octaveCqt(y, DEFAULT_F1_CONFIG, { tuning: 0 });
    expect(wide.cols).toBe(196);
    const got = bassCqtFrom(y, wide, b);
    expect(got.cols).toBe(197);
    expect(Array.from(got.semi)).toEqual(Array.from(lowCqt(y, b, { tuning: 0 }).semi));
  });
});
