import { describe, expect, it } from 'vitest';
import { DEFAULT_HUM_CONFIG } from './config';
import {
  beatGrid,
  checkQuantized,
  estimateGridPhaseSteps,
  estimateOnsetBiasLocal,
  estimateOnsetBiasTicks,
  metricLevel,
  quantize,
  quantizeDetailed,
  wrapResidual,
  type QuantizedEventT,
} from './quantize';
import { prng } from '../../../test/prng';
import type { HumInfo, QuantizedMelody, QuantizedNote } from './types';

const GRID = DEFAULT_HUM_CONFIG.grid;

/** Score note [startTick, ticks, midi] -> sung note with jitter on onset and end (seconds). */
type S = [number, number, number];
function sing(
  info: HumInfo,
  notes: S[],
  opts: {
    jitter?: (i: number) => number;
    bias?: number;
    gapSec?: number;
    endCut?: (i: number) => number;
  } = {},
) {
  const g = beatGrid(info);
  return notes.map(([st, ti, midi], i) => {
    const on =
      g.startSec + st * g.tickSec + (opts.bias ?? 0) + (opts.jitter?.(i) ?? 0);
    const legatoNext = notes[i + 1] && notes[i + 1][0] === st + ti;
    let end =
      g.startSec +
      (st + ti) * g.tickSec +
      (opts.bias ?? 0) -
      (opts.gapSec ?? 0.04) -
      (opts.endCut?.(i) ?? 0);
    if (legatoNext)
      end = Math.min(
        end,
        g.startSec +
          notes[i + 1][0] * g.tickSec +
          (opts.bias ?? 0) +
          (opts.jitter?.(i + 1) ?? 0) -
          (opts.gapSec ?? 0.04),
      );
    return { start: on, end, midi };
  });
}

const notesOf = (q: QuantizedMelody) =>
  q.events.filter((e): e is QuantizedNote => e.kind === 'note');
const shape = (q: QuantizedMelody) =>
  q.events.map((e) =>
    e.kind === 'note'
      ? [e.startTick, e.ticks, e.midi]
      : ['r', e.startTick, e.ticks],
  );

const INFO: HumInfo = { bpm: 100, ts: [4, 4], startSec: 2 };

describe('beatGrid', () => {
  it('4/4 and 6/8', () => {
    const g = beatGrid(INFO);
    expect(g.tickSec).toBeCloseTo(60 / 100 / 16, 12);
    expect([g.beatTicks, g.barTicks, g.stepTicks]).toEqual([16, 64, 4]);
    const h = beatGrid({ bpm: 180, ts: [6, 8], startSec: 0 });
    expect([h.beatTicks, h.barTicks]).toEqual([8, 48]);
    expect(h.tickSec).toBeCloseTo(60 / 180 / 8, 12);
  });
  it('rejects bad input', () => {
    expect(() => beatGrid({ bpm: 0, ts: [4, 4], startSec: 0 })).toThrow(
      RangeError,
    );
    expect(() => beatGrid({ bpm: 100, ts: [4, 3], startSec: 0 })).toThrow(
      RangeError,
    );
    expect(() => beatGrid(INFO, { subdivision: 64 })).toThrow(RangeError);
  });
  it('metric levels', () => {
    const g = beatGrid(INFO);
    expect([0, 32, 16, 8, 4, 64].map((t) => metricLevel(t, g))).toEqual([
      4, 3, 2, 1, 0, 4,
    ]);
  });
});

describe('onset bias', () => {
  it('wrapResidual', () => {
    expect(wrapResidual(5, 4)).toBe(1);
    expect(wrapResidual(7, 4)).toBe(-1);
    expect(wrapResidual(-1, 4)).toBe(-1);
  });
  it('recovers a constant offset under jitter (local and trunc)', () => {
    const r = prng(7);
    const u = Array.from(
      { length: 40 },
      (_, i) => i * 4 + 1.2 + (r() - 0.5) * 0.8,
    );
    expect(estimateOnsetBiasLocal(u, 4, 1.8)).toBeCloseTo(1.2, 0);
    expect(estimateOnsetBiasTicks(u, 4, 1.8)).toBeCloseTo(1.2, 0);
  });
  it('is clamped', () => {
    const u = Array.from({ length: 10 }, (_, i) => i * 4 + 1.9);
    expect(Math.abs(estimateOnsetBiasLocal(u, 4, 1))).toBeLessThanOrEqual(1);
  });
});

