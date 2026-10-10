// Ground truth for a synthetic render (docs/audio-spike0-plan.md, T5;
// design decision 7), plus building the score that gets rendered.
//
// Score (`buildScoreTex`): tracks Drums → Piano → melody part, per mix. The
// drum track MUST be first: alphaTab applies `\tf` (shuffle) per master bar,
// but only to every bar when the first track carries it (otherwise only the
// bars that state `\tf` themselves). A straight variant rewrites every `\tf`
// to `\tf none`; the tempo is the variant's.
//
// Truth (`buildTruth`), all times in seconds = tick / 960 × 60 / tempo:
// - beats / downbeats: master bar start ticks + time signature;
// - sections: master bar `section` markers (must match the chart order);
// - melody notes and drum hits: the generated MIDI's note-on/off, NOT the
//   notation, so shuffle timing matches the audio exactly; drum keys are
//   named back via the app's `DRUM_ARTICULATIONS`;
// - chords: the ChordTimeline at beat positions (`parseChordSymbol`);
// - swing only when the score actually has a triplet feel;
// - leadInSec (variant): every time above is shifted by it (silence before bar 0);
// - durationSec: the end of the last master bar (+ lead-in), NOT the wav
//   length (the wav has a release tail; `source.audioSec` is its length).
// Anything inconsistent (track order, more than one tempo, sections, bar
// counts, a padded/missing bar in any track) throws a Japanese Error.

import * as alphaTab from '@coderline/alphatab';
import type { midi as alphaMidi, model } from '@coderline/alphatab';
import { melodyParts } from '../../../src/lib/melodyPart';
import { DRUM_ARTICULATIONS, partsToAlphaTex } from '../../../src/lib/partsToAlphaTex';
import { isDrumPart, type Part, type Song } from '../../../src/lib/song';
import { parseChordSymbol } from './chordSymbol';
import type {
  AnalysisChord,
  AnalysisDrumHit,
  AnalysisNote,
  AnalysisResult,
  ChordTimeline,
  Variant,
} from './types';

/** Track name of the generated piano accompaniment. */
export const PIANO_TRACK = 'Piano';

/** alphaTab / MIDI ticks per quarter note. */
const QUARTER_TICKS = 960;

const ANALYZER = { name: 'ground-truth', version: '0.1.0', methods: [] };

/** alphaTab's runtime version (exported as `meta.version`, but not typed). */
export const ALPHATAB_VERSION: string =
  (alphaTab as unknown as { meta?: { version?: string } }).meta?.version ?? 'unknown';

/** GM programs (design decision 3): piano 0, melody 65 (alto sax, for the voice). */
export const PROGRAMS = { piano: 0, melody: 65 } as const;

/**
 * Sets the instruments of a score built by `buildScoreTex` (decision 3);
 * the drum track keeps its percussion channel. Call before `generateMidi`.
 */
export function setPrograms(score: model.Score): void {
  for (const t of score.tracks) {
    if (t.staves[0].isPercussion) continue;
    t.playbackInfo.program = t.name === PIANO_TRACK ? PROGRAMS.piano : PROGRAMS.melody;
  }
}

/**
 * The alphaTex document to render for a variant: Drums (unless mix is
 * 'piano'), Piano (`pianoBody`, e.g. `pianoPartBody(timeline)`), then the
 * melody part (`melodyParts(song)[0]`, mix 'full' only).
 */
