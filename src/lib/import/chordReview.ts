import type { AnalysisProgress } from '../../analysis/types';
import type { TsAnalysisResult } from '../analysis/chords/result';
import { dashes, parseDashLine, type DashMeter } from '../dashChart';
import { parseKey } from '../keys';
import { TEMPO_MAX, TEMPO_MIN } from '../meta';
import { serializeSong, UNTITLED } from '../serializeSong';
import type { ChartSection, LyricLine } from '../song';
import { transposeKey } from '../transpose';
import {
  chordDraftSong,
  draftMeter,
  draftTempo,
  type ChordDraft,
  type ChosenChords,
  type DraftBar,
  type TempoFactor,
} from './chordDraft';
import { markChordDraft, type DraftMarkInfo } from './draftMarks';

/**
 * Pure helpers for the import screens S1 / S3 (docs/audio-integration-plan.md §4, §3.4).
 * Everything here is display / review state only: nothing is stored, the song text is
 * built once by `draftSongText` when the user presses 「この内容で曲を作る」.
 */

// ---------------------------------------------------------------- S1 progress

/** The six steps shown to the user, each covering consecutive analyzer stages (in order). */
export const IMPORT_STEPS: readonly ImportStep[] = [
  { label: '音声を読み込む', stages: ['decode'] },
  { label: '音を変換する', stages: ['resample', 'load'] },
  { label: '拍と小節の頭を探す', stages: ['beats'] },
  {
    label: 'コードを調べる',
    stages: ['chroma', 'chords', 'downbeat', 'merge'],
  },
  { label: 'セクションに分ける', stages: ['sections'] },
  { label: 'キーを調べる', stages: ['key', 'keytrack', 'chords2', 'merge2'] },
];

export type StepState = 'done' | 'now' | 'wait';

export interface ImportProgressView {
  steps: { label: string; state: StepState }[];
  /** 1-based number of the running step (= steps.length when all are done). */
  current: number;
  /** 0..1 over the analyzer's stages. */
  fraction: number;
}

export type ImportStep = { label: string; stages: readonly string[] };

/**
 * Step states for the last progress event (null = nothing finished yet). `steps` cover the kind's analyzer
 * stages in order (default: the chord import's six steps).
 */
export function importProgressView(
  p: Pick<AnalysisProgress, 'done' | 'total'> | null,
  steps: readonly ImportStep[] = IMPORT_STEPS,
): ImportProgressView {
  const total = p?.total ?? steps.reduce((n, s) => n + s.stages.length, 0);
  const done = Math.max(0, Math.min(p?.done ?? 0, total));
  let end = 0;
  let current = steps.length;
  const view = steps.map((s, i) => {
    end += s.stages.length;
    const state: StepState =
      done >= end ? 'done' : done >= end - s.stages.length ? 'now' : 'wait';
    if (state === 'now' && current === steps.length) current = i + 1;
    return { label: s.label, state };
  });
  return { steps: view, current, fraction: total > 0 ? done / total : 0 };
}

// ---------------------------------------------------------------- formatting

/** 222.4 → "3:42"; NaN / negative → "0:00". */
export function formatClock(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 222.4 → "3 分 42 秒", 42 → "42 秒". */
export function formatDurationJa(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** Bytes → "38.2 MB" / "512 KB" (decimal units, like the OS file dialogs). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// ---------------------------------------------------------------- S3 candidates

export interface TempoCandidate {
  factor: TempoFactor;
  tempo: number;
}

/** Half / as analysed / double tempo, each with the tempo it would write. */
export function tempoCandidates(result: TsAnalysisResult): TempoCandidate[] {
  return ([0.5, 1, 2] as const).map((factor) => ({
    factor,
    tempo: draftTempo(result, factor),
  }));
}

export function clampTempo(n: number): number {
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(n)));
}

export interface KeyCandidate {
  /** As written in `{key:}` ("Bb", "Em"): fewest accidentals. */
  key: string;
  /** Why it is offered. */
  note: 'best' | 'relative' | 'section';
}