describe('quantize: grid slots', () => {
  // a bar of 8ths, 16ths and a dotted quarter, then a whole note
  const score: S[] = [
    [0, 8, 60],
    [8, 8, 62],
    [16, 4, 64],
    [20, 4, 65],
    [24, 8, 67],
    [32, 24, 69],
    [56, 8, 67],
    [64, 64, 60],
  ];
  it('exact timing -> exact slots, gapless, last bar complete', () => {
    const q = quantize(sing(INFO, score), INFO);
    expect(shape(q)).toEqual(score);
    expect(checkQuantized(q)).toEqual([]);
    expect(q.grid).toBe('sixteenth');
  });
  it('onsets jittered +-30 ms return to the right slot', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = prng(seed);
      const jit = score.map(() => (r() * 2 - 1) * 0.03);
      const q = quantize(sing(INFO, score, { jitter: (i) => jit[i] }), INFO);
      expect(shape(q)).toEqual(score);
    }
    // the extremes, alternating
    const q = quantize(
      sing(INFO, score, { jitter: (i) => (i % 2 ? 0.03 : -0.03) }),
      INFO,
    );
    expect(shape(q)).toEqual(score);
  });
  it('a habitual late bias is removed (bias + jitter beyond half a 16th)', () => {
    const fast: HumInfo = { bpm: 120, ts: [4, 4], startSec: 1 }; // 16th = 125 ms
    const r = prng(11);
    const jit = score.map(() => (r() * 2 - 1) * 0.03);
    const notes = sing(fast, score, { bias: 0.045, jitter: (i) => jit[i] });
    expect(
      shape(quantize(notes, fast, { ...GRID, onsetBias: false })),
    ).not.toEqual(score);
    const q = quantize(notes, fast);
    expect(shape(q)).toEqual(score);
    expect(q.onsetBiasSec).toBeGreaterThan(0.03);
    expect(q.onsetBiasSec).toBeLessThan(0.06);
  });
  it('an early bias too', () => {
    const q = quantize(sing(INFO, score, { bias: -0.05 }), INFO);
    expect(shape(q)).toEqual(score);
    expect(q.onsetBiasSec).toBeCloseTo(-0.05, 3);
  });
  it('few notes: no bias estimate', () => {
    const q = quantize(
      sing(
        INFO,
        [
          [0, 16, 60],
          [16, 16, 62],
        ],
        { bias: 0.05 },
      ),
      INFO,
    );
    expect(q.onsetBiasSec).toBe(0);
  });
});

