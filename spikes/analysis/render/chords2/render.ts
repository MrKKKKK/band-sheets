// Spike 7 T5: render one synthetic chords2 variant -> wav bytes + truth (deterministic per variant).
//
// The chart (material.ts) is played note by note (perform): the piano's right and left hands (voicing.ts) in the
// variant's accompaniment pattern, and (unless piano-only) a bass instrument on the written bass. Every note is a
// voice of its timbre (pianos.ts, render/bass/timbres.ts) placed so that its onset (render/drum/kits.ts onsetIndex,
// heard through the room) lands exactly on the note's truth time, held to its note-off and released
// (render/bass/render.ts voiceEnvelope); a key struck again cuts its previous note there (a piano re-strike).
// Mix: piano + bass (each note times its fixed gain, 1 except peaky's soft notes) -> room (Schroeder, held-out: FDN)
// -> fixed output gain -> pink noise. All but the noise are linear and causal, so check.ts can measure each note's
// onset on its own contribution (as spike 6 did).

import { addNoise } from '../hum/degrade';
import { gauss } from '../hum/voice';
import { addReverb, fdnRoom } from '../drum/room';
import { onsetIndex } from '../drum/kits';
import { voiceEnvelope } from '../bass/render';
import type { Room } from '../bass/variants';
import { BASS_LO, getTimbre, SAMPLE_RATE, type BassVoice } from '../bass/timbres';
import { encodeWav } from '../wav';
import { bassPc } from './chordName';
import { bChart, phraseChart, PHRASES, stageChart, type Chart } from './material';
import { getPiano } from './pianos';
import { handPcs, lhNotes, rhVoicing } from './voicing';
import { streamOf, synthParams, TAIL_SEC, type C2SynthParams, type C2Variant } from './variants';
import { buildChords2Truth, type Chords2TruthFile } from './truth';

/** Fixed output gain of every variant before the noise (never per file; keeps the loudest mixes below full scale). */
export const OUTPUT_GAIN = 0.8;
/** Velocities: [right hand, left hand, bass] played normally and softly (peaky); the peaky accent. */
export const VELOCITY = { normal: [70, 74, 92], soft: [24, 28, 40], accent: 127 } as const;
/** Length of the peaky accent chord (s). */
export const ACCENT_SEC = 0.12;
/**
 * peaky: fixed gain of every note but the accents (the soft velocities alone give P1 only ~8 dB less, too little for a
 * crest factor that keeps the normalisation below -22 dBFS; the manifest's crestDb shows the result).
 */
export const PEAKY_SOFT_GAIN = 0.25;
const JITTER_CLIP = 2.5;

export type Part = 'rh' | 'lh' | 'bass';
export interface PlayedNote {
  part: Part;
  midi: number;
  velocity: number;
  /** Index of the chart chord (= truth segment) the note belongs to. */
  seg: number;
  /** Written onset / end in beats from bar 0. */
  beat: number;
  endBeat: number;
  /** Truth onset / note-off (s): written time + timing spread, then the onset on a whole sample. */
  t: number;
  end: number;
  accent: boolean;
  /** Fixed gain of the note in the mix (1, or PEAKY_SOFT_GAIN). */
  gain: number;
}

export function chartOf(v: C2Variant, p: C2SynthParams = synthParams(v)): Chart {
  const rnd = streamOf(v, 'song');
  if (v.set === 'B') return bChart(rnd);
  if (v.set === 'pair') return phraseChart(PHRASES.find((x) => x.id === v.phrase)!, p.transpose);
  return stageChart(v.set, rnd);
}

/** Strike units of a chord: its start and every bar line inside it. */
function units(start: number, beats: number): [number, number][] {
  const cuts = [start];
  for (let b = Math.floor(start / 4) * 4 + 4; b < start + beats; b += 4) cuts.push(b);
  return cuts.map((c, i) => [c, cuts[i + 1] ?? start + beats]);
}

