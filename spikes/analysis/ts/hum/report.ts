/**
 * Spike 4 T2: score rows and report tables (docs/audio-spike4-plan.md section 4, task T2).
 *
 * `scoreRow()` turns one analyzed take (truth + result) into a flat record of NUMBERS. `renderReport()` prints
 * markdown tables: per level and per variant for synthetic takes; for real recordings ONLY aggregates (n, mean,
 * min, max over the recordings of a group), never a recording id, note sequence or pitch (plan: privacy).
 */
import {
  SHIFT_CLASS_CODE,
  APP_OPS_COSTS,
  dropShortTruth,
  editScript,
  estimateShift,
  estimateShiftTicks,
  f0TrackScores,
  gridCandidateHit,
  noteScoreSet,
  notesToEvents,
  pitchCandidateHit,
  quantScores,
  quantizedToEvents,
  shiftClass,
  unshiftNotes,
  unshiftQuantized,
  writtenPitch,
  type ScoreNote,
  type TickNote,
} from './score';
import type { FrameF0Track, HumNote, QuantizedMelody } from './types';

export type Scores = Record<string, number>;

export interface ScoreInput {
  /** Seconds-domain truth ("sung times") and the analyzer notes. */
  truthNotes?: ScoreNote[];
  estNotes?: HumNote[];
  /** Frame truth (hz, 0 = unvoiced) and the analyzer's track (synthetic only). */
  truthF0?: { t0: number; hopSec: number; hz: number[] };
  estF0?: FrameF0Track;
  /** Tick-domain truth (score times) and the analyzer's quantized melody. */
  truthTicks?: TickNote[];
  estQuant?: QuantizedMelody;
  /** Relaxed onset tolerance for recordings is already in the variant `onset100ms`. */
  /**
   * Remove one global semitone shift (-24..24, octaves included) between estimate and truth before every note
   * metric / quantized accuracy / edit count / candidate hit (see `estimateShift`). Default false (synthetic
   * numbers unchanged); recordings pass true. The row always gets `shift.class` (0 zero, 1 octave, 2 other);
   * the value `shift.semitones` only when `exposeShift` is true (synthetic; never for recordings).
   */
  transposeInvariant?: boolean;
  exposeShift?: boolean;
}

/** The shift scoreRow would remove for this input: seconds-domain pairs when available, else tick-domain pairs. */
export function shiftFor(inp: ScoreInput): number {
  if (inp.truthNotes && inp.estNotes) return estimateShift(inp.truthNotes, inp.estNotes);
  if (inp.truthTicks && inp.estQuant) {
    const out = quantizedToEvents(inp.estQuant).filter((e) => e.kind === 'note') as { startTick: number; ticks: number; midi: number }[];
    return estimateShiftTicks(dropShortTruth(inp.truthTicks), out);
  }
  return 0;
}

/** Flat numbers for one take; keys only present when the matching input was given. */
export function scoreRow(inp0: ScoreInput): Scores {
  const s: Scores = {};
  let inp = inp0;
  if (inp0.transposeInvariant) {
    const shift = shiftFor(inp0);
    s['shift.class'] = SHIFT_CLASS_CODE[shiftClass(shift)];
    if (inp0.exposeShift) s['shift.semitones'] = shift;
    inp = { ...inp0, ...(inp0.estNotes ? { estNotes: unshiftNotes(inp0.estNotes, shift) } : {}), ...(inp0.estQuant ? { estQuant: unshiftQuantized(inp0.estQuant, shift) } : {}) };
  }
  if (inp.truthNotes && inp.estNotes) {
    const est: ScoreNote[] = inp.estNotes.map((n) => ({ start: n.start, end: n.end, midi: n.midi, cents: n.cents }));
    // M1: headline = pitch by WRITTEN note (score MIDI, cents ignored on both sides).
    for (const [v, r] of Object.entries(noteScoreSet(writtenPitch(inp.truthNotes), writtenPitch(est)))) {
      s[`noteF.${v}`] = r.f;
      s[`noteP.${v}`] = r.precision;
      s[`noteR.${v}`] = r.recall;
    }
    // Old definition (sung pitch incl. deviation) under a different name, F only.
    for (const [v, r] of Object.entries(noteScoreSet(inp.truthNotes, est))) s[`noteF_sungPitch.${v}`] = r.f;
    s['pitchCand.k1'] = pitchCandidateHit(inp.truthNotes, inp.estNotes, 1);
    s['pitchCand.k2'] = pitchCandidateHit(inp.truthNotes, inp.estNotes, 2);
  }
  if (inp.truthF0 && inp.estF0) {
    const f = f0TrackScores(inp.truthF0, inp.estF0);
    s['f0.rpa'] = f.rawPitchAccuracy;
    s['f0.rca'] = f.rawChromaAccuracy;
    s['f0.voicingRecall'] = f.voicingRecall;
    s['f0.voicingFalseAlarm'] = f.voicingFalseAlarm;
    s['f0.octaveError'] = f.octaveErrorRate;
  }
  if (inp.truthTicks && inp.estQuant) {
    const truth = dropShortTruth(inp.truthTicks);
    const outEv = quantizedToEvents(inp.estQuant);
    const outNotes: TickNote[] = outEv.filter((e) => e.kind === 'note').map((e) => ({ startTick: e.startTick, ticks: e.ticks, midi: (e as { midi: number }).midi }));
    const q = quantScores(truth, outNotes);
    s['quant.startAcc'] = q.startAcc;
    s['quant.startPitchAcc'] = q.startPitchAcc;
    s['quant.exactAcc'] = q.exactAcc;
    s['quant.pitchOnlyAcc'] = q.pitchOnlyAcc;
    s['quant.exactPrecision'] = q.exactPrecision;
    const e = editScript(notesToEvents(truth), outEv);
    s['edit.count'] = e.edits;
    s['edit.perNote'] = e.editsPerNote;
    s['edit.keyboardSteps'] = e.keyboardSteps;
    s['edit.ratioToKeyboard'] = e.ratioToKeyboard;
    // S1: split / merge priced as the app can do them (2 steps each); `edit.*` above counts them 1 (lower bound).
    const ea = editScript(notesToEvents(truth), outEv, APP_OPS_COSTS);
    s['edit.appOps.count'] = ea.edits;
    s['edit.appOps.ratioToKeyboard'] = ea.ratioToKeyboard;
    const gridOut = inp.estQuant.events.filter((x) => x.kind === 'note').map((x) => x as Extract<(typeof inp.estQuant.events)[number], { kind: 'note' }>);
    s['gridCand.k1'] = gridCandidateHit(truth, gridOut, 1);
    s['gridCand.k2'] = gridCandidateHit(truth, gridOut, 2);
  }
  return s;
}

