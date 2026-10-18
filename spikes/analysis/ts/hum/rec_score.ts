/**
 * Recording scoring shared by the held-out driver and the dev-only evaluations (moved out of heldout_eval.ts in T15,
 * unchanged). Numbers only; transposeInvariant scoring against the written notes.
 */
import { errorTypes, type TruthNote } from './baseline';
import { scoreRow, shiftFor, type Scores } from './report';
import { unshiftNotes, unshiftQuantized } from './score';
import type { HumNote, QuantizedMelody } from './types';

export interface RecTruth { heldOut: boolean; info: { bpm: number; ts: [number, number]; startSec: number; firstNoteSec: number }; notes: TruthNote[] }

export function recScore(truth: RecTruth, notes: HumNote[], q: QuantizedMelody, base: 'given' | 'grid'): Scores {
  const tr = truth.notes;
  const d = q.startSec - truth.info.startSec;
  const truthAll = base === 'given' ? tr : tr.map((n) => ({ ...n, start: n.start + d, end: n.end + d }));
  const truthNotes = truthAll.filter((n) => n.ticks >= 4);
  const input = {
    truthNotes: truthNotes.map((n) => ({ start: n.start, end: n.end, midi: n.midi })),
    estNotes: notes,
    truthTicks: truthAll.map((n) => ({ startTick: n.startTick, ticks: n.ticks, midi: n.midi })),
    estQuant: q,
    transposeInvariant: true,
  };
  const s = scoreRow(input);
  const shift = shiftFor(input);
  const un = unshiftNotes(notes, shift);
  Object.assign(s, errorTypes(truthNotes, un, unshiftQuantized(q, shift)));
  const ov = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const hit = (a: { start: number; end: number }, b: { start: number; end: number }) => ov(a, b) > 0.3 * Math.min(a.end - a.start, b.end - b.start);
  let same = 0;
  for (const e of un) {
    const cov = truthNotes.filter((x) => hit(x, e));
    for (let i = 1; i < cov.length; i++) if (cov[i].midi === cov[i - 1].midi) same++;
  }
  s['seg.missedSplit.samePitch'] = same;
  s.nTruth = truthNotes.length;
  s.nEst = notes.length;
  return s;
}

