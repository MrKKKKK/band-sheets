import type { HumInput } from '../analysis/hum/types';
import {
  barTicks,
  WHOLE_TICKS,
  type MelodyEvent,
  type TimeSig,
} from '../melody';
import { readSection, writeMelodySection } from '../melodyPart';
import { parsePitch } from '../pitch';
import { sectionLabels } from '../sections';
import type { Song } from '../song';
import { atoms } from '../tuplet';
import type { ImportStep } from './chordReview';
import { humBpmFromSongTempo, type HumNoteCandidates } from './humDraft';
import type { SoundingNote } from './playback';

/**
 * Pure helpers for the humming import screens S2 / S4 (docs/audio-integration-plan.md §4, §3.4). Display and
 * screen state only: the song text is written once, by `insertHumDraft`, when the user presses
 * 「このセクションに下書きを入れる」. Nothing here is stored (plan §5), except the note-name display mode
 * (storage.ts, per device).
 */

// ---------------------------------------------------------------- S2

/** The three steps shown while the humming analysis runs (its analyzer stages in order). */
export const HUM_STEPS: readonly ImportStep[] = [
  { label: '音を読み込む', stages: ['decode'] },
  {
    label: '声の高さを調べる',
    stages: ['validate', 'resample', 'f0', 'level'],
  },
  { label: '音の長さにまとめる', stages: ['notes', 'quantize'] },
];

const beatTicksOf = (ts: TimeSig) => WHOLE_TICKS / ts.den;

/** Ticks from the section's bar 1 beat 1 to bar `bar`, beat `beat` (both 1-based). */
export function firstNoteTick(bar: number, beat: number, ts: TimeSig): number {
  return (bar - 1) * barTicks(ts) + (beat - 1) * beatTicksOf(ts);
}

export interface HumRunSetup {
  /** The song's `{tempo}` (quarter notes per minute). */
  tempo: number;
  ts: TimeSig;
  /** Only orders the pitch candidates (and spells the notes). */
  key?: string;
  /** Where the singing starts (1-based). */
  bar: number;
  beat: number;
}

/**
 * What the hum Worker gets for S2's form, to be sent with `firstNoteAuto: true`: the Worker finds the second of
 * the first sung note itself (`firstNoteSec: 0` is the placeholder, src/analysis/worker/firstNote.ts).
 */
export function humRunInfo(s: HumRunSetup): HumInput {
  return {
    bpm: humBpmFromSongTempo(s.tempo, s.ts),
    ts: [s.ts.num, s.ts.den],
    firstNoteSec: 0,
    firstNoteTick: firstNoteTick(s.bar, s.beat, s.ts),
    ...(s.key ? { key: s.key } : {}),
  };
}

export interface HumTarget {
  label: string;
  /** False: the section cannot be written by the app (read-only / bars no longer fit). */
  writable: boolean;
  /** Notes in the section now (0 for a missing or empty one). */
  notes: number;
  /** Bars in the section now. */
  bars: number;
}

/** The sections a draft can go into, in the song's order, for the melody part `partIndex` (-1: none yet). */
export function humTargets(
  song: Song,
  partIndex: number,
  ts: TimeSig,
): HumTarget[] {
  const body = partIndex >= 0 ? song.parts[partIndex]?.body : undefined;
  const bar = barTicks(ts);
  return sectionLabels(song).map(({ label }) => {
    if (body === undefined) return { label, writable: true, notes: 0, bars: 0 };
    const read = readSection(body, label, ts);
    if (read.status === 'missing')
      return { label, writable: true, notes: 0, bars: 0 };
    if (read.status !== 'ok')
      return { label, writable: false, notes: 0, bars: 0 };
    const ticks = totalTicks(read.events);
    return {
      label,
      writable: true,
      notes: read.events.filter((e) => e.kind === 'note').length,
      bars: Math.ceil(ticks / bar),
    };
  });
}

/**
 * The song with `events` written into section `label` of melody part `partIndex` (-1: a new 「Vocal」 part is
 * added first, as the melody editor does). One call = one song = one `onChange`. Throws the Japanese message of
 * `writeSection` (read-only section, unusable label).
 */
export function insertHumDraft(
  song: Song,
  partIndex: number,
  label: string,
  events: MelodyEvent[],
  ts: TimeSig,
): Song {
  return writeMelodySection(song, partIndex, label, events, ts);
}

// ---------------------------------------------------------------- positions

/** Real start tick of every event (tuplet slots at their actual fractional position). */
export function eventStarts(events: readonly MelodyEvent[]): number[] {
  const out: number[] = new Array(events.length);
  let pos = 0;
  for (const a of atoms(events)) {
    if (a.kind === 'single') {
      out[a.index] = pos;
      pos += a.ticks;
    } else {
      const slot = a.group.span / a.group.n;
      for (let i = a.group.start; i < a.group.end; i++) {
        out[i] = pos;
        pos += slot;
      }
    }
  }
  return out;
}

/** The real length of the events in ticks (tuplets at their real span). */
export function totalTicks(events: readonly MelodyEvent[]): number {
  return atoms(events).reduce(
    (t, a) => t + (a.kind === 'single' ? a.ticks : a.group.span),
    0,
  );
}