function normalizeKey(tonic: string, mode: 'major' | 'minor'): string | null {
  const k = tonic + (mode === 'minor' ? 'm' : '');
  return parseKey(k) ? transposeKey(k, 0) : null;
}

/**
 * Key candidates: the analyzer's global key, its relative major / minor, then the
 * other keys of the per-bar key runs (in order). No duplicates; empty when the
 * analyzer found no key.
 */
export function keyCandidates(result: TsAnalysisResult): KeyCandidate[] {
  const out: KeyCandidate[] = [];
  const add = (key: string | null, note: KeyCandidate['note']) => {
    if (key !== null && !out.some((c) => c.key === key))
      out.push({ key, note });
  };
  const k = result.key;
  const best = k ? normalizeKey(k.tonic, k.mode) : null;
  if (best === null) return out;
  add(best, 'best');
  const minor = best.endsWith('m');
  add(
    minor ? transposeKey(best.slice(0, -1), 3) : transposeKey(`${best}m`, -3),
    'relative',
  );
  for (const run of result.keys ?? [])
    add(normalizeKey(run.tonic, run.mode), 'section');
  return out;
}

/** The analyzer's own key as written (the first candidate), or undefined. */
function analyzerKey(result: TsAnalysisResult): string | undefined {
  return keyCandidates(result)[0]?.key;
}

// ---------------------------------------------------------------- S3 review state

export interface ReviewState {
  title: string;
  tempoFactor: TempoFactor;
  tempo: number;
  /** Key for `{key:}` and chord spelling; undefined = the analyzer found none. */
  key: string | undefined;
  downbeatShift: number;
  /** Section index -> name typed by the user (missing = the analyzer's label). */
  sectionNames: Readonly<Record<number, string>>;
  chosen: ChosenChords;
}

export function initialReviewState(
  result: TsAnalysisResult,
  title: string,
): ReviewState {
  return {
    title,
    tempoFactor: 1,
    tempo: draftTempo(result, 1),
    key: analyzerKey(result),
    downbeatShift: 0,
    sectionNames: {},
    chosen: {},
  };
}

/** Whether the user changed anything on S3 (「やめて戻る」 asks only then). */
export function reviewChanged(a: ReviewState, b: ReviewState): boolean {
  // An emptied section name falls back to the analyzer's: not an edit.
  const named = (x: Readonly<Record<number, string>>) =>
    Object.fromEntries(
      Object.entries(x).filter(([, v]) => cleanDirectiveValue(v) !== ''),
    );
  const same = (x: object, y: object) =>
    JSON.stringify(Object.entries(x).sort()) ===
    JSON.stringify(Object.entries(y).sort());
  return !(
    a.title === b.title &&
    a.tempoFactor === b.tempoFactor &&
    a.tempo === b.tempo &&
    a.key === b.key &&
    a.downbeatShift === b.downbeatShift &&
    same(named(a.sectionNames), named(b.sectionNames)) &&
    same(a.chosen, b.chosen)
  );
}

/** Downbeat shift range: less than one bar either way. */
export function shiftLimit(result: TsAnalysisResult): number {
  return draftMeter(result).num - 1;
}

/** Characters that would break a `{…}` directive line. */
function cleanDirectiveValue(s: string): string {
  return s.replace(/[{}\r\n]/g, '').trim();
}

/** The draft for the current review state, section names applied. */
export function reviewDraft(
  result: TsAnalysisResult,
  s: ReviewState,
): ChordDraft {
  const draft = chordDraftSong(result, {
    title: cleanDirectiveValue(s.title) || UNTITLED,
    downbeatShift: s.downbeatShift,
    tempo: s.tempo,
    chosen: s.chosen,
    tempoFactor: s.tempoFactor,
    key: s.key,
  });
  const chart: ChartSection[] = draft.song.chart.map((sec, i) => {
    const name = cleanDirectiveValue(s.sectionNames[i] ?? '');
    return name === '' ? sec : { ...sec, label: name };
  });
  return { ...draft, song: { ...draft.song, chart } };
}

