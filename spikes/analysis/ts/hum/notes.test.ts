import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG, resolveHumConfig } from './config';
import {
  estimateTuning,
  extractNotes,
  fixOctaveGlitches,
  hasPlateau,
  mergeFragments,
  frameLevelDb,
  joinDropouts,
  medianSmooth,
  notePitch,
  semitoneProbs,
  sixteenthSec,
  vibratoAround,
  voicedRuns,
} from './notes';
import type { FrameF0Track, HumInfo } from './types';

const HOP = 256 / 22050;
const INFO: HumInfo = { bpm: 100, ts: [4, 4], startSec: 0 };
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A hand-made track: pitch(t) in MIDI (NaN = unvoiced) and level(t) in dB, sampled on the analyzer grid. */
function makeTrack(sec: number, pitch: (t: number) => number, level: (t: number) => number = () => -12): { track: FrameF0Track; levelDb: number[] } {
  const n = Math.round(sec / HOP) + 1;
  const hz: number[] = [];
  const voiced: number[] = [];
  const levelDb: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * HOP;
    const p = pitch(t);
    const v = Number.isFinite(p);
    hz.push(v ? midiHz(p) : 0);
    voiced.push(v ? 1 : 0);
    levelDb.push(v ? level(t) : -100);
  }
  return { track: { t0: 0, hopSec: HOP, hz, voiced }, levelDb };
}

const rc = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
/** Notes [start, end, midi] sung legato-free (silence between) with an optional glide/scoop shape. */
function notesPitch(notes: [number, number, number][]): (t: number) => number {
  return (t) => {
    const n = notes.find(([a, b]) => t >= a && t < b);
    return n ? n[2] : NaN;
  };
}
const dip = (centre: number, depthDb: number, width = 0.05) => (t: number) => {
  const x = (t - centre) / (width / 2);
  return Math.abs(x) < 1 ? -depthDb * 0.5 * (1 + Math.cos(Math.PI * x)) : 0;
};