export function buildScoreTex(song: Song, pianoBody: string, variant: Variant): string {
  const parts: Part[] = [];
  if (variant.mix !== 'piano') {
    const drums = song.parts.find(isDrumPart);
    if (!drums) throw new Error(`「${variant.name}」にはドラムのパートが要りますが、曲にありません`);
    parts.push(drums);
  }
  parts.push({ name: PIANO_TRACK, body: pianoBody });
  if (variant.mix === 'full') {
    const melody = melodyParts(song)[0];
    if (!melody) throw new Error(`「${variant.name}」にはメロディのパートが要りますが、曲にありません`);
    if (melody.name === PIANO_TRACK) {
      throw new Error(`メロディのパートの名前が "${PIANO_TRACK}" です（伴奏のトラック名と重なります）`);
    }
    parts.push(melody);
  }
  const final =
    variant.swing === 'none'
      ? parts.map((p) => ({ ...p, body: p.body.replace(/^(\s*)\\tf\s+\S+/gm, '$1\\tf none') }))
      : parts;
  return partsToAlphaTex({
    ...song,
    meta: { ...song.meta, tempo: variant.tempo },
    parts: final,
  });
}

/** Imports an alphaTex document (throws alphaTab's error on bad input). */
export function importScore(tex: string, settings = new alphaTab.Settings()): model.Score {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, settings);
  return importer.readScore();
}

/**
 * The MIDI alphaTab plays for `score` (the same file `AlphaSynth` renders).
 * Set `track.playbackInfo.program` etc. BEFORE calling this.
 */
export function generateMidi(score: model.Score, settings = new alphaTab.Settings()): alphaMidi.MidiFile {
  const file = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(file);
  new alphaTab.midi.MidiFileGenerator(score, settings, handler).generate();
  return file;
}

