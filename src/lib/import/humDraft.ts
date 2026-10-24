import type { TupletTag } from '../analysis/hum/quantize';
import type {
  HumAnalysisResult,
  QuantizedEvent,
  QuantizedNote,
} from '../analysis/hum/types';
import {
  barTicks,
  isValidTicks,
  WHOLE_TICKS,
  type MelodyEvent,
  type TimeSig,
} from '../melody';
import { MAX_MIDI, MIN_MIDI } from '../melodyInput';
import { formatPitch, midiToPitch } from '../pitch';
import { groupsFitBars, tupletDen } from '../tuplet';

/**
 * Humming-analysis result -> melody draft for ONE section
 * (docs/audio-integration-plan.md §3.2, §3.4, §4 S4). Pure functions; the
 * analyzer is referenced by type only (no analyzer code in this chunk).
 *
 * Model: `result.melody.quantized.events` are ticks from bar 1 beat 1 (whole
 * = 64), one event per note even across a barline. The draft keeps that: a
 * note crossing a barline stays ONE `MelodyEvent` (`serializeMelody` /
 * `splitAtBars` write it as tied pieces and `parseMelody` reads them back as
 * one event), so its candidates are simply that event's candidates.
 *
 * Keying for the review screen: a note is identified by its INDEX in
 * `result.melody.quantized.events` (`HumDraftOk.ids`, `HumNoteCandidates.id`,
 * the keys of `HumChosen`). The index does not depend on octave, transpose,
 * shift or other choices, so choices stay valid when those change. Candidates
 * are referred to by VALUE (analyzer midi; analyzer startTick + ticks).
 *
 * Layout: notes only are taken from the result (its rests are re-derived):
 * chosen position, then the shift; a note now starting before bar 1 is
 * dropped whole; overlaps cut the earlier note at the later onset (a note
 * starting together with another, or inside a triplet, is dropped — a chosen
 * position wins over an unchosen one); a rest fills every gap and the last
 * bar. An analyzer triplet beat (`tuplet: {n: 3}` slots, rests included)
 * moves as one block and has no position alternatives.
 *
 * Tempo: the analyzer's `bpm` counts the time signature's beat (64 / den
 * ticks: eighths in 6/8, halves in 2/2), the song's `{tempo}` counts quarter
 * notes (autoScroll.ts). `HumDraftOk.tempo` / `humBpmFromSongTempo` convert.
 */

/** Notes whose analyzer confidence is below this get the low-confidence mark. */
export const LOW_CONFIDENCE = 0.5;

/** Shifts are whole 16ths (the analyzer's grid step). */
const SHIFT_STEP = WHOLE_TICKS / 16;

const PITCH_ALTERNATIVES = 3;
const POSITION_ALTERNATIVES = 2;

/** What the user picked for one note; absent fields keep the analyzer's reading. */
export interface HumChoice {
  /** Analyzer midi (before octave / transpose), e.g. a pitch candidate's. */
  midi?: number;
  /** Analyzer ticks from bar 1 (before the shift), e.g. a grid candidate's. Ignored on triplet notes. */
  position?: { startTick: number; ticks: number };
}

/** Note id (index in `result.melody.quantized.events`) -> choice. */
export type HumChosen = Readonly<Record<number, HumChoice>>;

export interface HumDraftOptions {
  /** Song key for spelling (sharps / flats); absent = sharps. */
  key?: string;
  /** Whole octaves added to every pitch (`proposeOctave` gives the initial value). */
  octave: number;
  /** Semitones added to every pitch. */
  transpose: number;
  /** 歌い始めのずらし: ticks added to every note (positive = later); a whole number of 16ths. */
  shiftTicks: number;
  chosen: HumChosen;
}

export interface HumDraftOk {
  ok: true;
  /** The analysis time signature; write the section with it. */
  ts: TimeSig;
  events: MelodyEvent[];
  /** Per event: the note id, or null for a rest. */
  ids: (number | null)[];
  /** Notes left out (before bar 1, or overlapped by another note). */
  dropped: number;
  /** Second in the recording of the draft's tick 0 (bar 1 head after the shift). */
  startSec: number;
  /** Song `{tempo}` (quarter notes per minute) of the analysis bpm; for playback. */
  tempo: number;
}