export interface ReportRow {
  /** For synthetic takes the id/variant name is printed; for recordings it never is. */
  id: string;
  kind: 'synthetic' | 'recording';
  /** 'H0'..'H3' or any grouping label. */
  level: string;
  variant?: string;
  heldOut?: boolean;
  scores: Scores;
}

/** Columns of the tables: [header, score key, format]. */
export const COLUMNS: [string, string, 'f' | 'n'][] = [
  ['F onset', 'noteF.onset', 'f'],
  ['F on+off', 'noteF.onsetOffset', 'f'],
  ['F class', 'noteF.onsetPitchClass', 'f'],
  ['F +-1st', 'noteF.onsetSemitone', 'f'],
  ['F 100ms', 'noteF.onset100ms', 'f'],
  ['RPA', 'f0.rpa', 'f'],
  ['RCA', 'f0.rca', 'f'],
  ['VxRec', 'f0.voicingRecall', 'f'],
  ['VxFA', 'f0.voicingFalseAlarm', 'f'],
  ['oct err', 'f0.octaveError', 'f'],
  ['quant exact', 'quant.exactAcc', 'f'],
  ['edits/note', 'edit.perNote', 'f'],
  ['edits/kbd', 'edit.ratioToKeyboard', 'f'],
  ['pitch@2', 'pitchCand.k2', 'f'],
  ['grid@2', 'gridCand.k2', 'f'],
];

const fmt = (x: number | undefined, kind: 'f' | 'n') => (x === undefined || !Number.isFinite(x) ? '-' : kind === 'f' ? x.toFixed(3) : String(x));

function stats(rows: ReportRow[], key: string) {
  const v = rows.map((r) => r.scores[key]).filter((x) => x !== undefined && Number.isFinite(x));
  if (v.length === 0) return undefined;
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}
function table(header: string[], body: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
const sortLevels = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const groupBy = (rows: ReportRow[], f: (r: ReportRow) => string) => {
  const m = new Map<string, ReportRow[]>();
  for (const r of rows) m.set(f(r), [...(m.get(f(r)) ?? []), r]);
  return m;
};

/**
 * Markdown report. Synthetic: mean per level (and heldOut split), then one line per variant. Recordings: one
 * aggregate table per level label (n, mean, min and max of the headline metrics), no ids.
 */
export function renderReport(rows: ReportRow[]): string {
  const out: string[] = [];
  const syn = rows.filter((r) => r.kind === 'synthetic');
  const rec = rows.filter((r) => r.kind === 'recording');
  const head = ['group', 'n', ...COLUMNS.map((c) => c[0])];
  if (syn.length) {
    const byLevel = groupBy(syn, (r) => `${r.level}${r.heldOut ? ' (held-out)' : ''}`);
    out.push('## Synthetic: mean per level', '', table(head, [...byLevel.keys()].sort(sortLevels).map((k) => [k, String(byLevel.get(k)!.length), ...COLUMNS.map(([, key, f]) => fmt(stats(byLevel.get(k)!, key)?.mean, f))])), '');
    const sorted = [...syn].sort((a, b) => sortLevels(a.level, b.level) || a.id.localeCompare(b.id));
    out.push('## Synthetic: per variant', '', table(['variant', 'level', ...COLUMNS.map((c) => c[0])], sorted.map((r) => [r.variant ?? r.id, r.level + (r.heldOut ? ' (held-out)' : ''), ...COLUMNS.map(([, key, f]) => fmt(r.scores[key], f))])), '');
  }
  if (rec.length) {
    const byLevel = groupBy(rec, (r) => r.level);
    const body: string[][] = [];
    for (const k of [...byLevel.keys()].sort(sortLevels)) {
      const g = byLevel.get(k)!;
      for (const stat of ['mean', 'min', 'max'] as const) {
        body.push([`${k} ${stat}`, String(g.length), ...COLUMNS.map(([, key, f]) => fmt(stats(g, key)?.[stat], f))]);
      }
    }
    out.push('## Recordings: aggregates only (no per-take lines)', '', table(head, body), '');
  }
  return out.join('\n');
}
