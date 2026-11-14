// Spike 6 T2: truth JSON of a synthetic bass variant (docs/audio-spike6-plan.md section 4 "区間ごとの正解は 2 つ").
//
// <name>.truth.json is an AnalysisResult (render/types.ts) with
//   beats, sections, chords   from the main score's truth (B1+) or the bass score's (B0): render/truth.ts buildTruth,
//                             times from the MIDI. chords[].bass = the WRITTEN bass (`/X` of the chart, null = root):
//                             truth 1, "譜のベース".
//   melody, drums             B2+ only (the main score's melody and drum tracks).
//   bassNotes                 every bass note as played: start = its placed onset (s, = the audible onset in this wav,
//                             +-1 ms, check.ts; jitter included), end = its note-off (half the written length for
//                             ghost / muted notes), midi, confidence 1.
//   bass.segments             per chord: start, end, text, written (bass ?? root, a sharp name), played = MIDI of the
//                             HEAD note sounding at the chord's start (truth 2, "弾いたベース"; equal to `written` in
//                             pitch class by construction, check.ts), playedT = that note's onset.
//   bass.info                 what a user would know: bpm, ts, startSec (bar 0 head).
//   bass.sectionKinds         per chart section: plain / inversion / cliche / clicheMin / descending / pedal.
//   bass.variant, bass.synth  name, style, level 'B0'..'B3', seed, timbre, split, heldOut; the drawn params.
//   bass.cutNotes             notes longer than their sample (they end with the sample; 0 expected, see timbres.ts).
// Synthetic only: no recording is ever written here.

import type { AnalysisNote, AnalysisResult } from '../types';
import type { BassSynthParams, BassVariant } from './variants';
import { levelLabel } from './variants';
import type { prepareBass } from './render';
import { GM_BASS_PROGRAM } from './timbres';
import type { SectionKind } from './progressions';

export const BASS_SYNTH_VERSION = 'bass-synth-1';
export const BASS_TRACK = 'Bass';
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface BassSegmentTruth {
  start: number;
  end: number;
  text: string;
  written: string;
  played: number;
  playedT: number;
}

export interface BassTruthFile extends AnalysisResult {
  bassNotes: AnalysisNote[];
  bass: {
    info: { bpm: number; ts: [number, number]; startSec: number };
    segments: BassSegmentTruth[];
    sectionKinds: { label: string; kind: SectionKind }[];
    variant: { name: string; style: string; level: string; seed: number; timbre: string; split: string; heldOut: boolean };
    synth: BassSynthParams;
    cutNotes: number;
  };
}

export function buildBassTruth(v: BassVariant, prep: ReturnType<typeof prepareBass>, audioSec: number): BassTruthFile {
  const { params: p, song, btruth, main, placed } = prep;
  const base: AnalysisResult = structuredClone(main?.truth ?? btruth);
  if (!main) delete base.melody; // the bass score's only track is the bass, not a melody
  base.source = { ...base.source, audioSec: Math.round(audioSec * 1e6) / 1e6 };
  base.analyzer = { name: 'truth', version: BASS_SYNTH_VERSION, methods: ['bass-synth'] };
  base.key = { tonic: SHARP[song.key], mode: 'major', confidence: 1 };
  if (base.render) {
    base.render = {
      ...base.render,
      tracks: main ? [...base.render.tracks, BASS_TRACK] : [BASS_TRACK],
      programs: { ...(main ? base.render.programs : {}), [BASS_TRACK]: GM_BASS_PROGRAM },
    };
  }
  const chords = base.chords ?? [];
  const heads = placed.filter((n) => n.note.role === 'head');
  if (heads.length !== chords.length) throw new Error(`${v.name}: ${heads.length} head notes for ${chords.length} chords`);
  const segments = chords.map((c, i) => ({
    start: c.start,
    end: c.end,
    text: c.text ?? '',
    written: c.bass ?? c.root,
    played: heads[i].note.midi,
    playedT: heads[i].t,
  }));
  return {
    ...base,
    bassNotes: placed.map((n) => ({ start: n.t, end: n.end, midi: n.note.midi, confidence: 1 })),
    bass: {
      info: { bpm: p.bpm, ts: song.timeline.ts, startSec: p.leadSec },
      segments,
      sectionKinds: song.timeline.sections.map((s, i) => ({ label: s.label, kind: song.kinds[i] })),
      variant: { name: v.name, style: v.style, level: levelLabel(v), seed: v.seed, timbre: v.timbre, split: v.split, heldOut: v.heldOut },
      synth: { ...p },
      cutNotes: placed.filter((n) => n.cut).length,
    },
  };
}