describe('helpers', () => {
  it('sixteenthSec follows the beat of ts[1]', () => {
    expect(sixteenthSec({ bpm: 120, ts: [4, 4] })).toBeCloseTo(0.125, 9);
    // bpm counts the beat of ts[1] (quantize.ts beatGrid): 120 eighths per minute -> a 16th is 0.25 s
    expect(sixteenthSec({ bpm: 120, ts: [6, 8] })).toBeCloseTo(0.25, 9);
  });
  it('voicedRuns and medianSmooth stay inside runs', () => {
    const { track } = makeTrack(0.5, notesPitch([[0.05, 0.2, 60], [0.3, 0.45, 62]]));
    const runs = voicedRuns(track);
    expect(runs.length).toBe(2);
    const x = Float64Array.from([1, 9, 1, 1, 1]);
    const out = new Float64Array(5);
    medianSmooth(x, 0, 5, 3, out);
    expect([...out]).toEqual([1, 1, 1, 1, 1]);
  });
  it('fixOctaveGlitches moves isolated +-12 frames only', () => {
    const p = Float64Array.from([60, 60, 60, 72, 72, 60, 60, 60, 60, 48, 60, 60, 61]);
    expect(fixOctaveGlitches(p, 0, p.length)).toBe(3);
    expect([...p]).toEqual([60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 61]);
  });
  it('estimateTuning finds the offset, also near +-50 cents', () => {
    expect(estimateTuning([60.3, 62.31, 64.29, 65.3])).toBeCloseTo(30, 0);
    // -45..+45 around 48 cents: wraps without flipping notes to the next semitone
    const t = estimateTuning([60.45, 62.52, 64.48, 65.51, 67.47]);
    expect(Math.abs(Math.abs(t) - 49)).toBeLessThan(3);
    expect(estimateTuning([])).toBe(0);
  });
  it('semitoneProbs: centred pitch is certain, a boundary pitch is split', () => {
    const c = semitoneProbs(60.02, 20);
    expect(c[0].midi).toBe(60);
    expect(c[0].p).toBeGreaterThan(0.99);
    const b = semitoneProbs(60.49, 20);
    expect(b[0].midi).toBe(60);
    expect(b[1].midi).toBe(61);
    expect(b[0].p - b[1].p).toBeLessThan(0.2);
  });
  it('notePitch trims the ends and ignores unstable frames', () => {
    const p = [58, 59, 60, 60, 60, 60, 60, 60, 61, 70];
    const stable = p.map((_, i) => i !== 9);
    expect(notePitch(p, stable, 0, p.length, 0.25).pitch).toBe(60);
  });
  it('vibratoAround sees an oscillation after the dip, not a step', () => {
    const vib = Array.from({ length: 80 }, (_, i) => 60 + 0.3 * Math.sin(2 * Math.PI * 5.5 * i * HOP));
    const step = Array.from({ length: 80 }, (_, i) => (i < 40 ? 60 : 60.4));
    expect(vibratoAround(vib, 40, 0, 80, 17)).toBe(true);
    expect(vibratoAround(step, 40, 0, 80, 17)).toBe(false);
  });
  it('joinDropouts joins a gap without a dip and keeps a silent gap', () => {
    const p = Float64Array.from([60, 60, 60, NaN, NaN, 64, 64, 64]);
    const loud = [-10, -10, -10, -11, -11, -10, -10, -10];
    expect(joinDropouts([[0, 3], [5, 8]], p, loud, 3, 3)).toEqual([[0, 8]]);
    expect(p[3]).toBeCloseTo(61 + 1 / 3, 6);
    const q = Float64Array.from([60, 60, 60, NaN, NaN, 64, 64, 64]);
    const silent = [-10, -10, -10, -60, -60, -10, -10, -10];
    expect(joinDropouts([[0, 3], [5, 8]], q, silent, 3, 3)).toEqual([[0, 3], [5, 8]]);
  });
  it('frameLevelDb shows a short silent gap as a dip', () => {
    const sr = 22050;
    const y = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      const t = i / sr;
      y[i] = t > 0.5 && t < 0.54 ? 0 : 0.5 * Math.sin(2 * Math.PI * 220 * t);
    }
    const n = Math.round(1 / HOP);
    const track: FrameF0Track = { t0: 0, hopSec: HOP, hz: new Array(n).fill(220), voiced: new Array(n).fill(1) };
    const L = frameLevelDb(y, sr, track);
    const at = (t: number) => L[Math.round(t / HOP)];
    expect(at(0.3)).toBeCloseTo(10 * Math.log10(0.125), 0);
    expect(at(0.52)).toBeLessThan(at(0.3) - 20);
  });
});

