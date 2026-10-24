import type { ResultChord, TsAnalysisResult } from '../analysis/chords/result';
import {
  writeDashChart,
  type DashChordInput,
  type DashMeter,
} from '../dashChart';
import { parseChordLine } from '../parseSong';
import { TEMPO_MAX, TEMPO_MIN } from '../meta';
import { respellChord } from '../transpose';
import type { ChartSection, Song } from '../song';

/**
 * Chord-analysis result -> draft Song (docs/audio-integration-plan.md §3.2).
 * Pure functions; the dash-notation writing is `writeDashChart` (dashChart.ts).
 *
 * Keying of chords for the review screen: a chord is identified by its INDEX
 * in `result.chords` (`DraftBarChord.id`, `ChordCandidates.id`). The index does
 * not depend on the downbeat shift (a shift only regroups beats into bars), so
 * `chosen` (id -> candidate name) stays valid when the shift changes. A chord
 * that spans two bars appears in both bars with the same id. A candidate is
 * referred to by its NAME (e.g. "Bm"), not by its rank.
 */

/** Meter used when the analyzer's time signature is unusable. */
export const FALLBACK_METER: DashMeter = { num: 4, den: 4 };

/**
 * The draft's meter: the analyzer's `timeSignature` (from downbeat tracking;
 * its beats are quarter notes, so `den` is 4). Anything else (non-integer,
 * outside 2..12 beats, den other than 4) falls back to 4/4.
 */
export function draftMeter(result: TsAnalysisResult): DashMeter {
  const ts = result.timeSignature as
    { num?: unknown; den?: unknown } | undefined;
  const num = ts?.num;
  if (
    ts?.den === 4 &&
    typeof num === 'number' &&
    Number.isInteger(num) &&
    num >= 2 &&
    num <= 12
  )
    return { num, den: 4 };
  return FALLBACK_METER;
}

/** Beats (quarter notes) per bar of the draft. */
export function draftBeatsPerBar(result: TsAnalysisResult): number {
  return draftMeter(result).num;
}
export const DEFAULT_TEMPO = 120;
export const DEFAULT_BARS_PER_LINE = 4;

/** chord id (index in `result.chords`) -> chosen candidate name. */
export type ChosenChords = Readonly<Record<number, string>>;

export interface DraftBarChord {
  /** Index in `result.chords` (stable across downbeat shifts). */
  id: number;
  /** Chord text as written: the analyzer's text (with `?` when low confidence), or the chosen candidate's name. */
  chord: string;
  /** True while the written text still carries the analyzer's `?`. */
  lowConfidence: boolean;
  /** Sixteenths from the start of the bar (real-valued; the writer snaps to the grid). */
  start: number;
  /** Sixteenths covered inside this bar (real-valued). */
  length: number;
}

export interface DraftBar {
  /** 0-based bar number of the draft. */
  index: number;
  /** Seconds of the bar's start / end (the end of a trailing bar is extrapolated). */
  startSec: number;
  endSec: number;
  /** Empty = no chord was detected in this bar (written as N.C.). */
  chords: DraftBarChord[];
}

/**
 * Tempo candidate chosen on the review screen: 0.5 = half tempo (every other
 * beat is a beat, bars hold twice the music), 2 = double tempo (a beat is
 * inserted between every two beats). 1 = the analyzer's own beats.
 */
export type TempoFactor = 0.5 | 1 | 2;

export interface BeatGrid {
  /** Beat time (extrapolated by the median interval past the last beat). */
  time: (i: number) => number;
  /** Number of detected beats. */
  count: number;
  /** Median beat interval (s); 0 when fewer than two beats. */
  interval: number;
  /** Index of the first beat of the first bar (after the shift; >= 0). */
  firstBeat: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Beat times and the index of the first downbeat after the tempo factor.
 * Half tempo keeps the beats with the downbeat's parity (so the downbeat stays
 * a beat); double tempo adds a midpoint after every beat but the last.
 */
function tempoBeats(
  result: TsAnalysisResult,
  factor: TempoFactor,
): { t: number[]; phase: number } {
  const t = result.beats.map((b) => b.t);
  const phase = Math.max(
    0,
    result.beats.findIndex((b) => b.downbeat),
  );
  if (factor === 0.5) {
    const parity = phase % 2;
    return {
      t: t.filter((_, i) => i % 2 === parity),
      phase: (phase - parity) / 2,
    };
  }
  if (factor === 2) {
    return {
      t: t.flatMap((x, i) =>
        i < t.length - 1 ? [x, (x + t[i + 1]) / 2] : [x],
      ),
      phase: phase * 2,
    };
  }
  return { t, phase };
}

