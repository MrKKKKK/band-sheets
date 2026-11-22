// Spike 7 T5: truth JSON of a synthetic chords2 variant (<name>.truth.json; docs/audio-spike7-t5.md).
//
//   beats, sections        the written grid (lead-in + beat * 60 / bpm; 4/4, no tempo drift).
//   key                    the chart's key (stage songs: the major key; phrases: the row's key, transposed).
//   chords[]               one per chart chord (consecutive equal chords merged): start / end on the grid, root, bass
//                          (`/X`, null = root; sharp names), text, quality = originalQuality = the chord as written in
//                          the chords2 vocabulary (the scorer maps it down itself, ts/chords2/eval), confidence 1.
//   bassNotes              the lowest line as played: the bass instrument's notes, or (piano only) the left hand's
//                          lowest note of every strike. start = the placed onset (+-1 ms, check.ts).
//   chords2.segments[]     per chord: pcs (every pitch class sounding in it, = the template of its quality for its 9th
//                          form, plus the bass: check.ts compares with the rendered notes), rh (the right hand's pitch
//                          classes), form (9th chords), pair (the other reading of an identical-note pair, ts/chords2/
//                          identicalPairs.ts IDENTICAL_PAIRS, and the stage it appears in), rows (the truth-table rows
//                          this segment is the X of: id, truth with its bass, candidate, conflict).
//   chords2.notes[]        every note: part rh / lh / bass, midi, velocity, t, end, seg.
//   chords2.variant/synth  name, set, stage, variation, seed, split, heldOut, piano, bass; the drawn params.
// Synthetic only: no recording is ever written here.

import { IDENTICAL_PAIRS, OTHER_ROWS, TRUTH_ROWS } from '../../ts/chords2/identicalPairs';
import { suffix, type Stage } from '../../ts/chords2/vocab';
import { chordName, chordPcs, notePc, parseChord2, SHARP, transposeChord, upperName, type Chord2 } from './chordName';
import type { prepareC2 } from './render';
import type { C2SynthParams, C2Variant } from './variants';
import { handPcs } from './voicing';

export const CHORDS2_SYNTH_VERSION = 'chords2-synth-1';

export interface TruthChord {
  start: number;
  end: number;
  root: string;
  quality: string;
  originalQuality: string;
  bass: string | null;
  text: string;
  confidence: number;
}

export interface SegmentTruth {
  start: number;
  end: number;
  text: string;
  pcs: number[];
  rh: number[];
  form?: string;
  pair?: { other: string; stage: Stage };
  rows?: { id: string; truth: string; candidate: string | null; conflict: boolean | null }[];
}

