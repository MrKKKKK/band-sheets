// Spike 4 T1: melodies for the synthetic humming (docs/audio-spike4-plan.md section 4).
//
// Sources (all already used by the synthetic renders or traditional, never private charts):
//   saints    「聖者の行進」 section A of the Vocal part of src/lib/saintsSample.ts (16 bars)
//   kirakira  「きらきら星」 A (src/lib/fixtures/melodyFixtures.ts, 4 bars)
//   etude     the chord etude melody (render/etude.ts, ETUDE_SEED), first section A1 (8 bars)
//   rand      randomMelody(): seeded, 16th grid, 4/4, rests, dots, notes across bar lines, same-pitch
//             repeats, an octave leap, 8 bars
// Melodies are plain MelodyEvent[] (src/lib/melody.ts; ticks: whole = 64) without lyrics/chords.

import { type MelodyEvent, type TimeSig } from '../../../../src/lib/melody';
import { readSection, melodyParts } from '../../../../src/lib/melodyPart';
import { parseSong } from '../../../../src/lib/parseSong';
import { formatPitch, midiToPitch, parsePitch, pitchToMidi } from '../../../../src/lib/pitch';
import { saintsSampleText } from '../../../../src/lib/saintsSample';
import { kirakiraA } from '../../../../src/lib/fixtures/melodyFixtures';
import { chordEtude } from '../etude';
import { prng } from '../prng';
import { ETUDE_SEED } from '../variants';

export const FOUR_FOUR: TimeSig = { num: 4, den: 4 };
export const MELODY_IDS = ['saints', 'kirakira', 'etude', 'rand'] as const;
export type MelodyId = (typeof MELODY_IDS)[number];
export type Register = 'low' | 'high';

/** Voice ranges (MIDI): low = male hum around G2..E4, high = female/high around C4..G5. */
export const REGISTERS: Record<Register, { lo: number; hi: number; median: number }> = {
  low: { lo: 43, hi: 66, median: 53 },
  high: { lo: 58, hi: 81, median: 67 },
};

export function midiOf(pitch: string): number {
  const p = parsePitch(pitch);
  if (!p) throw new Error(`bad pitch ${pitch}`);
  return pitchToMidi(p);
}

export function pitchName(midi: number, key?: string): string {
  return formatPitch(midiToPitch(midi, key));
}

const strip = (e: MelodyEvent): MelodyEvent =>
  e.kind === 'note' ? { kind: 'note', pitch: e.pitch, ticks: e.ticks } : { kind: 'rest', ticks: e.ticks };

function vocalSection(text: string, label: string): MelodyEvent[] {
  const song = parseSong(text);
  const part = melodyParts(song).find((p) => p.name === 'Vocal');
  if (!part) throw new Error('no Vocal part');
  const r = readSection(part.body, label, FOUR_FOUR);
  if (r.status !== 'ok') throw new Error(`section ${label}: ${r.status}`);
  return r.events.map(strip);
}

/** First `bars` bars of `events` (4/4); a note crossing the cut is shortened. */
export function firstBars(events: MelodyEvent[], bars: number): MelodyEvent[] {
  const limit = bars * 64;
  const out: MelodyEvent[] = [];
  let t = 0;
  for (const e of events) {
    if (t >= limit) break;
    out.push({ ...e, ticks: Math.min(e.ticks, limit - t) });
    t += e.ticks;
  }
  return out;
}

/** The fixed (non-random) melodies, untransposed. */
export function fixedMelody(id: Exclude<MelodyId, 'rand'>): MelodyEvent[] {
  if (id === 'saints') return vocalSection(saintsSampleText, 'A');
  if (id === 'kirakira') return kirakiraA.events.map(strip);
  return firstBars(vocalSection(chordEtude(ETUDE_SEED).text, 'A1'), 8);
}