describe('extractNotes on hand-made f0 tracks', () => {
  it('separated notes: one note each, exact pitch, onsets within a frame', () => {
    const { track, levelDb } = makeTrack(1.6, notesPitch([[0.1, 0.5, 60], [0.55, 1.0, 64], [1.05, 1.5, 67]]));
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 64, 67]);
    r.notes.forEach((n, i) => expect(Math.abs(n.start - [0.1, 0.55, 1.05][i])).toBeLessThan(HOP));
    expect(r.notes.every((n) => n.candidates.length === 0 && n.confidence > 0.9)).toBe(true);
    expect(r.tuningCents).toBe(0);
  });

  it('legato glide (100 ms): split at the glide start, glide frames not in the pitch', () => {
    const pitch = (t: number) => (t < 0.1 || t > 1.2 ? NaN : t < 0.6 ? 60 : 60 + 4 * rc((t - 0.6) / 0.1));
    const { track, levelDb } = makeTrack(1.3, pitch);
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 64]);
    expect(Math.abs(r.notes[1].start - 0.6)).toBeLessThan(0.04);
    expect(Math.abs(r.notes[1].cents)).toBeLessThan(5);
  });

  it('scoop at the onset (-100 cents over 80 ms) does not split', () => {
    const pitch = (t: number) => (t < 0.2 || t > 1.0 ? NaN : 62 - 1 * (1 - rc((t - 0.2) / 0.08)));
    const { track, levelDb } = makeTrack(1.1, pitch);
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.length).toBe(1);
    expect(r.notes[0].midi).toBe(62);
    expect(Math.abs(r.notes[0].start - 0.2)).toBeLessThan(HOP);
  });

  it('vibrato (+-55 cents, 5.5 Hz) on a 2 s note stays one note', () => {
    const pitch = (t: number) => (t < 0.1 || t > 2.1 ? NaN : 65 + (t > 0.25 ? 0.55 * Math.sin(2 * Math.PI * 5.5 * (t - 0.25)) : 0));
    const { track, levelDb } = makeTrack(2.2, pitch);
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.length).toBe(1);
    expect(r.notes[0].midi).toBe(65);
  });

  it('vibrato with formant amplitude modulation (8 dB dips) stays one note', () => {
    const vib = (t: number) => Math.sin(2 * Math.PI * 5.5 * (t - 0.25));
    const pitch = (t: number) => (t < 0.1 || t > 2.1 ? NaN : 65 + (t > 0.25 ? 0.4 * vib(t) : 0));
    const level = (t: number) => -12 + (t > 0.25 ? 4 * vib(t) - 4 : 0);
    const { track, levelDb } = makeTrack(2.2, pitch, level);
    expect(extractNotes(track, levelDb, INFO).notes.length).toBe(1);
  });

  it('same-pitch repeat with a 12 dB dip ("la la") splits at the dip', () => {
    const pitch = (t: number) => (t < 0.1 || t > 1.3 ? NaN : 62);
    const { track, levelDb } = makeTrack(1.4, pitch, (t) => -12 + dip(0.7, 12)(t));
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.map((n) => n.midi)).toEqual([62, 62]);
    expect(Math.abs(r.notes[1].start - 0.7)).toBeLessThan(0.02);
  });

  it('same-pitch repeat without a dip (closed-mouth "n~") is NOT split (known limit), a 3 dB dip neither', () => {
    const pitch = (t: number) => (t < 0.1 || t > 1.3 ? NaN : 62);
    const flat = makeTrack(1.4, pitch);
    expect(extractNotes(flat.track, flat.levelDb, INFO).notes.length).toBe(1);
    const shallow = makeTrack(1.4, pitch, (t) => -12 + dip(0.7, 3)(t));
    expect(extractNotes(shallow.track, shallow.levelDb, INFO).notes.length).toBe(1);
  });

  it('dip splits respect splitOnDips and dipDb', () => {
    const pitch = (t: number) => (t < 0.1 || t > 1.3 ? NaN : 62);
    const { track, levelDb } = makeTrack(1.4, pitch, (t) => -12 + dip(0.7, 8)(t));
    expect(extractNotes(track, levelDb, INFO).notes.length).toBe(2);
    expect(extractNotes(track, levelDb, INFO, resolveHumConfig({ segment: { splitOnDips: false } })).notes.length).toBe(1);
    expect(extractNotes(track, levelDb, INFO, resolveHumConfig({ segment: { dipDb: 10 } })).notes.length).toBe(1);
  });

  it('a "ta" closure (silent gap) between repeats gives two notes', () => {
    const { track, levelDb } = makeTrack(1.0, notesPitch([[0.1, 0.46, 57], [0.5, 0.9, 57]]));
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.length).toBe(2);
    r.notes.forEach((n, i) => expect(Math.abs(n.start - [0.1, 0.5][i])).toBeLessThan(HOP));
  });

  it('octave glitch frames inside a note do not split it', () => {
    const pitch = (t: number) => (t < 0.1 || t > 0.9 ? NaN : t > 0.4 && t < 0.45 ? 72 : 60);
    const { track, levelDb } = makeTrack(1.0, pitch);
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.map((n) => n.midi)).toEqual([60]);
    expect(r.stats.octaveGlitchFrames).toBeGreaterThan(0);
  });

  it('octave fix: a short note 12 above both neighbours is moved, the reading kept as a candidate', () => {
    const { track, levelDb } = makeTrack(1.2, notesPitch([[0.1, 0.4, 60], [0.45, 0.6, 74], [0.65, 1.0, 62]]));
    // the 150 ms note is > 1 16th: the rule is tested with the pre-T9 reach of 4 16ths (default is 1 since T9)
    const r = extractNotes(track, levelDb, INFO, resolveHumConfig({ pitch: { octaveFixMaxSixteenths: 4 } }));
    expect(r.notes.map((n) => n.midi)).toEqual([60, 62, 62]);
    expect(r.notes[1].candidates).toContainEqual({ midi: 74, confidence: expect.any(Number), octaveFixed: true });
    expect(r.stats.octaveFixedNotes).toBe(1);
    const off = extractNotes(track, levelDb, INFO, resolveHumConfig({ pitch: { octaveFix: false } }));
    expect(off.notes.map((n) => n.midi)).toEqual([60, 74, 62]);
    // without the fix, the far note offers the octave toward its neighbours
    expect(off.notes[1].candidates.map((c) => c.midi)).toContain(62);
  });

  it('octave fix leaves long notes, edge notes and real leaps alone', () => {
    const long = makeTrack(2.4, notesPitch([[0.1, 0.4, 60], [0.45, 1.6, 72], [1.65, 2.0, 60]]));
    expect(extractNotes(long.track, long.levelDb, INFO).notes.map((n) => n.midi)).toEqual([60, 72, 60]);
    const edge = makeTrack(1.0, notesPitch([[0.1, 0.25, 72], [0.3, 0.6, 60], [0.65, 0.9, 62]]));
    expect(extractNotes(edge.track, edge.levelDb, INFO).notes.map((n) => n.midi)).toEqual([72, 60, 62]);
  });

  it('short blips: an isolated 30 ms voiced run is dropped, a 30 ms pitch blip inside a note merged', () => {
    const iso = makeTrack(1.0, notesPitch([[0.1, 0.5, 60], [0.7, 0.73, 67]]));
    expect(extractNotes(iso.track, iso.levelDb, INFO).notes.length).toBe(1);
    const inside = makeTrack(1.0, (t) => (t < 0.1 || t > 0.9 ? NaN : t > 0.5 && t < 0.53 ? 63 : 60));
    expect(extractNotes(inside.track, inside.levelDb, INFO).notes.map((n) => n.midi)).toEqual([60]);
  });

  it('a short note at a fast tempo survives when >= minNoteSixteenths', () => {
    // 120 bpm: 16th = 125 ms, half = 62.5 ms. A 100 ms note between two others is kept.
    const fast: HumInfo = { bpm: 120, ts: [4, 4], startSec: 0 };
    const { track, levelDb } = makeTrack(0.8, (t) => (t < 0.1 || t > 0.7 ? NaN : t < 0.3 ? 60 : t < 0.4 ? 62 : 64));
    expect(extractNotes(track, levelDb, fast).notes.map((n) => n.midi)).toEqual([60, 62, 64]);
  });

  it('tuning offset is removed; a note near a semitone boundary gets the neighbour as a candidate', () => {
    // all sung 30 cents sharp; the third note 30 + 38 = 68 cents sharp of 64 -> 64 + 38 cents after tuning
    const { track, levelDb } = makeTrack(2.2, notesPitch([[0.1, 0.5, 60.3], [0.55, 1.0, 62.3], [1.05, 1.5, 64.68], [1.55, 2.0, 65.3]]));
    const r = extractNotes(track, levelDb, INFO);
    expect(r.tuningCents).toBeCloseTo(30, 0);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65]);
    expect(r.notes[0].cents).toBeCloseTo(0, 0);
    expect(r.notes[2].cents).toBeCloseTo(38, 0);
    expect(r.notes[2].candidates[0].midi).toBe(65);
    expect(r.notes[2].confidence).toBeLessThan(r.notes[0].confidence);
    const noTune = extractNotes(track, levelDb, INFO, resolveHumConfig({ pitch: { tuning: false } }));
    expect(noTune.tuningCents).toBe(0);
    expect(noTune.notes[2].midi).toBe(65);
  });

  it('candidates are capped at pitch.candidatesMax', () => {
    const { track, levelDb } = makeTrack(1.2, notesPitch([[0.1, 0.4, 60], [0.45, 0.6, 73.45], [0.65, 1.0, 62]]));
    const r = extractNotes(track, levelDb, INFO, resolveHumConfig({ pitch: { candidatesMax: 1, tuning: false } }));
    expect(r.notes.every((n) => n.candidates.length <= 1)).toBe(true);
  });

  it('f0 dropout inside a fast glide (no level dip) keeps the onset at the glide start', () => {
    // 67 -> 75 over 100 ms; the tracker loses 4 frames mid-glide
    const pitch = (t: number) => {
      if (t < 0.1 || t > 1.2) return NaN;
      if (t > 0.64 && t < 0.69) return NaN;
      return t < 0.6 ? 67 : 67 + 8 * rc((t - 0.6) / 0.1);
    };
    const { track, levelDb } = makeTrack(1.3, pitch);
    for (let i = 0; i < levelDb.length; i++) if (levelDb[i] === -100 && i * HOP > 0.5 && i * HOP < 0.8) levelDb[i] = -13;
    const r = extractNotes(track, levelDb, INFO);
    expect(r.notes.map((n) => n.midi)).toEqual([67, 75]);
    expect(Math.abs(r.notes[1].start - 0.6)).toBeLessThan(0.05);
  });

  it('switches that are not implemented warn; no voiced frames warns; frame-count mismatch throws', () => {
    const { track, levelDb } = makeTrack(0.5, notesPitch([[0.1, 0.4, 60]]));
    const r = extractNotes(track, levelDb, INFO, resolveHumConfig({ segment: { noteHmm: true }, pitch: { keyPrior: true } }));
    expect(r.warnings.length).toBe(2);
    expect(r.notes.length).toBe(1);
    const empty = makeTrack(0.5, () => NaN);
    expect(extractNotes(empty.track, empty.levelDb, INFO).warnings).toContain('no voiced frames');
    expect(() => extractNotes(track, levelDb.slice(1), INFO)).toThrow(RangeError);
  });

  it('defaults are the T0 config', () => {
    const { track, levelDb } = makeTrack(0.5, notesPitch([[0.1, 0.4, 60]]));
    expect(extractNotes(track, levelDb, INFO, DEFAULT_HUM_CONFIG)).toEqual(extractNotes(track, levelDb, INFO));
  });
});