export interface Chords2TruthFile {
  format: 'band-sheets-analysis';
  version: 1;
  source: { kind: 'synthetic'; durationSec: number; click: false; leadInSec: number; audioSec: number };
  analyzer: { name: 'truth'; version: string; methods: string[] };
  beats: { t: number; downbeat: boolean; bar: number; beat: number }[];
  timeSignature: { num: 4; den: 4; confidence: 1 };
  key: { tonic: string; mode: 'major' | 'minor'; confidence: 1 };
  sections: { start: number; end: number; label: string }[];
  chords: TruthChord[];
  bassNotes: { start: number; end: number; midi: number; confidence: 1 }[];
  chords2: {
    variant: Omit<C2Variant, 'name'> & { name: string; stage: Stage };
    synth: C2SynthParams;
    sectionKinds: { label: string; kind: string }[];
    segments: SegmentTruth[];
    notes: { part: string; midi: number; velocity: number; t: number; end: number; seg: number }[];
    cutNotes: number;
  };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The other reading of an identical-note pair, or null. */
export function pairOther(c: Chord2): { other: Chord2; stage: Stage } | null {
  for (const p of IDENTICAL_PAIRS) {
    if (c.quality === p.a) return { other: { root: (c.root + p.offset) % 12, quality: p.b, bass: null }, stage: p.stage };
    if (c.quality === p.b) return { other: { root: (c.root - p.offset + 12) % 12, quality: p.a, bass: null }, stage: p.stage };
  }
  return null;
}

/** A truth-table row's X in key k: truth with its bass, candidate. */
export function rowTruth(id: string, k: number): { truth: string; candidate: string | null; conflict: boolean | null } {
  const t = TRUTH_ROWS.find((r) => r.id === id);
  if (t) {
    const c = transposeChord({ ...parseChord2(t.truth), bass: null }, k);
    const bass = (notePc(t.bass) + k) % 12;
    return { truth: chordName({ ...c, bass: bass === c.root ? null : bass }), candidate: upperName(transposeChord(parseChord2(t.candidate), k)), conflict: t.conflict };
  }
  const o = OTHER_ROWS.find((r) => r.id === id);
  if (!o) throw new Error(`unknown truth-table row ${id}`);
  return { truth: chordName(transposeChord(parseChord2(o.truth), k)), candidate: null, conflict: null };
}

export function buildChords2Truth(v: C2Variant, prep: ReturnType<typeof prepareC2>, audioSec: number): Chords2TruthFile {
  const { params: p, chart, placed, durationSec } = prep;
  const sec = (beat: number) => r6(p.leadSec + (beat * 60) / p.bpm);
  const chords: TruthChord[] = chart.chords.map((c) => ({
    start: sec(c.beat),
    end: sec(c.beat + c.beats),
    root: SHARP[c.chord.root],
    quality: c.chord.quality,
    originalQuality: c.chord.quality,
    bass: c.chord.bass === null ? null : SHARP[c.chord.bass],
    text: c.text,
    confidence: 1,
  }));
  const segments: SegmentTruth[] = chart.chords.map((c, i) => {
    const pr = pairOther(c.chord);
    return {
      start: chords[i].start,
      end: chords[i].end,
      text: c.text,
      pcs: chordPcs(c.chord, c.form === 'no5' ? 1 : 0),
      rh: [...handPcs(c.chord, c.form).rh].sort((a, b) => a - b),
      ...(c.form ? { form: c.form } : {}),
      ...(pr ? { pair: { other: `${SHARP[pr.other.root]}${suffix(pr.other.quality)}`, stage: pr.stage } } : {}),
      ...(c.rows ? { rows: c.rows.map((id) => ({ id, ...rowTruth(id, v.set === 'pair' ? p.transpose : 0) })) } : {}),
    };
  });
  // the lowest line: the bass instrument, else the lowest left-hand note of each strike
  const bassLine = v.bass !== null ? placed.filter((n) => n.part === 'bass') : placed.filter((n) => n.part === 'lh' && !placed.some((m) => m.part === 'lh' && m.at === n.at && m.midi < n.midi));
  return {
    format: 'band-sheets-analysis',
    version: 1,
    source: { kind: 'synthetic', durationSec: r6(durationSec), click: false, leadInSec: p.leadSec, audioSec: r6(audioSec) },
    analyzer: { name: 'truth', version: CHORDS2_SYNTH_VERSION, methods: ['chords2-synth'] },
    beats: Array.from({ length: chart.bars * 4 }, (_, b) => ({ t: sec(b), downbeat: b % 4 === 0, bar: Math.floor(b / 4), beat: b % 4 })),
    timeSignature: { num: 4, den: 4, confidence: 1 },
    key: { tonic: SHARP[chart.key.tonic], mode: chart.key.minor ? 'minor' : 'major', confidence: 1 },
    sections: chart.sections.map((s) => ({ start: sec(s.startBar * 4), end: sec((s.startBar + s.bars) * 4), label: s.label })),
    chords,
    bassNotes: bassLine.map((n) => ({ start: n.t, end: n.end, midi: n.midi, confidence: 1 })),
    chords2: {
      variant: { ...v, stage: chart.stage },
      synth: { ...p },
      sectionKinds: chart.sections.map((s) => ({ label: s.label, kind: s.kind })),
      segments,
      notes: placed.map((n) => ({ part: n.part, midi: n.midi, velocity: n.velocity, t: n.t, end: n.end, seg: n.seg })),
      cutNotes: placed.filter((n) => n.cut).length,
    },
  };
}