export function medianBeatInterval(
  result: TsAnalysisResult,
  tempoFactor: TempoFactor = 1,
): number {
  const { t } = tempoBeats(result, tempoFactor);
  return median(t.slice(1).map((x, i) => x - t[i]));
}

/** Beat grid for a downbeat shift (in beats; + = later). The first downbeat is the analyzer's. */
export function beatGrid(
  result: TsAnalysisResult,
  downbeatShift: number,
  tempoFactor: TempoFactor = 1,
): BeatGrid {
  const { t: beats, phase } = tempoBeats(result, tempoFactor);
  const count = beats.length;
  const interval = medianBeatInterval(result, tempoFactor);
  const bpb = draftBeatsPerBar(result);
  let first = phase + Math.round(downbeatShift);
  // A shift to before the first beat: the first whole bar starts one bar later.
  while (first < 0) first += bpb;
  const time = (i: number): number =>
    i < count ? beats[i] : (beats[count - 1] ?? 0) + (i - count + 1) * interval;
  return { time, count, interval, firstBeat: first };
}

/** Seconds of audio before the first bar (dropped from the draft; the UI shows it). */
export function droppedSeconds(
  result: TsAnalysisResult,
  downbeatShift: number,
  tempoFactor: TempoFactor = 1,
): number {
  const g = beatGrid(result, downbeatShift, tempoFactor);
  if (g.count === 0 || g.firstBeat >= g.count) return 0;
  return Math.max(0, g.time(g.firstBeat));
}

/** Analyzer text without its `?` mark. */
export function plainText(text: string): string {
  return text.endsWith('?') ? text.slice(0, -1) : text;
}

function chordText(
  c: ResultChord,
  id: number,
  chosen: ChosenChords | undefined,
): { chord: string; lowConfidence: boolean } {
  const pick = chosen?.[id];
  if (pick !== undefined && pick !== '')
    return { chord: pick, lowConfidence: false };
  return { chord: c.text, lowConfidence: c.text.endsWith('?') };
}

/**
 * Bars of chords for the given downbeat shift (beats; + = the downbeat moves
 * later; counted in the beats of `tempoFactor`). Bars are `draftBeatsPerBar` beats; beats before the first bar are dropped, and a
 * trailing bar with fewer than two beats of audio is not made.
 */
export function barChords(
  result: TsAnalysisResult,
  downbeatShift: number,
  chosen?: ChosenChords,
  tempoFactor: TempoFactor = 1,
): DraftBar[] {
  const g = beatGrid(result, downbeatShift, tempoFactor);
  const BEATS_PER_BAR = draftBeatsPerBar(result);
  const BAR_UNITS = BEATS_PER_BAR * 4; // sixteenths per bar (quarter-note beats)
  const bars: DraftBar[] = [];
  for (
    let b0 = g.firstBeat, index = 0;
    b0 <= g.count - 2;
    b0 += BEATS_PER_BAR, index++
  ) {
    const T = Array.from({ length: BEATS_PER_BAR + 1 }, (_, j) =>
      g.time(b0 + j),
    );
    const sixteenths = (t: number): number => {
      let j = 0;
      while (j < BEATS_PER_BAR - 1 && T[j + 1] <= t) j++;
      const span = T[j + 1] - T[j];
      const frac = span > 0 ? (t - T[j]) / span : 0;
      const beat = Math.min(BEATS_PER_BAR, Math.max(0, j + frac));
      return (beat * BAR_UNITS) / BEATS_PER_BAR;
    };
    const chords: DraftBarChord[] = [];
    result.chords.forEach((c, id) => {
      if (c.end <= T[0] || c.start >= T[BEATS_PER_BAR]) return;
      const start = c.start <= T[0] ? 0 : sixteenths(c.start);
      const end = c.end >= T[BEATS_PER_BAR] ? BAR_UNITS : sixteenths(c.end);
      chords.push({
        id,
        ...chordText(c, id, chosen),
        start,
        length: end - start,
      });
    });
    chords.sort((a, b) => a.start - b.start);
    bars.push({ index, startSec: T[0], endSec: T[BEATS_PER_BAR], chords });
  }
  return bars;
}

export interface ChordCandidate {
  /** Chord name without `?`. */
  name: string;
  /** The analyzer's confidence value (`prob`). NOT a probability that the chord is right; show it as a rough % only. */
  confidence: number;
}

export interface ChordCandidates {
  /** Index in `result.chords` (the key of `chosen`). */
  id: number;
  start: number;
  end: number;
  /** The analyzer's text (with `?` when low confidence). */
  text: string;
  confidence: number;
  lowConfidence: boolean;
  /** Best first; at most `k`. Always contains the analyzer's own chord. */
  candidates: ChordCandidate[];
}