describe('scoop / drift robustness (rules 3b, 6b)', () => {
  // hum-v1 behaviour: the new rules off
  const OLD = resolveHumConfig({ segment: { plateauFrames: 0, fragmentMs: 0 } });
  const NO_TUNING = resolveHumConfig({ pitch: { tuning: false } });
  const midis = (r: { notes: { midi: number }[] }) => r.notes.map((n) => n.midi);

  it('hasPlateau finds a flat run of N frames', () => {
    const s = [60, 60.5, 61, 61.05, 61.1, 61.05, 62];
    expect(hasPlateau(s, 0, s.length, 4, 0.2)).toBe(true);
    expect(hasPlateau(s, 0, s.length, 5, 0.2)).toBe(false);
    expect(hasPlateau(s, 0, 3, 4, 0.2)).toBe(false);
  });

  it('a slow onset scoop (1.2 semitones over 220 ms) belongs to the note', () => {
    // from 58.8 up to 60 in 220 ms (5.5 st/s: "stable" for the slope test), then 60 for 0.5 s
    const pitch = (t: number) => (t < 0.1 || t > 0.82 ? NaN : t < 0.32 ? 58.8 + 1.2 * rc((t - 0.1) / 0.22) : 60);
    const { track, levelDb } = makeTrack(1, pitch);
    expect(midis(extractNotes(track, levelDb, INFO, OLD))).toEqual([59, 60]); // the extra split of look point 1
    const r = extractNotes(track, levelDb, INFO);
    expect(midis(r)).toEqual([60]);
    expect(Math.abs(r.notes[0].start - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(r.notes[0].cents)).toBeLessThan(5);
  });

  it('overshoot and return (+0.8 semitones for 90 ms) does not split', () => {
    const pitch = (t: number) => (t < 0.1 || t > 1.0 ? NaN : t > 0.45 && t < 0.54 ? 60.8 : 60);
    const { track, levelDb } = makeTrack(1.1, pitch);
    expect(midis(extractNotes(track, levelDb, INFO))).toEqual([60]);
  });

  it('a slow drift across the semitone boundary in the middle of a note does not split', () => {
    // 60.1 for 0.4 s, drifting up to 60.75 over 150 ms and back over 150 ms, then 60.1 for 0.3 s
    const pitch = (t: number) => {
      if (t < 0.1 || t > 1.1) return NaN;
      const x = t - 0.5;
      return x < 0 || x > 0.3 ? 60.1 : 60.1 + 0.65 * (x < 0.15 ? x / 0.15 : (0.3 - x) / 0.15);
    };
    const { track, levelDb } = makeTrack(1.2, pitch);
    const r = extractNotes(track, levelDb, INFO, NO_TUNING);
    expect(midis(r)).toEqual([60]);
    expect(Math.abs(r.notes[0].cents - 10)).toBeLessThan(15); // the drift frames move it a little, not across
  });

  it('a short drifted tail (90 ms over the boundary) merges into the note (rule 6b), pitch from the longer part', () => {
    // 0.5 s at 60.2, a quick move to 60.9 held 90 ms, then silence: rule 3b splits it at the run end, 6b merges it back
    const pitch = (t: number) => (t < 0.1 || t > 0.69 ? NaN : t < 0.6 ? 60.2 : 60.9);
    const { track, levelDb } = makeTrack(0.8, pitch);
    const noMerge = extractNotes(track, levelDb, INFO, resolveHumConfig({ segment: { fragmentMs: 0, minNoteSixteenths: 0.25 }, pitch: { tuning: false } }));
    expect(midis(noMerge)).toEqual([60, 61]);
    const r = extractNotes(track, levelDb, INFO, NO_TUNING);
    expect(midis(r)).toEqual([60]);
    expect(Math.abs(r.notes[0].cents - 20)).toBeLessThan(5);
  });

  it('real notes still split: legato steps, a fast 16th run and a jump after a short note', () => {
    const legato = (t: number) => (t < 0.1 || t > 1.3 ? NaN : t < 0.5 ? 60 : t < 0.9 ? 62 : 61);
    let x = makeTrack(1.4, legato);
    expect(midis(extractNotes(x.track, x.levelDb, INFO))).toEqual([60, 62, 61]);
    // 16ths at 120 bpm (125 ms each) with 30 ms glides, rising scale
    const fast: HumInfo = { bpm: 120, ts: [4, 4], startSec: 0 };
    const steps = [60, 62, 64, 65, 67, 65, 64, 62];
    const run = (t: number) => {
      if (t < 0.1 || t >= 0.1 + steps.length * 0.125) return NaN;
      const k = Math.floor((t - 0.1) / 0.125);
      const dt = t - 0.1 - k * 0.125;
      return k > 0 && dt < 0.03 ? steps[k - 1] + (steps[k] - steps[k - 1]) * rc(dt / 0.03) : steps[k];
    };
    x = makeTrack(1.2, run);
    expect(midis(extractNotes(x.track, x.levelDb, fast))).toEqual(steps);
  });

  it('mergeFragments: a short piece next to a longer note within 1 semitone joins it and keeps its pitch range', () => {
    const segs = [
      { a: 0, b: 6, cause: 'run' as const },
      { a: 6, b: 40, cause: 'pitch' as const },
      { a: 40, b: 70, cause: 'pitch' as const },
    ];
    const pitchOf = [59.4, 60, 62];
    const med = (g: { a: number }) => pitchOf[segs.findIndex((x) => x.a === g.a)] ?? (g.a === 0 ? 60 : 62);
    const out = mergeFragments(segs, med, 10, 0, 1);
    expect(out.map((g) => [g.a, g.b, g.pa, g.pb])).toEqual([[0, 40, 6, 40], [40, 70, undefined, undefined]]);
    // too far in pitch, or a dip boundary: kept
    expect(mergeFragments(segs, () => 0, 10, 0, 1).length).toBe(2); // equal medians -> merged too (d = 0)
    const far = mergeFragments(segs, (g) => (g.a === 0 ? 57 : g.a === 6 ? 60 : 62), 10, 0, 1);
    expect(far.length).toBe(3);
    const dip = mergeFragments([{ a: 0, b: 30, cause: 'run' }, { a: 30, b: 36, cause: 'dip' }], () => 60, 10, 0, 1);
    expect(dip.length).toBe(2);
  });
});
