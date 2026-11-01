import { describe, expect, it } from 'vitest';
import type { HumAnalysisResult } from '../analysis/hum/types';
import { humCandidates, humDraftEvents, proposeOctave } from './humDraft';
import { humSampleResult } from './fixtures/humResults';
import {
  applyFixes,
  fixesChanged,
  fixSummary,
  initialFixes,
  mergeChoice,
  type HumFixes,
} from './humReview';
import { SHIFT_STEP_TICKS } from './humImport';
import {
  HUM_TUPLET_SHIFT_MESSAGE,
  IMPORT_ERROR_MESSAGES,
} from './importErrors';

const TS = { num: 4, den: 4 };
const SIXTEENTH = SHIFT_STEP_TICKS;

const base = (over: Partial<HumFixes> = {}): HumFixes => ({
  octave: 0,
  transpose: 0,
  shiftTicks: 0,
  chosen: {},
  ...over,
});

/** The candidates of the sample's note 3 (A4, unsure; pitch 68 / 70, length 1/2 beat). */
function note3() {
  const r = humSampleResult();
  const f = initialFixes(r);
  const d = humDraftEvents(r, f);
  if (!d.ok) throw new Error('draft');
  const cands = humCandidates(r, d, f);
  const c = cands[d.ids.indexOf(3)];
  if (!c) throw new Error('note 3');
  return c;
}

describe('initialFixes', () => {
  it('is the proposed octave and nothing else', () => {
    const r = humSampleResult();
    expect(initialFixes(r)).toEqual({
      octave: proposeOctave(r),
      transpose: 0,
      shiftTicks: 0,
      chosen: {},
    });
  });
});

describe('mergeChoice', () => {
  const c = note3();
  const original = c.pitch[0].midi;
  const alt = c.pitch[1].midi;
  const pos = c.position[1];

  it('adds a pitch choice', () => {
    expect(mergeChoice({}, c, { midi: alt })).toEqual({ 3: { midi: alt } });
  });

  it('adds a position choice next to a pitch choice of the same note', () => {
    const one = mergeChoice({}, c, { midi: alt });
    expect(
      mergeChoice(one, c, {
        position: { startTick: pos.startTick, ticks: pos.ticks },
      }),
    ).toEqual({
      3: {
        midi: alt,
        position: { startTick: pos.startTick, ticks: pos.ticks },
      },
    });
  });

  it("re-picking the analyzer's pitch removes the choice (and the note when nothing is left)", () => {
    const one = mergeChoice({}, c, { midi: alt });
    expect(mergeChoice(one, c, { midi: original })).toEqual({});
  });

  it("re-picking the analyzer's position removes only that part", () => {
    const both = mergeChoice(mergeChoice({}, c, { midi: alt }), c, {
      position: { startTick: pos.startTick, ticks: pos.ticks },
    });
    const o = c.position[0];
    expect(
      mergeChoice(both, c, {
        position: { startTick: o.startTick, ticks: o.ticks },
      }),
    ).toEqual({ 3: { midi: alt } });
  });

  it('choosing the original on an untouched note changes nothing', () => {
    expect(mergeChoice({ 7: { midi: 1 } }, c, { midi: original })).toEqual({
      7: { midi: 1 },
    });
  });

  it('does not touch other notes and does not mutate its input', () => {
    const before = { 7: { midi: 66 } };
    const out = mergeChoice(before, c, { midi: alt });
    expect(out).toEqual({ 7: { midi: 66 }, 3: { midi: alt } });
    expect(before).toEqual({ 7: { midi: 66 } });
  });
});