/** Top-k candidates (default 3) per chord, for the review screen. */
export function chordCandidates(
  result: TsAnalysisResult,
  k = 3,
): ChordCandidates[] {
  return result.chords.map((c, id) => {
    const top = plainText(c.text);
    const list: ChordCandidate[] = (c.candidates ?? []).map((x) => ({
      name: x.name,
      confidence: x.prob,
    }));
    if (!list.some((x) => x.name === top))
      list.unshift({ name: top, confidence: c.confidence });
    return {
      id,
      start: c.start,
      end: c.end,
      text: c.text,
      confidence: c.confidence,
      lowConfidence: c.text.endsWith('?'),
      candidates: list.slice(0, Math.max(1, k)),
    };
  });
}

/** Tempo = 60 / median beat interval, rounded and clamped to the app's range. */
export function draftTempo(
  result: TsAnalysisResult,
  tempoFactor: TempoFactor = 1,
): number {
  const iv = medianBeatInterval(result, tempoFactor);
  if (!(iv > 0)) return DEFAULT_TEMPO;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(60 / iv)));
}

/** File name without its extension (the default title). */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim();
}

export interface ChordDraftOptions {
  title: string;
  downbeatShift: number;
  /** Integer BPM; default = `draftTempo(result)`. */
  tempo?: number;
  chosen?: ChosenChords;
  /** Tempo candidate (default 1); bars and the dash chart are rebuilt from the beats. */
  tempoFactor?: TempoFactor;
  /**
   * Key picked on the review screen ("Ab", "F#m"); replaces the analyzer's key
   * in `{key:}` and respells every chord name for it.
   */
  key?: string;
}

export interface ChordDraft {
  song: Song;
  /** The bars the chart was written from (same as `barChords`). */
  bars: DraftBar[];
  tempo: number;
  /** Seconds of audio before the first bar that were dropped. */
  droppedSec: number;
}

/** Section starts as bar numbers: each analyzer boundary moves to the nearest bar start. */
function sectionStarts(
  result: TsAnalysisResult,
  bars: readonly DraftBar[],
): { label: string; startBar: number }[] {
  const out: { label: string; startBar: number }[] = [];
  for (const s of result.sections) {
    let best = 0;
    let bestD = Infinity;
    bars.forEach((b, i) => {
      const d = Math.abs(b.startSec - s.start);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const prev = out[out.length - 1];
    if (prev && prev.startBar >= best) continue; // collapsed onto the previous one
    out.push({ label: s.label, startBar: out.length === 0 ? 0 : best });
  }
  if (out.length === 0) return [{ label: 'A', startBar: 0 }];
  return out;
}

/** The global key as the app writes it ("Gm", "F#"), or undefined. */
function keyText(result: TsAnalysisResult): string | undefined {
  const k = result.key;
  if (!k || !/^[A-G][#b]?$/.test(k.tonic)) return undefined;
  return k.tonic + (k.mode === 'minor' ? 'm' : '');
}

export function chordDraftSong(
  result: TsAnalysisResult,
  opts: ChordDraftOptions,
): ChordDraft {
  const factor = opts.tempoFactor ?? 1;
  const spell = (chord: string) =>
    opts.key === undefined ? chord : respellChord(chord, opts.key);
  const bars = barChords(result, opts.downbeatShift, opts.chosen, factor).map(
    (b) => ({
      ...b,
      chords: b.chords.map((c) => ({ ...c, chord: spell(c.chord) })),
    }),
  );
  const tempo = opts.tempo ?? draftTempo(result, factor);
  const meter = draftMeter(result);

  const inputs: DashChordInput[][] = bars.map((b) =>
    b.chords.map((c) => ({
      chord: c.chord,
      start: c.start,
      length: c.length,
    })),
  );
  // One bar per line keeps the carry-over across bars and lines; then regroup.
  const barTexts = writeDashChart(inputs, meter, 1).map((l) => l.slice(1, -1));

  const starts = sectionStarts(result, bars);
  const chart: ChartSection[] = starts.map((s, i) => {
    const end = starts[i + 1]?.startBar ?? bars.length;
    const lines: ChartSection['lines'] = [];
    for (let b = s.startBar; b < end; b += DEFAULT_BARS_PER_LINE) {
      const text = `|${barTexts.slice(b, Math.min(end, b + DEFAULT_BARS_PER_LINE)).join('|')}|`;
      lines.push({ segments: parseChordLine(text) });
    }
    return { kind: 'verse', label: s.label, lines };
  });

  const key = opts.key ?? keyText(result);
  const song: Song = {
    meta: {
      title: opts.title,
      ...(key !== undefined ? { key } : {}),
      tempo,
      time: `${meter.num}/${meter.den}`,
    },
    chart,
    parts: [],
  };
  return {
    song,
    bars,
    tempo,
    droppedSec: droppedSeconds(result, opts.downbeatShift, factor),
  };
}