export function noteMidis(events: MelodyEvent[]): number[] {
  return events.filter((e) => e.kind === 'note').map((e) => midiOf(e.pitch!));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Transposes so that the median note lands on the register's median (whole semitones). */
export function toRegister(events: MelodyEvent[], reg: Register): { events: MelodyEvent[]; semitones: number } {
  const semitones = Math.round(REGISTERS[reg].median - median(noteMidis(events)));
  return {
    semitones,
    events: events.map((e) => (e.kind === 'note' ? { ...e, pitch: pitchName(midiOf(e.pitch!) + semitones) } : e)),
  };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const KEYS: [string, number][] = [
  ['C', 0],
  ['D', 2],
  ['F', 5],
  ['G', 7],
  ['Bb', 10],
  ['A', 9],
  ['Eb', 3],
  ['E', 4],
];

export interface RandomMelodyFeatures {
  dotted: boolean;
  rest: boolean;
  acrossBar: boolean;
  sixteenth: boolean;
  repeat: boolean;
  octaveLeap: boolean;
}

/** Which of the required features `events` has (4/4). */
export function melodyFeatures(events: MelodyEvent[]): RandomMelodyFeatures {
  const f: RandomMelodyFeatures = { dotted: false, rest: false, acrossBar: false, sixteenth: false, repeat: false, octaveLeap: false };
  let t = 0;
  let prev: MelodyEvent | undefined;
  for (const e of events) {
    if (e.kind === 'rest') f.rest = true;
    else {
      if ([12, 24, 48].includes(e.ticks)) f.dotted = true;
      if (e.ticks === 4) f.sixteenth = true;
      if (Math.floor(t / 64) !== Math.floor((t + e.ticks - 1) / 64)) f.acrossBar = true;
      if (prev?.kind === 'note') {
        const d = Math.abs(midiOf(e.pitch!) - midiOf(prev.pitch!));
        if (d === 0) f.repeat = true;
        if (d === 12) f.octaveLeap = true;
      }
    }
    prev = e;
    t += e.ticks;
  }
  return f;
}

const NOTE_TICKS: [number, number][] = [
  [4, 0.14],
  [8, 0.3],
  [12, 0.1],
  [16, 0.2],
  [24, 0.1],
  [32, 0.11],
  [48, 0.05],
];

function pick<T>(rnd: () => number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r < 0) return v;
  }
  return items[items.length - 1][0];
}

/**
 * Deterministic random humming melody on the 16th grid (4/4, `bars` bars, ends exactly at the last bar
 * line). Durations 16th .. dotted half, rests (16th .. quarter), notes that cross bar lines (one event),
 * same-pitch repeats and at least one octave leap; pitches walk a major scale inside the register.
 * Draws are repeated (same stream) until every feature of melodyFeatures() is present.
 */
export function randomMelody(seed: number, reg: Register, bars = 8): { events: MelodyEvent[]; key: string } {
  const rnd = prng(seed * 7919 + 17);
  const [key, tonic] = KEYS[Math.floor(rnd() * KEYS.length)];
  const { lo, hi } = REGISTERS[reg];
  const scale: number[] = [];
  for (let m = lo; m <= hi; m++) if (MAJOR.includes((((m - tonic) % 12) + 12) % 12)) scale.push(m);
  for (let attempt = 0; attempt < 200; attempt++) {
    const events: MelodyEvent[] = [];
    const total = bars * 64;
    let t = 0;
    let idx = Math.floor(scale.length / 2) + Math.floor(rnd() * 3) - 1;
    let prevRest = true;
    let first = true;
    while (t < total) {
      const left = total - t;
      if (!first && !prevRest && rnd() < 0.13) {
        const r = Math.min(left, [4, 8, 8, 16][Math.floor(rnd() * 4)]);
        events.push({ kind: 'rest', ticks: r });
        t += r;
        prevRest = true;
        continue;
      }
      const d = Math.min(pick(rnd, NOTE_TICKS), left);
      if (!first) {
        const u = rnd();
        let step: number;
        if (u < 0.13) step = 0;
        else if (u < 0.58) step = rnd() < 0.5 ? -1 : 1;
        else if (u < 0.83) step = rnd() < 0.5 ? -2 : 2;
        else if (u < 0.94) step = (rnd() < 0.5 ? -1 : 1) * (3 + Math.floor(rnd() * 2));
        else step = rnd() < 0.5 ? -7 : 7; // octave in a 7-note scale
        let n = idx + step;
        if (n < 0 || n >= scale.length) n = idx - step;
        if (n < 0 || n >= scale.length) n = idx;
        idx = n;
      }
      events.push({ kind: 'note', pitch: pitchName(scale[idx], key), ticks: d });
      t += d;
      prevRest = false;
      first = false;
    }
    const f = melodyFeatures(events);
    if (Object.values(f).every(Boolean)) return { events, key };
  }
  throw new Error(`randomMelody(${seed}): features not reached`);
}