describe('fixesChanged', () => {
  it('is false for the start and when only the proposal is restored', () => {
    expect(fixesChanged(base({ octave: 2 }), 2)).toBe(false);
  });
  it('is true for each kind of fix', () => {
    expect(fixesChanged(base({ octave: 1 }), 0)).toBe(true);
    expect(fixesChanged(base({ transpose: -1 }), 0)).toBe(true);
    expect(fixesChanged(base({ shiftTicks: SIXTEENTH }), 0)).toBe(true);
    expect(fixesChanged(base({ chosen: { 3: { midi: 70 } } }), 0)).toBe(true);
  });
  it('agrees with fixSummary being non-empty', () => {
    for (const f of [
      base(),
      base({ octave: 1 }),
      base({ transpose: 2 }),
      base({ shiftTicks: -SIXTEENTH }),
      base({ chosen: { 1: { midi: 60 } } }),
    ])
      expect(fixesChanged(f, 0)).toBe(fixSummary(f, 0, TS).length > 0);
  });
});

describe('fixSummary', () => {
  it('is empty without fixes', () => {
    expect(fixSummary(base({ octave: 3 }), 3, TS)).toEqual([]);
  });
  it('octave is relative to the proposal', () => {
    expect(fixSummary(base({ octave: 3 }), 2, TS)).toEqual(['1 オクターブ上']);
    expect(fixSummary(base({ octave: 0 }), 2, TS)).toEqual(['2 オクターブ下']);
  });
  it('transpose has a sign', () => {
    expect(fixSummary(base({ transpose: 3 }), 0, TS)).toEqual(['+3 半音']);
    expect(fixSummary(base({ transpose: -1 }), 0, TS)).toEqual(['−1 半音']);
  });
  it('shift uses the 16th-aware label of the time signature', () => {
    expect(fixSummary(base({ shiftTicks: SIXTEENTH }), 0, TS)).toEqual([
      '16 分 1 つ後',
    ]);
    expect(fixSummary(base({ shiftTicks: -4 * SIXTEENTH }), 0, TS)).toEqual([
      '1 拍前',
    ]);
  });
  it('counts the notes with a choice, and joins in a fixed order', () => {
    expect(
      fixSummary(
        base({
          octave: 1,
          transpose: 1,
          shiftTicks: SIXTEENTH,
          chosen: { 1: { midi: 60 }, 3: { midi: 61 } },
        }),
        0,
        TS,
      ),
    ).toEqual(['1 オクターブ上', '+1 半音', '16 分 1 つ後', '候補 2 音']);
  });
});

describe('applyFixes', () => {
  const r = humSampleResult();

  it('returns the draft the fixes make', () => {
    const out = applyFixes(r, base({ transpose: 1 }), 'C');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft).toEqual(
      humDraftEvents(r, { ...base({ transpose: 1 }), key: 'C' }),
    );
  });

  it('a triplet pushed over a barline -> the tuplet message', () => {
    const t = (slot: number) => ({ n: 3 as const, slot });
    const n = (startTick: number, midi: number, slot: number) => ({
      kind: 'note' as const,
      startTick,
      ticks: 8,
      midi,
      src: 0,
      confidence: 1,
      candidates: [],
      gridCandidates: [],
      tuplet: t(slot),
    });
    const q = r.melody.quantized;
    const trip: HumAnalysisResult = {
      ...r,
      melody: {
        ...r.melody,
        quantized: {
          ...q,
          events: [
            { kind: 'rest', startTick: 0, ticks: 48 },
            n(48, 64, 0),
            n(48 + 16 / 3, 66, 1),
            n(48 + 32 / 3, 67, 2),
            { kind: 'rest', startTick: 64, ticks: 64 },
          ],
        },
      },
    };
    expect(applyFixes(trip, base({ shiftTicks: SIXTEENTH }))).toEqual({
      ok: false,
      message: HUM_TUPLET_SHIFT_MESSAGE,
    });
    expect(applyFixes(trip, base()).ok).toBe(true);
  });

  it('any other failure -> the internal message', () => {
    expect(applyFixes(r, base({ transpose: 1.5 }))).toEqual({
      ok: false,
      message: IMPORT_ERROR_MESSAGES.internal,
    });
  });
});