describe('quantize: rhythm examples', () => {
  it('dotted quarter + eighth, dotted eighth + 16th', () => {
    const s: S[] = [
      [0, 24, 60],
      [24, 8, 62],
      [32, 12, 64],
      [44, 4, 65],
      [48, 16, 67],
    ];
    expect(shape(quantize(sing(INFO, s), INFO))).toEqual(s);
  });
  it('rests: a sung gap of a 16th or more is a rest, a shorter gap is legato', () => {
    // note, eighth rest, note, quarter rest, note
    const s: S[] = [
      [0, 8, 60],
      [16, 16, 62],
      [48, 16, 64],
    ];
    expect(shape(quantize(sing(INFO, s), INFO))).toEqual([
      [0, 8, 60],
      ['r', 8, 8],
      [16, 16, 62],
      ['r', 32, 16],
      [48, 16, 64],
    ]);
    // gap just under half an eighth (16th = 150 ms at 100 bpm) -> legato
    const tick = beatGrid(INFO).tickSec;
    const legato = [
      { start: 2, end: 2 + 16 * tick - 0.14, midi: 60 },
      { start: 2 + 16 * tick, end: 2 + 32 * tick, midi: 62 },
    ];
    expect(shape(quantize(legato, INFO))).toEqual([
      [0, 16, 60],
      [16, 16, 62],
      ['r', 32, 32],
    ]);
    const rest = [
      { start: 2, end: 2 + 16 * tick - 0.16, midi: 60 },
      { start: 2 + 16 * tick, end: 2 + 32 * tick, midi: 62 },
    ];
    expect(shape(quantize(rest, INFO))).toEqual([
      [0, 12, 60],
      ['r', 12, 4],
      [16, 16, 62],
      ['r', 32, 32],
    ]);
  });
  it('leading rest and a note across the bar line stays one note', () => {
    const s: S[] = [
      [16, 16, 60],
      [32, 16, 62],
      [48, 32, 64], // beat 4 -> beat 2 of bar 2
      [80, 16, 65],
      [96, 32, 67],
    ];
    const q = quantize(sing(INFO, s), INFO);
    expect(shape(q)).toEqual([['r', 0, 16], ...s]);
  });
  it('same-pitch repeats stay separate notes', () => {
    const s: S[] = [
      [0, 16, 60],
      [16, 16, 60],
      [32, 8, 60],
      [40, 8, 60],
      [48, 16, 60],
    ];
    expect(shape(quantize(sing(INFO, s, { gapSec: 0.03 }), INFO))).toEqual(s);
  });
  it('a note cut short before a rest ends on the next beat', () => {
    const tick = beatGrid(INFO).tickSec;
    // half note on beat 1 sung to beat 2.6, then a note on beat 4
    const notes = [
      { start: 2, end: 2 + 26 * tick, midi: 60 },
      { start: 2 + 48 * tick, end: 2 + 63 * tick, midi: 62 },
    ];
    expect(shape(quantize(notes, INFO))).toEqual([
      [0, 32, 60],
      ['r', 32, 16],
      [48, 16, 62],
    ]);
    // the same end without the extension rule
    expect(
      shape(quantize(notes, INFO, GRID, { endExtendFraction: 0 })),
    ).toEqual([
      [0, 28, 60],
      ['r', 28, 20],
      [48, 16, 62],
    ]);
  });
  it('the extension never eats the rest before the next note', () => {
    const tick = beatGrid(INFO).tickSec;
    const notes = [
      { start: 2 + 4 * tick, end: 2 + 10 * tick, midi: 60 }, // a rest (gap 6 ticks); nearest end 12; beat 16 = next onset
      { start: 2 + 16 * tick, end: 2 + 31 * tick, midi: 62 },
    ];
    expect(shape(quantize(notes, INFO))[1]).toEqual([4, 8, 60]);
  });
  it('minimum length: a very short note before a rest gets one 16th', () => {
    const tick = beatGrid(INFO).tickSec;
    const notes = [
      { start: 2, end: 2 + 0.3 * tick, midi: 60 },
      { start: 2 + 16 * tick, end: 2 + 31 * tick, midi: 62 },
    ];
    expect(shape(quantize(notes, INFO))).toEqual([
      [0, 4, 60],
      ['r', 4, 12],
      [16, 16, 62],
      ['r', 32, 32],
    ]);
  });
  it('a note sung before bar 1 starts at tick 0', () => {
    const tick = beatGrid(INFO).tickSec;
    const q = quantize(
      [{ start: 2 - 10 * tick, end: 2 + 15 * tick, midi: 60 }],
      INFO,
    );
    expect(shape(q)[0]).toEqual([0, 16, 60]);
  });
  it('empty and zero-length input', () => {
    expect(quantize([], INFO).events).toEqual([]);
    const r = quantizeDetailed(
      [
        { start: 3, end: 3, midi: 60 },
        { start: 2, end: 2.5, midi: 62 },
      ],
      INFO,
    );
    expect(r.warnings.join()).toMatch(/end <= start/);
    expect(notesOf(r.melody).map((n) => n.src)).toEqual([1]);
  });
  it('6/8: bars of 48 ticks', () => {
    const info: HumInfo = { bpm: 180, ts: [6, 8], startSec: 0.5 };
    const s: S[] = [
      [0, 24, 60],
      [24, 8, 62],
      [32, 16, 64],
      [48, 24, 65],
    ];
    const q = quantize(sing(info, s), info);
    expect(shape(q)).toEqual([...s, ['r', 72, 24]]);
  });
});