export type HumDraftError =
  /** octave / transpose / shift / a chosen value is not usable */
  | 'invalidOptions'
  /** the result breaks the analyzer's own invariants */
  | 'invalidResult'
  /** the shift moved a triplet across a barline */
  | 'tupletCrossesBar';

export type HumDraft = HumDraftOk | { ok: false; reason: HumDraftError };

type QEvent = QuantizedEvent & TupletTag;

/** One block of the layout: a plain note, or a whole triplet beat. */
interface Item {
  start: number;
  end: number;
  /** The first note id (sort tiebreak). */
  id: number;
  chosen: boolean;
  /** Tuplet block: fixed length, cannot be cut. */
  group: boolean;
  events: MelodyEvent[];
  ids: (number | null)[];
  notes: number;
}

const beatTicks = (ts: TimeSig) => WHOLE_TICKS / ts.den;

/** Song `{tempo}` (quarters) from the analyzer bpm (the time signature's beat). */
function songTempo(bpm: number, ts: TimeSig): number {
  return (bpm * beatTicks(ts)) / (WHOLE_TICKS / 4);
}

/** The bpm to give the analyzer for a song `{tempo}` (quarters) in `ts`. */
export function humBpmFromSongTempo(tempo: number, ts: TimeSig): number {
  return (tempo * (WHOLE_TICKS / 4)) / beatTicks(ts);
}

const isEvenInt = (x: number) => Number.isInteger(x) && x % 2 === 0;

/** The written midi: analyzer midi + octave/transpose, folded by octaves into C3–C7. */
function writtenMidi(
  midi: number,
  opts: Pick<HumDraftOptions, 'octave' | 'transpose'>,
): { midi: number; folded: boolean } {
  let m = midi + 12 * opts.octave + opts.transpose;
  const folded = m < MIN_MIDI || m > MAX_MIDI;
  while (m < MIN_MIDI) m += 12;
  while (m > MAX_MIDI) m -= 12;
  return { midi: m, folded };
}

const spell = (midi: number, key?: string) =>
  formatPitch(midiToPitch(midi, key));

const quantizedEvents = (result: HumAnalysisResult): QEvent[] =>
  result.melody.quantized.events as QEvent[];

const tsOf = (result: HumAnalysisResult): TimeSig => ({
  num: result.melody.quantized.ts[0],
  den: result.melody.quantized.ts[1],
});

function validOptions(opts: HumDraftOptions): boolean {
  if (!Number.isInteger(opts.octave) || !Number.isInteger(opts.transpose))
    return false;
  if (!Number.isInteger(opts.shiftTicks / SHIFT_STEP)) return false;
  return Object.values(opts.chosen).every(
    (c) =>
      (c.midi === undefined || Number.isInteger(c.midi)) &&
      (c.position === undefined ||
        (isEvenInt(c.position.startTick) && isValidTicks(c.position.ticks))),
  );
}