export interface TruthInput {
  /** The imported score that is rendered, tracks in render order (Drums first). */
  score: model.Score;
  /** `generateMidi(score)` — the MIDI the audio is synthesized from. */
  midi: alphaMidi.MidiFile;
  timeline: ChordTimeline;
  variant: Variant;
  /** `song.meta.key` ("C", "F#m", "Bb"…); omitted from the truth when absent. */
  key?: string;
  sampleRate: number;
  /** Sound font file name, e.g. "sonivox.sf2". */
  soundFont: string;
  /** Length of the rendered wav in seconds (recorded as `source.audioSec`). */
  audioSec?: number;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

const DRUM_BY_KEY = new Map<number, string>(DRUM_ARTICULATIONS.map(([name, key]) => [key, name]));

export function buildTruth(input: TruthInput): AnalysisResult {
  const { score, midi, timeline, variant } = input;
  const tracks = score.tracks;
  const percussion = tracks.filter((t) => t.staves[0].isPercussion);
  if (percussion.length > 1) throw new Error('ドラムのトラックが 2 つ以上あります');
  if (percussion.length === 1 && tracks[0] !== percussion[0]) {
    throw new Error(
      `ドラムのトラックが先頭にありません（${tracks.map((t) => t.name).join(' → ')}）。シャッフルが全小節に効くよう、ドラムを先頭にしてください`,
    );
  }
  const melodyTracks = tracks.filter((t) => !t.staves[0].isPercussion && t.name !== PIANO_TRACK);
  if (melodyTracks.length > 1) {
    throw new Error(`メロディのトラックが 2 つ以上あります（${melodyTracks.map((t) => t.name).join(', ')}）`);
  }

  // ---- tempo: exactly one, equal to the variant's ----
  const T = alphaTab.midi.MidiEventType;
  if (midi.division !== QUARTER_TICKS) throw new Error(`MIDI の分解能が ${midi.division} です（960 のはず）`);
  if (midi.tickShift !== 0) throw new Error(`MIDI の tickShift が ${midi.tickShift} です（弱起の小節は扱えません）`);
  const tempos = midi.events.filter((e) => e.type === T.TempoChange) as alphaMidi.TempoChangeEvent[];
  const automations = score.masterBars.flatMap((mb) => mb.tempoAutomations);
  const tempo = score.tempo;
  if (
    tempos.length !== 1 ||
    tempos[0].tick !== 0 ||
    tempos[0].beatsPerMinute !== tempo ||
    automations.some((a) => a.value !== tempo)
  ) {
    throw new Error(
      `テンポが 1 つではありません（MIDI: ${tempos.map((e) => `${e.beatsPerMinute}@${e.tick}`).join(', ')}）`,
    );
  }
  if (tempo !== variant.tempo) {
    throw new Error(`楽譜のテンポ ${tempo} が変化形「${variant.name}」のテンポ ${variant.tempo} と違います`);
  }
  const leadIn = variant.leadInSec ?? 0;
  if (!(leadIn >= 0)) throw new Error(`leadInSec ${leadIn} が負です`);
  const sec = (tick: number) => round(leadIn + ((tick / QUARTER_TICKS) * 60) / tempo);

  // ---- bars, time signature, beats ----
  const masterBars = score.masterBars;
  if (masterBars.length !== timeline.bars) {
    throw new Error(`楽譜の小節数 ${masterBars.length} がコードの時刻表の小節数 ${timeline.bars} と違います`);
  }
  for (const track of tracks) {
    const bars = track.staves[0].bars;
    const padded = bars.findIndex((b) => b.isEmpty);
    if (bars.length !== masterBars.length || padded >= 0) {
      throw new Error(
        `トラック「${track.name}」の小節数が足りません（${padded >= 0 ? padded : bars.length} 小節。全体は ${masterBars.length} 小節）`,
      );
    }
  }
  const [num, den] = [masterBars[0].timeSignatureNumerator, masterBars[0].timeSignatureDenominator];
  if (masterBars.some((mb) => mb.timeSignatureNumerator !== num || mb.timeSignatureDenominator !== den)) {
    throw new Error('途中で拍子が変わる曲は扱えません');
  }
  if (num !== timeline.ts[0] || den !== timeline.ts[1]) {
    throw new Error(`楽譜の拍子 ${num}/${den} とコードの時刻表の拍子 ${timeline.ts.join('/')} が違います`);
  }
  const beatTicks = (QUARTER_TICKS * 4) / den;
  const barTicks = beatTicks * num;
  masterBars.forEach((mb, i) => {
    if (mb.start !== i * barTicks || mb.calculateDuration() !== barTicks) {
      throw new Error(`${i + 1} 小節目の長さ・位置が拍子と合いません`);
    }
  });
  const endTick = masterBars.length * barTicks;
  const beats = masterBars.flatMap((mb, bar) =>
    Array.from({ length: num }, (_, beat) => ({
      t: sec(mb.start + beat * beatTicks),
      downbeat: beat === 0,
      bar,
      beat,
    })),
  );

  // ---- sections ----
  const marked = masterBars.filter((mb) => mb.section !== null);
  const sectionText = (list: { label: string; bar: number }[]) =>
    list.map((s) => `${s.label}@${s.bar}`).join(' ');
  const fromScore = marked.map((mb) => ({ label: mb.section!.text, bar: mb.index }));
  const fromChart = timeline.sections.map((s) => ({ label: s.label, bar: s.startBar }));
  if (sectionText(fromScore) !== sectionText(fromChart)) {
    throw new Error(
      `楽譜のセクション（${sectionText(fromScore)}）がコード譜の順（${sectionText(fromChart)}）と違います`,
    );
  }
  const sections = marked.map((mb, i) => ({
    start: sec(mb.start),
    end: sec(i + 1 < marked.length ? marked[i + 1].start : endTick),
    label: mb.section!.text,
  }));

  // ---- chords ----
  const chordTick = (c: { bar: number; beat: number }) => c.bar * barTicks + c.beat * beatTicks;
  const chords: AnalysisChord[] = timeline.chords.map((c, i) => {
    const sym = parseChordSymbol(c.text);
    const next = timeline.chords[i + 1];
    return {
      start: sec(chordTick(c)),
      end: sec(next ? chordTick(next) : endTick),
      root: sym.rootName,
      quality: sym.quality,
      bass: sym.bass === null ? null : c.text.slice(c.text.indexOf('/') + 1),
      text: c.text,
      confidence: 1,
    };
  });

  // ---- melody and drums from the MIDI ----
  const melodyIndex = melodyTracks[0]?.index;
  const drumIndex = percussion[0]?.index;
  const notes: AnalysisNote[] = [];
  const drums: AnalysisDrumHit[] = [];
  const open = new Map<number, number[]>(); // melody key → start ticks (FIFO)
  for (const e of midi.events) {
    if (e.type !== T.NoteOn && e.type !== T.NoteOff) continue;
    const n = e as alphaMidi.NoteEvent;
    if (e.track === drumIndex) {
      if (e.type !== T.NoteOn) continue;
      const inst = DRUM_BY_KEY.get(n.noteKey);
      if (inst === undefined) throw new Error(`ドラムの音番号 ${n.noteKey} が対応表にありません`);
      drums.push({ t: sec(e.tick), inst, strength: round(n.noteVelocity / 127), confidence: 1 });
    } else if (e.track === melodyIndex) {
      const starts = open.get(n.noteKey) ?? [];
      if (e.type === T.NoteOn) {
        starts.push(e.tick);
        open.set(n.noteKey, starts);
      } else {
        const start = starts.shift();
        if (start === undefined) throw new Error(`メロディの音 ${n.noteKey} の終わりに対応する始まりがありません`);
        notes.push({ start: sec(start), end: sec(e.tick), midi: n.noteKey, confidence: 1 });
      }
    }
  }
  if ([...open.values()].some((s) => s.length > 0)) throw new Error('メロディに終わりの無い音があります');
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  drums.sort((a, b) => a.t - b.t || a.inst.localeCompare(b.inst));

  // ---- swing ----
  const F = alphaTab.model.TripletFeel;
  const feels = new Set(masterBars.map((mb) => mb.tripletFeel).filter((f) => f !== F.NoTripletFeel));
  if (variant.swing === 'none' && feels.size > 0) {
    throw new Error(`変化形「${variant.name}」はまっすぐのはずですが、楽譜にシャッフル（\\tf）があります`);
  }
  const kinds = new Set(
    [...feels].map((f) =>
      f === F.Triplet8th || f === F.Dotted8th || f === F.Scottish8th ? ('8' as const) : ('16' as const),
    ),
  );
  if (kinds.size > 1) throw new Error('8 分と 16 分のシャッフルが混ざっています');

  // ---- programs / key ----
  const programs: Record<string, number> = {};
  for (const t of tracks) if (!t.staves[0].isPercussion) programs[t.name] = t.playbackInfo.program;

  const result: AnalysisResult = {
    format: 'band-sheets-analysis',
    version: 1,
    source: {
      kind: 'synthetic',
      durationSec: sec(endTick),
      click: variant.click,
      leadInSec: leadIn,
      ...(input.audioSec === undefined ? {} : { audioSec: round(input.audioSec) }),
    },
    analyzer: ANALYZER,
    render: {
      song: variant.song,
      variant: variant.name,
      tempo,
      tracks: tracks.map((t) => t.name),
      programs,
      sampleRate: input.sampleRate,
      alphaTab: ALPHATAB_VERSION,
      soundFont: input.soundFont,
    },
    beats,
    timeSignature: { num, den, confidence: 1 },
  };
  const key = parseSongKey(input.key);
  if (key) result.key = key;
  result.sections = sections;
  result.chords = chords;
  if (melodyIndex !== undefined) result.melody = { notes };
  if (drumIndex !== undefined) result.drums = drums;
  if (kinds.size === 1) result.swing = { kind: [...kinds][0], confidence: 1 };
  return result;
}

function parseSongKey(key: string | undefined): AnalysisResult['key'] {
  if (key === undefined) return undefined;
  const m = /^([A-G][#b]?)(m?)$/.exec(key);
  if (!m) throw new Error(`キー「${key}」が読めません`);
  return { tonic: m[1], mode: m[2] === 'm' ? 'minor' : 'major', confidence: 1 };
}