describe('quantize: collisions', () => {
  const tick = beatGrid(INFO).tickSec;
  it('two onsets on one slot: the later moves one step when there is room', () => {
    const notes = [
      { start: 2, end: 2 + 1.5 * tick, midi: 60 },
      { start: 2 + 1.6 * tick, end: 2 + 15 * tick, midi: 62 }, // also rounds to 0
      { start: 2 + 16 * tick, end: 2 + 31 * tick, midi: 64 },
    ];
    const r = quantizeDetailed(notes, INFO, { ...GRID, onsetBias: false });
    expect(r.moved).toBe(1);
    expect(shape(r.melody).slice(0, 3)).toEqual([
      [0, 4, 60],
      [4, 12, 62],
      [16, 16, 64],
    ]);
    expect(checkQuantized(r.melody)).toEqual([]);
  });
  it('no room on either side: merged into the longer note', () => {
    const notes = [
      { start: 2, end: 2 + 1 * tick, midi: 60 },
      { start: 2 + 1.2 * tick, end: 2 + 3 * tick, midi: 62 },
      { start: 2 + 4.1 * tick, end: 2 + 15 * tick, midi: 64 },
      { start: 2 + 4.4 * tick, end: 2 + 15 * tick, midi: 65 },
    ];
    const r = quantizeDetailed(notes, INFO, { ...GRID, onsetBias: false });
    expect(r.merged).toBeGreaterThan(0);
    expect(r.warnings.join()).toMatch(/merged/);
    expect(checkQuantized(r.melody)).toEqual([]);
    const ns = notesOf(r.melody);
    for (let i = 1; i < ns.length; i++)
      expect(ns[i].startTick).toBeGreaterThan(ns[i - 1].startTick);
  });
});