/** The layout blocks of the result (before shift / overlap rules), or null if malformed. */
function items(
  result: HumAnalysisResult,
  opts: HumDraftOptions,
): Item[] | null {
  const evs = quantizedEvents(result);
  const pitch = (id: number, e: QuantizedNote) =>
    spell(writtenMidi(opts.chosen[id]?.midi ?? e.midi, opts).midi, opts.key);
  const out: Item[] = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.tuplet) {
      const { n } = e.tuplet;
      const slots = evs.slice(i, i + n);
      const unit = e.ticks;
      if (
        e.tuplet.slot !== 0 ||
        slots.length !== n ||
        slots.some((s, k) => s.tuplet?.slot !== k || s.ticks !== unit) ||
        !isEvenInt(e.startTick)
      )
        return null;
      const first = i;
      i += n - 1;
      const ids = slots.map((s, k) => (s.kind === 'note' ? first + k : null));
      if (ids.every((x) => x === null)) continue; // a silent beat is just a rest
      const span = tupletDen(n) * unit;
      out.push({
        start: e.startTick,
        end: e.startTick + span,
        id: first,
        chosen: false,
        group: true,
        events: slots.map((s, k) =>
          s.kind === 'note'
            ? {
                kind: 'note',
                pitch: pitch(first + k, s),
                ticks: unit,
                tuplet: { n, slot: k },
              }
            : { kind: 'rest', ticks: unit, tuplet: { n, slot: k } },
        ),
        ids,
        notes: ids.filter((x) => x !== null).length,
      });
      continue;
    }
    if (e.kind !== 'note') continue;
    const pos = opts.chosen[i]?.position;
    const start = pos?.startTick ?? e.startTick;
    const ticks = pos?.ticks ?? e.ticks;
    if (!isEvenInt(start) || !isValidTicks(ticks)) return null;
    out.push({
      start,
      end: start + ticks,
      id: i,
      chosen: pos !== undefined,
      group: false,
      events: [{ kind: 'note', pitch: pitch(i, e), ticks }],
      ids: [i],
      notes: 1,
    });
  }
  return out;
}

/** The melody draft (see the top of the file for the rules). Never throws. */
export function humDraftEvents(
  result: HumAnalysisResult,
  opts: HumDraftOptions,
): HumDraft {
  if (!validOptions(opts)) return { ok: false, reason: 'invalidOptions' };
  const ts = tsOf(result);
  let bar: number;
  try {
    bar = barTicks(ts);
  } catch {
    return { ok: false, reason: 'invalidResult' };
  }
  const all = items(result, opts);
  if (!all) return { ok: false, reason: 'invalidResult' };

  let dropped = 0;
  const shifted: Item[] = [];
  for (const it of all) {
    const start = it.start + opts.shiftTicks;
    if (start < 0) dropped += it.notes;
    else shifted.push({ ...it, start, end: it.end + opts.shiftTicks });
  }
  shifted.sort(
    (a, b) =>
      a.start - b.start || Number(b.chosen) - Number(a.chosen) || a.id - b.id,
  );

  const kept: Item[] = [];
  for (const it of shifted) {
    const prev = kept[kept.length - 1];
    if (prev && it.start < prev.end) {
      if (prev.group || prev.start === it.start) {
        dropped += it.notes;
        continue;
      }
      prev.end = it.start;
      prev.events = [{ ...prev.events[0], ticks: prev.end - prev.start }];
    }
    kept.push(it);
  }

  const events: MelodyEvent[] = [];
  const ids: (number | null)[] = [];
  const rest = (ticks: number) => {
    events.push({ kind: 'rest', ticks });
    ids.push(null);
  };
  let pos = 0;
  for (const it of kept) {
    if (it.start > pos) rest(it.start - pos);
    events.push(...it.events);
    ids.push(...it.ids);
    pos = it.end;
  }
  if (pos % bar !== 0) rest(bar - (pos % bar));

  if (!groupsFitBars(events, bar).ok)
    return { ok: false, reason: 'tupletCrossesBar' };

  const q = result.melody.quantized;
  const tickSec = 60 / (q.bpm * beatTicks(ts));
  return {
    ok: true,
    ts,
    events,
    ids,
    dropped,
    startSec: q.startSec - opts.shiftTicks * tickSec,
    tempo: songTempo(q.bpm, ts),
  };
}

/**
 * The initial octave: the whole-octave move that puts the most notes inside
 * the input range C3–C7, then the smallest move, then the one whose median is
 * nearest C5 (the middle of the range). Analyzer midis (choices ignored); 0
 * for no notes.
 */