/** 1-based bar and beat of a tick; `onBeat` false when it is between beats. */
export function barBeatAt(
  tick: number,
  ts: TimeSig,
): { bar: number; beat: number; onBeat: boolean } {
  const bar = barTicks(ts);
  const beat = beatTicksOf(ts);
  const inBar = tick - Math.floor(tick / bar) * bar;
  return {
    bar: Math.floor(tick / bar) + 1,
    beat: Math.floor(inBar / beat) + 1,
    onBeat: inBar % beat === 0,
  };
}

/** 「1 小節目の 1 拍目」, 「2 小節目の 3 拍目のすこし後」 (between beats). */
export function positionLabel(tick: number, ts: TimeSig): string {
  const p = barBeatAt(tick, ts);
  return `${p.bar} 小節目の ${p.beat} 拍目${p.onBeat ? '' : 'のすこし後'}`;
}

/** Tick of the draft's first note, or null without notes. */
export function firstNoteAt(events: readonly MelodyEvent[]): number | null {
  const starts = eventStarts(events);
  const i = events.findIndex((e) => e.kind === 'note');
  return i < 0 ? null : starts[i];
}

/** 「6 小節目の 1 つ目の音」: event `index`'s bar and its place among the notes starting in that bar. */
export function notePlaceLabel(
  events: readonly MelodyEvent[],
  index: number,
  ts: TimeSig,
): string {
  const starts = eventStarts(events);
  const bar = barTicks(ts);
  const b = Math.floor(starts[index] / bar);
  let nth = 0;
  for (let i = 0; i <= index; i++)
    if (events[i].kind === 'note' && Math.floor(starts[i] / bar) === b) nth++;
  return `${b + 1} 小節目の ${nth} つ目の音`;
}

// ---------------------------------------------------------------- labels

export type NoteNameMode = 'doremi' | 'letter' | 'none';

export const NOTE_NAME_MODES: readonly {
  value: NoteNameMode;
  label: string;
}[] = [
  { value: 'doremi', label: 'ドレミ' },
  { value: 'letter', label: 'C D E' },
  { value: 'none', label: '表示しない' },
];

const DOREMI: Record<string, string> = {
  C: 'ド',
  D: 'レ',
  E: 'ミ',
  F: 'ファ',
  G: 'ソ',
  A: 'ラ',
  B: 'シ',
};

const ACCIDENTAL: Record<string, string> = { '': '', '#': '♯', b: '♭' };

/** 'F#4' → 「ファ♯」 / 「F♯」 / '' (no octave: the staff shows it). '' for 'none' or an unreadable pitch. */
export function noteName(pitch: string, mode: NoteNameMode): string {
  const p = parsePitch(pitch);
  if (!p || mode === 'none') return '';
  const letter = mode === 'doremi' ? DOREMI[p.letter] : p.letter;
  return `${letter}${ACCIDENTAL[p.accidental]}`;
}

/** A pitch candidate named without note names: 「元の高さ」, 「半音上」, 「3 半音下」. */
export function semitoneLabel(semitones: number): string {
  if (semitones === 0) return '元の高さ';
  const n = Math.abs(semitones);
  return `${n === 1 ? '半音' : `${n} 半音`}${semitones > 0 ? '上' : '下'}`;
}

/** A length in beats of the time signature: 「1 拍」「半拍」「1 拍半」「1/4 拍」「1 拍と 3/4」, else 「0.33 拍」. */
export function beatsLabel(ticks: number, ts: TimeSig): string {
  const beats = ticks / beatTicksOf(ts);
  const whole = Math.floor(beats);
  const frac = beats - whole;
  if (frac === 0) return `${whole} 拍`;
  if (frac === 0.5) return whole === 0 ? '半拍' : `${whole} 拍半`;
  if (frac === 0.25 || frac === 0.75)
    return whole === 0 ? `${frac * 4}/4 拍` : `${whole} 拍と ${frac * 4}/4`;
  return `${Number(beats.toFixed(2))} 拍`;
}

/** The whole-draft octave relative to the proposed one: 「そのまま」「1 オクターブ上」「2 オクターブ下」. */
export function octaveLabel(delta: number): string {
  if (delta === 0) return 'そのまま';
  return `${Math.abs(delta)} オクターブ${delta > 0 ? '上' : '下'}`;
}

/** Whole-draft transpose limits (semitones); the octave buttons cover the rest. */
export const TRANSPOSE_LIMIT = 6;

/**
 * The events to DRAW on S4's staff: the note name (by `mode`) as the lyric under each note, with 「?」 on the
 * low-confidence ones. Display only — never written to the song.
 */
export function labelledEvents(
  events: readonly MelodyEvent[],
  candidates: readonly (HumNoteCandidates | null)[],
  mode: NoteNameMode,
): MelodyEvent[] {
  return events.map((e, i) => {
    if (e.kind !== 'note' || !e.pitch) return e;
    const text = `${noteName(e.pitch, mode)}${candidates[i]?.low ? '?' : ''}`;
    return text ? { ...e, lyric: text } : e;
  });
}

/** The event sounding at second `t` (for the moving cursor), or null between / outside notes. */
export function soundingAt(
  notes: readonly SoundingNote[],
  t: number,
): number | null {
  for (const n of notes) {
    if (t < n.start) return null;
    if (t < n.start + n.duration) return n.index;
  }
  return null;
}
