// The variants of docs/audio-spike0-plan.md, design decision 6, plus the
// spike 0 review additions (R5: etude full / shuffle, R6: lead-in silence).

import type { Comp } from './pianoPart';
import type { Level, Mix, Modulation, Variant } from './types';

export const ETUDE_SEED = 1;

const MIX_NAME: Record<Mix, string> = { piano: 'piano', 'piano+drums': 'drums', full: 'full' };
const MIXES: Mix[] = ['piano', 'piano+drums', 'full'];

/** Bars of both songs (the tempo curves have one entry per bar). */
export const SONG_BARS = 32;
export const HELD_OUT_SEED = 2;
/** Share of 7th chords in the held-out and in the 7th-heavy etude. */
export const SEVENTH_HEAVY_SHARE = 0.4;
/** Spike 2 (T4): seed of the held-out AABA etude, tempo of level LR (REC-like), vocab share. */
export const ETUDE3_SEED = 3;
export const LR_TEMPO = 124;
export const VOCAB_SHARE = 0.2;

/** Slow tempo wander: +-6 % sine over 24 bars, whole BPM, first bar = `tempo`. */
export function driftCurve(tempo: number, bars = SONG_BARS): number[] {
  return Array.from({ length: bars }, (_, i) => Math.round(tempo * (1 + 0.06 * Math.sin((2 * Math.PI * i) / 24))));
}

interface Extra {
  leadInSec?: number;
  level?: Level;
  heldOut?: boolean;
  comp?: Comp;
  soundFont?: 'musescore';
  pianoGainDb?: number;
  drift?: boolean;
  /**
   * Etude variants: 'etude' (seed 1, default), 'etude2' (held out), 'etude7' (7th-heavy, tuning),
   * 'etude3' (spike 2: AABA with a 1-beat pickup, seed 3, held out), 'etudevoc' (spike 2: seed 1 with
   * dim / aug / sus4 / m7b5 / dim7 mixed in).
   */
  etude?: 'etude2' | 'etude7' | 'etude3' | 'etudevoc';
  lrGrade?: 0 | 1 | 2;
  modulation?: Modulation;
  recStyle?: 'hard';
}

function make(
  song: Variant['song'],
  mix: Mix,
  tempo: number,
  swing: Variant['swing'],
  click: boolean,
  leadInSecOrExtra: number | Extra = 0,
): Variant {
  const x: Extra = typeof leadInSecOrExtra === 'number' ? { leadInSec: leadInSecOrExtra } : leadInSecOrExtra;
  const leadInSec = x.leadInSec ?? 0;
  const prefix = song === 'etude' ? `${x.etude ?? 'etude'}-` : '';
  const feel = swing === 'asWritten' ? 'shuffle' : 'straight';
  const lead = leadInSec > 0 ? `-lead${leadInSec}s` : '';
  const tags = [
    x.soundFont ? '-sf-muse' : '',
    x.comp ? `-${x.comp}` : '',
    x.recStyle ? `-${x.recStyle}` : '',
    x.pianoGainDb !== undefined ? `-pianoM${-x.pianoGainDb}` : '',
    x.drift ? '-drift' : '',
    x.modulation ? `-mod${x.modulation.tag}` : '',
  ];
  const name = `${prefix}${MIX_NAME[mix]}-t${tempo}-${feel}${click ? '-click' : ''}${lead}${tags.join('')}`;
  const v: Variant = { song, mix, tempo, swing, click, name, level: x.level ?? 0 };
  if (leadInSec > 0) v.leadInSec = leadInSec;
  if (x.comp) v.comp = x.comp;
  if (x.soundFont) v.soundFont = x.soundFont;
  if (x.pianoGainDb !== undefined) v.pianoGainDb = x.pianoGainDb;
  if (x.drift) v.tempoCurve = driftCurve(tempo);
  if (x.etude === 'etude2') {
    v.etudeSeed = HELD_OUT_SEED;
    v.seventhShare = SEVENTH_HEAVY_SHARE;
  } else if (x.etude === 'etude7') {
    v.seventhShare = SEVENTH_HEAVY_SHARE;
  } else if (x.etude === 'etude3') {
    v.etudeSeed = ETUDE3_SEED;
    v.etudeForm = 'aaba';
    v.pickupBeats = 1;
  } else if (x.etude === 'etudevoc') {
    v.vocabShare = VOCAB_SHARE;
  }
  if (x.comp === 'rec') v.recSeed = v.etudeSeed ?? 1;
  if (x.lrGrade !== undefined) v.lrGrade = x.lrGrade;
  if (x.recStyle) v.recStyle = x.recStyle;
  if (x.modulation) v.modulation = x.modulation;
  if (x.heldOut) v.heldOut = true;
  return v;
}