export function proposeOctave(result: HumAnalysisResult): number {
  const midis = quantizedEvents(result)
    .filter((e): e is QuantizedNote & TupletTag => e.kind === 'note')
    .map((e) => e.midi)
    .sort((a, b) => a - b);
  if (midis.length === 0) return 0;
  const median = midis[midis.length >> 1];
  const C5 = 72;
  let best = { k: 0, count: -1, move: 0, dist: 0 };
  for (let k = -8; k <= 8; k++) {
    const count = midis.filter(
      (m) => m + 12 * k >= MIN_MIDI && m + 12 * k <= MAX_MIDI,
    ).length;
    const cand = {
      k,
      count,
      move: Math.abs(k),
      dist: Math.abs(median + 12 * k - C5),
    };
    if (
      cand.count > best.count ||
      (cand.count === best.count &&
        (cand.move < best.move ||
          (cand.move === best.move && cand.dist < best.dist)))
    )
      best = cand;
  }
  return best.k;
}

export interface HumPitchOption {
  /** Analyzer midi: put it in `HumChoice.midi` to choose this option. */
  midi: number;
  /** As it would be written now (octave, transpose, key, folding). */
  pitch: string;
  /** The analyzer's confidence of this alternative; absent on the original reading. */
  confidence?: number;
  /** The analyzer's own reading (listed first). */
  original: boolean;
  /** The option the draft currently uses. */
  selected: boolean;
}

export interface HumPositionOption {
  /** Analyzer ticks from bar 1, before the shift: put them in `HumChoice.position`. */
  startTick: number;
  ticks: number;
  confidence?: number;
  original: boolean;
  selected: boolean;
}

export interface HumNoteCandidates {
  /** Note id (index in `result.melody.quantized.events`), the `HumChosen` key. */
  id: number;
  /** The analyzer's confidence of the note (pitch × position). */
  confidence: number;
  /** Show the low-confidence mark: confidence below LOW_CONFIDENCE and nothing chosen, or folded. */
  low: boolean;
  /** The pitch was outside C3–C7 after octave / transpose and was folded in by octaves. */
  folded: boolean;
  /** Original first, then at most 3 alternatives. */
  pitch: HumPitchOption[];
  /** Original first, then at most 2 alternatives (none for triplet notes). */
  position: HumPositionOption[];
}

/**
 * Per event of `draft.events`: the note's candidates, or null for a rest.
 * Pass the same `opts` that made `draft` (for spelling and `selected`).
 */
export function humCandidates(
  result: HumAnalysisResult,
  draft: HumDraftOk,
  opts: HumDraftOptions,
): (HumNoteCandidates | null)[] {
  const evs = quantizedEvents(result);
  return draft.ids.map((id) => {
    if (id === null) return null;
    const e = evs[id] as QuantizedNote & TupletTag;
    const choice = opts.chosen[id] ?? {};
    const chosenMidi = choice.midi ?? e.midi;
    const pitch: HumPitchOption[] = [
      { midi: e.midi },
      ...e.candidates.slice(0, PITCH_ALTERNATIVES),
    ].map((c, k) => ({
      midi: c.midi,
      pitch: spell(writtenMidi(c.midi, opts).midi, opts.key),
      ...(k > 0
        ? { confidence: (c as { confidence: number }).confidence }
        : {}),
      original: k === 0,
      selected: c.midi === chosenMidi,
    }));
    const pos = e.tuplet ? undefined : choice.position;
    const at = pos ?? { startTick: e.startTick, ticks: e.ticks };
    const position: HumPositionOption[] = [
      { startTick: e.startTick, ticks: e.ticks },
      ...(e.tuplet ? [] : e.gridCandidates.slice(0, POSITION_ALTERNATIVES)),
    ].map((c, k) => ({
      startTick: c.startTick,
      ticks: c.ticks,
      ...(k > 0
        ? { confidence: (c as { confidence: number }).confidence }
        : {}),
      original: k === 0,
      selected: c.startTick === at.startTick && c.ticks === at.ticks,
    }));
    const folded = writtenMidi(chosenMidi, opts).folded;
    const anyChoice = choice.midi !== undefined || pos !== undefined;
    return {
      id,
      confidence: e.confidence,
      low: folded || (!anyChoice && e.confidence < LOW_CONFIDENCE),
      folded,
      pitch,
      position,
    };
  });
}