/** The song text 「この内容で曲を作る」 writes (draft marks included). */
export function draftSongText(
  result: TsAnalysisResult,
  s: ReviewState,
  info: DraftMarkInfo,
): string {
  return serializeSong(markChordDraft(reviewDraft(result, s).song, info));
}

// ---------------------------------------------------------------- S3 chart view

export interface ReviewToken {
  /** As written, `?` included. */
  chord: string;
  /** Sixteenths from the bar start. */
  start: number;
  /** `-` / `=` written after the chord. */
  dashes: string;
  /** Index in `result.chords` (the key of `chosen`), or null (a no-chord gap). */
  id: number | null;
  lowConfidence: boolean;
}

export interface ReviewBar {
  /** 0-based bar number of the draft. */
  index: number;
  startSec: number;
  /** Dashes before the first chord (continuing the previous bar's chord). */
  leading: string;
  tokens: ReviewToken[];
}

export interface ReviewSection {
  /** Index in the draft's chart (the key of `sectionNames`). */
  index: number;
  label: string;
  barCount: number;
  startSec: number;
  /** Lines of up to 4 bars, exactly as they are written. */
  lines: ReviewBar[][];
}

/** Which analyzer chord a written chord stands for (by text, nearest start; a chord continued from the previous bar). */
function tokenId(
  bars: readonly DraftBar[],
  b: number,
  chord: string,
  start: number,
): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const c of bars[b]?.chords ?? []) {
    if (c.chord !== chord) continue;
    const d = Math.abs(c.start - start);
    if (d < bestD) {
      bestD = d;
      best = c.id;
    }
  }
  if (best !== null || start > 0) return best;
  // A bar with no analyzer chord (written N.C.) is not linked to anything.
  if ((bars[b]?.chords.length ?? 0) === 0) return null;
  // Otherwise only a continuation of the previous bar's last chord.
  const prev = bars[b - 1]?.chords.at(-1);
  return prev !== undefined && prev.chord === chord ? prev.id : null;
}

/**
 * The draft's chart for display: sections -> lines -> bars -> chords, read back
 * from the written dash lines (so what is shown is what will be written), each
 * chord linked to its analyzer chord for the candidates.
 */
export function reviewSections(
  draft: ChordDraft,
  meter: DashMeter,
): ReviewSection[] {
  let bar = 0;
  return draft.song.chart.map((sec, index) => {
    const startBar = bar;
    const lines: ReviewBar[][] = [];
    for (const line of sec.lines) {
      if (!('segments' in line)) continue;
      const parsed = parseDashLine(line as LyricLine, meter);
      lines.push(
        parsed.bars.map((pb) => {
          const b = bar++;
          const db = draft.bars[b];
          return {
            index: b,
            startSec: db?.startSec ?? 0,
            leading: dashes(pb.leading),
            tokens: pb.chords.map((c) => ({
              chord: c.chord,
              start: c.start,
              dashes: dashes(c.length),
              id: tokenId(draft.bars, b, c.chord, c.start),
              lowConfidence: c.chord.endsWith('?'),
            })),
          };
        }),
      );
    }
    return {
      index,
      label: sec.label,
      barCount: bar - startBar,
      startSec: draft.bars[startBar]?.startSec ?? 0,
      lines,
    };
  });
}

/** Number of written chords still carrying `?`. */
export function lowConfidenceCount(sections: readonly ReviewSection[]): number {
  let n = 0;
  for (const s of sections)
    for (const l of s.lines)
      for (const b of l) for (const t of b.tokens) if (t.lowConfidence) n++;
  return n;
}

/** The bar playing at `t` seconds, or null (before the first / after the last bar). */
export function barAtTime(bars: readonly DraftBar[], t: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bars[mid];
    if (t < b.startSec) hi = mid - 1;
    else if (t >= b.endSec) lo = mid + 1;
    else return mid;
  }
  return null;
}