/** The notes of the chart as written (beats, velocities before the spread). */
export function writtenNotes(chart: Chart, p: C2SynthParams, withBass: boolean): Omit<PlayedNote, 't' | 'end'>[] {
  const out: Omit<PlayedNote, 't' | 'end'>[] = [];
  const gain = p.peaky ? PEAKY_SOFT_GAIN : 1;
  const [vr, vl, vb] = p.peaky ? VELOCITY.soft : VELOCITY.normal;
  const sectionStarts = new Set(chart.sections.map((s) => s.startBar * 4));
  let prevRh: number[] | null = null;
  chart.chords.forEach((c, seg) => {
    const { rh: rhPcs, lhAbove } = handPcs(c.chord, c.form);
    const rh = rhVoicing(rhPcs, prevRh, p.rhCentre);
    prevRh = rh;
    const lh = lhNotes(c.chord, p.lhStyle, lhAbove);
    const add = (part: Part, midi: number, velocity: number, beat: number, endBeat: number) =>
      out.push({ part, midi, velocity, seg, beat, endBeat, accent: false, gain });
    for (const [u0, u1] of units(c.beat, c.beats)) {
      if (p.comp === 'whole') {
        for (const m of lh) add('lh', m, vl, u0, u1);
        for (const m of rh) add('rh', m, vr, u0, u1);
      } else if (p.comp === 'block4') {
        for (let b = u0; b < u1; b++) {
          for (const m of lh) add('lh', m, vl, b, b + 0.9);
          for (const m of rh) add('rh', m, vr, b, b + 0.9);
        }
      } else {
        // arp8: the left hand at the unit start, then the right hand one note per eighth, up and down, held (pedal)
        for (const m of lh) add('lh', m, vl, u0, u1);
        const slots = (u1 - u0) * 2 - 1;
        if (slots < rh.length) for (const m of rh) add('rh', m, vr, u0 + 0.5, u1);
        else {
          const order = [...rh, ...rh.slice(1, -1).reverse()];
          for (let k = 0; k < slots; k++) add('rh', order[k % order.length], vr, u0 + 0.5 * (k + 1), u1);
        }
      }
      if (withBass) {
        const bm = BASS_LO + ((bassPc(c.chord) - BASS_LO + 120) % 12);
        const step = p.bassPattern === 'whole' ? u1 - u0 : p.bassPattern === 'half' ? 2 : 0.5;
        for (let b = u0; b < u1 - 1e-9; b += step) add('bass', bm, vb, b, Math.min(u1, b + step * (p.bassPattern === 'eighths' ? 0.8 : 0.95)));
      }
    }
  });
  if (p.peaky)
    for (const n of out)
      if (n.part !== 'bass' && sectionStarts.has(n.beat)) {
        n.velocity = VELOCITY.accent;
        n.accent = true;
        n.gain = 1;
      }
  return out;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Written notes -> timed notes (spread, velocities, re-strike cuts), sorted by time. */
export function perform(v: C2Variant, chart: Chart, p: C2SynthParams): PlayedNote[] {
  const written = writtenNotes(chart, p, v.bass !== null);
  const sec = (beat: number) => p.leadSec + (beat * 60) / p.bpm;
  const jit = streamOf(v, 'jitter', { perVariation: true });
  const vel = streamOf(v, 'velocity', { perVariation: true });
  const J = p.jitterSec;
  const offset = () => (J > 0 ? Math.max(-JITTER_CLIP, Math.min(JITTER_CLIP, gauss(jit))) * (J / JITTER_CLIP) : 0);
  const strikeOff = new Map<number, number>();
  const accentBeats = (ACCENT_SEC * p.bpm) / 60;
  const notes = written.map((n) => {
    let d: number;
    if (n.part === 'bass') d = offset();
    else {
      if (!strikeOff.has(n.beat)) strikeOff.set(n.beat, offset());
      d = strikeOff.get(n.beat)! + (J > 0 ? jit() * (J / 2) : 0);
    }
    const velocity = n.accent ? n.velocity : Math.max(12, Math.min(126, Math.round(n.velocity + (p.velocitySigma > 0 ? gauss(vel) * p.velocitySigma : 0))));
    const endBeat = n.accent ? Math.min(n.endBeat, n.beat + accentBeats) : n.endBeat;
    return { ...n, velocity, t: sec(n.beat) + d, end: sec(endBeat) + d };
  });
  notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
  // a key struck again (same instrument) ends the previous note there
  const lastOf = new Map<string, PlayedNote>();
  for (const n of notes) {
    const k = `${n.part === 'bass' ? 'b' : 'p'}${n.midi}`;
    const prev = lastOf.get(k);
    if (prev && prev.end > n.t) prev.end = n.t;
    lastOf.set(k, n);
  }
  for (const n of notes) if (n.end - n.t < 0.03) throw new Error(`${v.name}: a note shorter than 30 ms (${n.part} ${n.midi})`);
  return notes;
}

/** The linear, causal room, in place. */
export function applyRoom(x: Float64Array, room: Room, sr = SAMPLE_RATE): Float64Array {
  if (room.kind === 'schroeder') addReverb(x, room.rt60, sr, room.wet);
  else if (room.kind === 'fdn') fdnRoom(x, room.rt60, sr, room.wet);
  return x;
}

const ONSET_WINDOW_SEC = 0.25;
/** Onset of a placed voice as heard through the room (from its first sample, zero state). */
export function heardOnset(x: Float32Array, room: Room, sr = SAMPLE_RATE): number {
  const w = Float64Array.from(x.subarray(0, Math.min(x.length, Math.round(ONSET_WINDOW_SEC * sr))));
  return onsetIndex(applyRoom(w, room, sr), sr);
}

export interface PlacedNote extends PlayedNote {
  /** Onset sample (= round(t * sr)). */
  at: number;
  /** The voice with its envelope, and the sample of it placed on `at`. */
  x: Float32Array;
  onset: number;
  /** The note is longer than its voice. */
  cut: boolean;
}

/** Everything but the audio sum (shared by render and check). */
export function prepareC2(v: C2Variant, sr = SAMPLE_RATE) {
  const p = synthParams(v);
  const chart = chartOf(v, p);
  const notes = perform(v, chart, p);
  const piano = getPiano(v.piano);
  const bass = v.bass === null ? null : getTimbre(v.bass);
  const rr = streamOf(v, 'rr', { perVariation: true });
  const placed: PlacedNote[] = notes.map((n, i) => {
    const voice: BassVoice = n.part === 'bass' ? bass!.voice(n.midi, n.velocity, p.jitterSec > 0 ? rr() : 0) : piano.voice(n.midi, n.velocity);
    const at = Math.round(n.t * sr);
    const off = Math.round(n.end * sr);
    const relLen = Math.max(1, Math.round(voice.release * sr));
    let onset = voice.onset;
    let x = voice.x;
    for (let it = 0; it < 4; it++) {
      x = voiceEnvelope(voice, off - at + onset, relLen);
      const o = heardOnset(x, p.room, sr);
      if (o < 0) throw new Error(`${v.name}: silent note ${i}`);
      if (o === onset) break;
      onset = o;
    }
    if (at - onset < 0) throw new Error(`${v.name}: note ${i} starts before the audio`);
    return { ...n, t: r6(at / sr), end: r6(off / sr), at, x, onset, cut: off - at + onset > voice.x.length };
  });
  const durationSec = p.leadSec + (chart.bars * 4 * 60) / p.bpm;
  return { params: p, chart, placed, durationSec };
}

export interface RenderedC2 {
  wav: Buffer;
  truth: Chords2TruthFile;
  params: C2SynthParams;
  peak: number;
  clipped: number;
  /** Peak / RMS of the whole wav (dB). */
  crestDb: number;
}

export function renderC2(v: C2Variant, sr = SAMPLE_RATE): RenderedC2 {
  const prep = prepareC2(v, sr);
  const { params: p, placed, durationSec } = prep;
  const n = Math.round((durationSec + TAIL_SEC) * sr);
  const x = new Float64Array(n);
  for (const pn of placed) {
    const start = pn.at - pn.onset;
    const hi = Math.min(n, start + pn.x.length);
    for (let i = start; i < hi; i++) x[i] += pn.x[i - start] * pn.gain;
  }
  applyRoom(x, p.room, sr);
  for (let i = 0; i < n; i++) x[i] *= OUTPUT_GAIN;
  if (p.noiseSnrDb !== null) addNoise(x, p.noiseSnrDb, streamOf(v, 'noise', { perVariation: true }));
  const samples = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = x[i];
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
    ss += samples[i] * samples[i];
  }
  const crestDb = 20 * Math.log10(peak / Math.sqrt(ss / n));
  return { wav: encodeWav(samples, sr), truth: buildChords2Truth(v, prep, n / sr), params: p, peak, clipped, crestDb };
}