describe('quantize: candidates and confidence', () => {
  const tick = beatGrid(INFO).tickSec;
  const base = (late: number) => [
    { start: 2, end: 2 + 15 * tick, midi: 60 },
    { start: 2 + (16 + late) * tick, end: 2 + 31 * tick, midi: 62 },
    { start: 2 + 32 * tick, end: 2 + 47 * tick, midi: 64 },
    { start: 2 + 48 * tick, end: 2 + 63 * tick, midi: 65 },
  ];
  it('a note 40% of a step late: the later slot is the first candidate', () => {
    const q = quantize(base(1.6), INFO, { ...GRID, onsetBias: false });
    const n = notesOf(q)[1];
    expect(n.startTick).toBe(16);
    expect(n.gridCandidates[0].startTick).toBe(20);
    expect(n.gridCandidates[0].ticks).toBe(12);
    expect(n.gridCandidates[0].confidence).toBeGreaterThan(0.05);
    expect(n.gridCandidates[0].confidence).toBeLessThan(0.5);
    expect(n.confidence).toBeGreaterThan(0.5);
    expect(n.confidence).toBeLessThan(notesOf(q)[0].confidence);
  });
  it('at most candidatesMax, sorted best first', () => {
    const q = quantize(base(1.9), INFO, { ...GRID, onsetBias: false });
    for (const n of notesOf(q)) {
      expect(n.gridCandidates.length).toBeLessThanOrEqual(GRID.candidatesMax);
      for (let i = 1; i < n.gridCandidates.length; i++)
        expect(n.gridCandidates[i].confidence).toBeLessThanOrEqual(
          n.gridCandidates[i - 1].confidence,
        );
    }
    const q1 = quantize(base(1.9), INFO, {
      ...GRID,
      onsetBias: false,
      candidatesMax: 1,
    });
    for (const n of notesOf(q1))
      expect(n.gridCandidates.length).toBeLessThanOrEqual(1);
  });
  it('pitch candidates and the source confidence are carried', () => {
    const q = quantize(
      [
        {
          start: 2,
          end: 2.5,
          midi: 60,
          confidence: 0.5,
          candidates: [{ midi: 61, confidence: 0.3 }],
        },
      ],
      INFO,
    );
    const n = notesOf(q)[0];
    expect(n.candidates).toEqual([{ midi: 61, confidence: 0.3 }]);
    expect(n.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('quantize: triplet switch', () => {
  const tick = beatGrid(INFO).tickSec;
  const T = 16 / 3;
  const notes = [
    { start: 2, end: 2 + 15 * tick, midi: 60 },
    // beat 2: an 8th triplet
    { start: 2 + 16 * tick, end: 2 + (16 + T) * tick - 0.02, midi: 62 },
    {
      start: 2 + (16 + T) * tick,
      end: 2 + (16 + 2 * T) * tick - 0.02,
      midi: 64,
    },
    { start: 2 + (16 + 2 * T) * tick, end: 2 + 32 * tick - 0.02, midi: 65 },
    { start: 2 + 32 * tick, end: 2 + 63 * tick, midi: 67 },
  ];
  it('off by default: the triplet is forced onto the 16th grid', () => {
    const q = quantize(notes, INFO);
    expect(q.grid).toBe('sixteenth');
    expect(q.events.some((e) => (e as QuantizedEventT).tuplet)).toBe(false);
  });
  it('on: the beat becomes one 8th triplet of written 8ths', () => {
    const r = quantizeDetailed(notes, INFO, {
      ...GRID,
      triplet: true,
      onsetBias: false,
    });
    expect(r.tripletBeats).toBe(1);
    expect(r.melody.grid).toBe('triplet');
    const ev = r.melody.events as QuantizedEventT[];
    const trip = ev.filter((e) => e.tuplet);
    expect(
      trip.map((e) => [
        e.tuplet!.slot,
        e.ticks,
        e.kind === 'note' ? e.midi : 'r',
      ]),
    ).toEqual([
      [0, 8, 62],
      [1, 8, 64],
      [2, 8, 65],
    ]);
    expect(checkQuantized(r.melody)).toEqual([]);
  });
  it('on: straight 16ths stay straight', () => {
    const s = sing(INFO, [
      [0, 4, 60],
      [4, 4, 62],
      [8, 8, 64],
      [16, 16, 65],
    ]);
    const r = quantizeDetailed(s, INFO, { ...GRID, triplet: true });
    expect(r.tripletBeats).toBe(0);
  });
});

describe('grid phase search (rule 1b)', () => {
  // a plain tune: quarters and eighths, mostly on beats
  const TUNE: S[] = [
    [0, 16, 60],
    [16, 16, 62],
    [32, 8, 64],
    [40, 8, 65],
    [48, 16, 67],
    [64, 16, 67],
    [80, 8, 65],
    [88, 8, 64],
    [96, 32, 62],
    [128, 16, 60],
    [144, 16, 64],
    [160, 32, 67],
  ];
  const beatSec = 60 / INFO.bpm;
  const sungT = sing(INFO, TUNE, {
    jitter: (i) =>
      [
        0.01, -0.012, 0.006, 0, -0.008, 0.011, -0.004, 0.009, -0.01, 0.003,
        0.007, -0.006,
      ][i],
  });

  it('estimateGridPhaseSteps: beats win over 16th offsets; the prior and the anchor pick the beat', () => {
    const g = beatGrid(INFO);
    const opt = {
      phaseRangeBeats: 1.5,
      phasePriorBeats: 0.75,
      phaseLevelWeights: [0, 0.5, 1, 1.05, 1.1],
      phaseAnchorBeats: 0.25,
      phaseAnchorWeight: 10,
    };
    const u = TUNE.map(([st]) => st);
    const dur = TUNE.map(([, ti]) => ti);
    expect(estimateGridPhaseSteps(u, dur, g, opt)).toBe(0);
    // the given head is 1 16th late: onsets at -4 relative to it -> k = -1
    expect(
      estimateGridPhaseSteps(
        u.map((x) => x - 4),
        dur,
        g,
        opt,
      ),
    ).toBe(-1);
    // 3 16ths early: k = +3 (a beat away from k = -1, which the prior alone would prefer) only with the anchor
    const u3 = u.map((x) => x + 12);
    expect(
      estimateGridPhaseSteps(u3, dur, g, { ...opt, phaseAnchorWeight: 0 }),
    ).toBe(-1);
    expect(
      estimateGridPhaseSteps(u3, dur, g, opt, { u: u3[0], target: 0 }),
    ).toBe(3);
    // a tight prior (bar head given) keeps 0 against weak evidence
    expect(
      estimateGridPhaseSteps([4, 20, 36], [16, 16, 16], g, {
        ...opt,
        phasePriorBeats: 0.05,
      }),
    ).toBe(0);
  });

  it('bar head given (default bar prior): same result as without the search', () => {
    const on = quantizeDetailed(sungT, INFO, GRID);
    const off = quantizeDetailed(sungT, INFO, { ...GRID, phaseSearch: false });
    expect(on.phaseSteps).toBe(0);
    expect(shape(on.melody)).toEqual(shape(off.melody));
    expect(on.melody.givenStartSec).toBe(INFO.startSec);
    expect(on.melody.phaseOffsetSec).toBe(0);
    expect(off.melody.givenStartSec).toBeUndefined();
  });

  for (const err of [-0.7, -0.3, 0.4, 0.9]) {
    it(`approximate first note (${err} beats off) with its tick: the written ticks come back`, () => {
      const first = sungT[0].start + err * beatSec;
      const q = quantizeDetailed(
        sungT,
        {
          bpm: INFO.bpm,
          ts: INFO.ts,
          startSec: first,
          firstNoteSec: first,
          firstNoteTick: 0,
        },
        GRID,
      );
      expect(shape(q.melody).filter((e) => e[0] !== 'r')).toEqual(TUNE);
      // whole steps from the phase search, the rest from the onset bias
      expect(Math.abs(q.melody.startSec - INFO.startSec)).toBeLessThan(
        0.5 * (beatSec / 4),
      );
      expect(
        Math.abs(q.melody.startSec + q.melody.onsetBiasSec - INFO.startSec),
      ).toBeLessThan(0.02);
      expect(q.melody.givenStartSec).toBeCloseTo(first, 9);
    });
  }

  it('first note only (no tick): it becomes bar 1 beat 1 and the rest follows', () => {
    // a pickup: the tune starts on beat 4 (tick 48) of bar 1; the user only knows the first note's second (~0.6 beat early)
    const pick = sing(
      INFO,
      TUNE.map(([st, ti, m]) => [st + 48, ti, m] as S),
    );
    const first = pick[0].start - 0.6 * beatSec;
    const q = quantize(
      pick,
      { bpm: INFO.bpm, ts: INFO.ts, startSec: first, firstNoteSec: first },
      GRID,
    );
    expect(shape(q).filter((e) => e[0] !== 'r')).toEqual(TUNE);
  });

  it('a negative bar-1 head works (recording starts inside a pickup bar)', () => {
    const neg: HumInfo = { bpm: 100, ts: [4, 4], startSec: -0.9 };
    const s = sing(neg, [
      [48, 16, 60],
      [64, 16, 62],
      [80, 32, 64],
    ]);
    const q = quantize(s, neg, GRID);
    expect(shape(q)).toEqual([
      ['r', 0, 48],
      [48, 16, 60],
      [64, 16, 62],
      [80, 32, 64],
      ['r', 112, 16],
    ]);
    expect(checkQuantized(q)).toEqual([]);
  });
});