export function allVariants(): Variant[] {
  const out: Variant[] = [];
  for (const mix of MIXES) for (const t of [80, 116, 160]) out.push(make('saints', mix, t, 'none', false));
  out.push(make('saints', 'piano+drums', 116, 'asWritten', false));
  out.push(make('saints', 'full', 116, 'asWritten', false));
  out.push(make('saints', 'full', 116, 'none', true));
  // Etude: straight piano / drums / full at two tempi, plus a shuffle one.
  for (const t of [90, 140]) for (const mix of MIXES) out.push(make('etude', mix, t, 'none', false));
  out.push(make('etude', 'full', 90, 'asWritten', false));
  // Lead-in silence (R6): bar 0 does not start at 0 s.
  out.push(make('saints', 'full', 116, 'none', false, 1.37));
  out.push(make('etude', 'piano+drums', 90, 'none', false, 0.62));
  // L1: another timbre, accompaniment shapes, piano balance (full mix, straight).
  const sa = (x: Extra) => make('saints', 'full', 116, 'none', false, x);
  const et = (x: Extra) => make('etude', 'full', 90, 'none', false, x);
  for (const f of [sa, et]) {
    out.push(f({ level: 1, soundFont: 'musescore' }));
    out.push(f({ level: 1, comp: 'arp8' }));
    out.push(f({ level: 1, comp: 'whole' }));
    out.push(f({ level: 1, pianoGainDb: -9 }));
    // L2: tempo drift.
    out.push(f({ level: 2, drift: true }));
  }
  // L3: whole-note accompaniment, no drums or melody, tempo drift.
  out.push(make('saints', 'piano', 116, 'none', false, { level: 3, comp: 'whole', drift: true }));
  out.push(make('etude', 'piano', 90, 'none', false, { level: 3, comp: 'whole', drift: true }));
  // 7th-heavy etude (tuning) and the held-out etude (seed 2, 7th-heavy): L0, L1, L2.
  out.push(et({ level: 0, etude: 'etude7' }));
  out.push(et({ level: 0, etude: 'etude2', heldOut: true }));
  out.push(et({ level: 1, etude: 'etude2', heldOut: true, comp: 'arp8' }));
  out.push(et({ level: 1, etude: 'etude2', heldOut: true, soundFont: 'musescore' }));
  out.push(et({ level: 2, etude: 'etude2', heldOut: true, drift: true }));
  // ---- spike 2 (docs/audio-spike2-plan.md, T4) ----
  // Level LR: REC-like accompaniment, piano only (like the recording). Grade 0 = L0-like, grade 1 =
  // another timbre (here) or 30 dB noise (py/degrade.py), grade 2 = room (py/degrade.py).
  const lr = (song: Variant['song'], x: Extra) =>
    make(song, 'piano', LR_TEMPO, 'none', false, { level: 'LR', comp: 'rec', ...x });
  for (const s of ['etude', 'saints'] as const) {
    out.push(lr(s, { lrGrade: 0 }));
    out.push(lr(s, { lrGrade: 1, soundFont: 'musescore' }));
  }
  // Held-out song of a different form: etude3 (AABA, 1-beat pickup, seed 3).
  out.push(lr('etude', { lrGrade: 0, etude: 'etude3', heldOut: true }));
  out.push(lr('etude', { lrGrade: 1, etude: 'etude3', heldOut: true, soundFont: 'musescore' }));
  // ---- spike 2 (T4b): the harder REC-like style (render/pianoPart.ts REC_HARD), same songs and grades ----
  for (const s of ['etude', 'saints'] as const) {
    out.push(lr(s, { lrGrade: 0, recStyle: 'hard' }));
    out.push(lr(s, { lrGrade: 1, soundFont: 'musescore', recStyle: 'hard' }));
  }
  out.push(lr('etude', { lrGrade: 0, etude: 'etude3', heldOut: true, recStyle: 'hard' }));
  out.push(lr('etude', { lrGrade: 1, etude: 'etude3', heldOut: true, soundFont: 'musescore', recStyle: 'hard' }));
  // Level V: the etude with dim / aug / sus4 / m7b5 / dim7 mixed in (block chords, full mix).
  out.push(et({ level: 'V', etude: 'etudevoc' }));
  // ---- spike 2 (T23): modulation variants, L0 and LR grade 1 (piano only, MuseScore timbre) ----
  // The etudes have no key of their own (random-walk chords); 'C' is a nominal base key for the truth.
  const modEt = (semitones: number, sections: number[], tag: string): Modulation => ({ sections, semitones, baseKey: 'C', tag });
  const mods: [Variant['song'], Modulation][] = [
    ['etude', modEt(7, [1, 3], 'Bup7')], // B1 and B2 up a fifth (to the dominant)
    ['etude', modEt(1, [3], 'LastUp1')],
    ['saints', modEt(2, [1], 'LastUp2')], // last chorus up a whole tone
  ];
  for (const [song, modulation] of mods) {
    out.push(song === 'etude' ? et({ level: 0, modulation }) : sa({ level: 0, modulation }));
    out.push(lr(song, { lrGrade: 1, soundFont: 'musescore', modulation }));
  }
  // Held-out: etude2 (seed 2), last section +2, L0.
  out.push(et({ level: 0, etude: 'etude2', heldOut: true, modulation: modEt(2, [3], 'LastUp2') }));
  return out;
}
