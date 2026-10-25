import { describe, expect, it } from 'vitest';
import { parseSong } from './parseSong';
import type { ChartSection } from './song';
import {
  DEFAULT_TEMPO,
  approach,
  barAt,
  barSeconds,
  buildScrollPlan,
  buildTimeline,
  countInBeats,
  estimateChartBars,
  lineBarCount,
  planScrollTopAt,
  planStepAt,
  planTimeAtScrollTop,
  rescaleTime,
  sectionAt,
  type TimedUnit,
} from './autoScroll';

const b44 = { num: 4, den: 4 };
const b34 = { num: 3, den: 4 };
const b68 = { num: 6, den: 8 };
const bars = (n: number, bar = b44) => Array.from({ length: n }, () => bar);

describe('barSeconds', () => {
  it('4/4 at ♩=120 is 2 seconds', () => {
    expect(barSeconds(b44, 120, 100)).toBeCloseTo(2);
  });
  it('3/4 at ♩=60 is 3 seconds', () => {
    expect(barSeconds(b34, 60, 100)).toBeCloseTo(3);
  });
  it('6/8 counts quarter notes: 3 quarters at ♩=100 is 1.8 seconds', () => {
    expect(barSeconds(b68, 100, 100)).toBeCloseTo(1.8);
  });
  it('2/2 is as long as 4/4', () => {
    expect(barSeconds({ num: 2, den: 2 }, 100, 100)).toBeCloseTo(
      barSeconds(b44, 100, 100),
    );
  });
  it('speed scales inversely', () => {
    expect(barSeconds(b44, 120, 50)).toBeCloseTo(4);
    expect(barSeconds(b44, 120, 150)).toBeCloseTo(4 / 3);
  });
  it('falls back to DEFAULT_TEMPO / 100% for invalid values', () => {
    const ref = barSeconds(b44, DEFAULT_TEMPO, 100);
    expect(DEFAULT_TEMPO).toBe(100);
    expect(barSeconds(b44, 0, 100)).toBeCloseTo(ref);
    expect(barSeconds(b44, Number.NaN, 100)).toBeCloseTo(ref);
    expect(barSeconds(b44, -5, 100)).toBeCloseTo(ref);
    expect(barSeconds(b44, 100, 0)).toBeCloseTo(ref);
    expect(barSeconds(b44, 100, Number.NaN)).toBeCloseTo(ref);
  });
  it('is 0 for a malformed bar', () => {
    expect(barSeconds({ num: 0, den: 4 }, 100, 100)).toBe(0);
    expect(barSeconds({ num: 4, den: 0 }, 100, 100)).toBe(0);
  });
});

describe('buildTimeline', () => {
  it('is empty for no units', () => {
    expect(buildTimeline([], 120, 100)).toEqual({ keys: [], duration: 0 });
  });

  it('places one key per unit top plus an end key at the last bottom', () => {
    const units: TimedUnit[] = [
      { top: 100, height: 200, bars: bars(4) },
      { top: 300, height: 150, bars: bars(2) },
    ];
    const tl = buildTimeline(units, 120, 100);
    expect(tl.keys).toEqual([
      { t: 0, y: 100 },
      { t: 8, y: 300 },
      { t: 12, y: 450 },
    ]);
    expect(tl.duration).toBe(12);
  });

  it('sums mixed time signatures inside a unit', () => {
    const tl = buildTimeline(
      [{ top: 0, height: 100, bars: [b44, b34, b68] }],
      60,
      100,
    );
    // 4 + 3 + 3 seconds
    expect(tl.duration).toBeCloseTo(10);
  });

  it('keeps zero-bar units as zero-length jumps', () => {
    const tl = buildTimeline(
      [
        { top: 0, height: 100, bars: bars(1) },
        { top: 100, height: 50, bars: [] },
        { top: 150, height: 100, bars: bars(1) },
      ],
      120,
      100,
    );
    expect(tl.keys).toEqual([
      { t: 0, y: 0 },
      { t: 2, y: 100 },
      { t: 2, y: 150 },
      { t: 4, y: 250 },
    ]);
  });

  it('halves duration at 200% tempo-equivalent (speed)', () => {
    const units = [{ top: 0, height: 100, bars: bars(4) }];
    expect(buildTimeline(units, 120, 50).duration).toBeCloseTo(16);
    expect(buildTimeline(units, 120, 150).duration).toBeCloseTo(16 / 3);
  });
});

describe('rescaleTime (speed change mid-play keeps the position)', () => {
  const units: TimedUnit[] = [
    { top: 0, height: 300, bars: [b44, b34, b68] },
    { top: 350, height: 300, bars: bars(3) },
  ];
  const view = {
    height: 500,
    bottomReserve: 60,
    topGap: 16,
    maxScrollTop: 9999,
  };
  it('maps a time on the old plan to the same scrollTop on the new one', () => {
    const before = buildScrollPlan(units, 90, 100, view);
    const after = buildScrollPlan(units, 90, 135, view);
    for (const t of [0, 1.3, 5, 9.9, before.duration]) {
      expect(planScrollTopAt(after, rescaleTime(t, 100, 135))).toBeCloseTo(
        planScrollTopAt(before, t),
      );
    }
  });
  it('is the same time when the speed is unchanged', () => {
    expect(rescaleTime(4.2, 105, 105)).toBe(4.2);
  });
});

describe('sectionAt', () => {
  const tl = buildTimeline(
    [
      { top: 0, height: 100, bars: bars(1) }, // 0..2
      { top: 100, height: 50, bars: [] }, // 2..2
      { top: 150, height: 100, bars: bars(2) }, // 2..6
    ],
    120,
    100,
  );
  it('returns the index of the unit playing at t', () => {
    expect(sectionAt(tl, 0)).toBe(0);
    expect(sectionAt(tl, 1.99)).toBe(0);
    expect(sectionAt(tl, 2)).toBe(2); // the zero-length unit is skipped
    expect(sectionAt(tl, 5)).toBe(2);
  });
  it('clamps before the start and at/after the end', () => {
    expect(sectionAt(tl, -1)).toBe(0);
    expect(sectionAt(tl, 6)).toBe(2);
    expect(sectionAt(tl, 100)).toBe(2);
  });
  it('is -1 for an empty timeline', () => {
    expect(sectionAt({ keys: [], duration: 0 }, 0)).toBe(-1);
  });
});

describe('barAt / countInBeats (count-in uses the starting bar)', () => {
  const units: TimedUnit[] = [
    { top: 0, height: 100, bars: [b44, b44] }, // 0..2.4..4.8 at ♩=100
    { top: 100, height: 100, bars: [] },
    { top: 200, height: 100, bars: [b68, b34] }, // 4.8..6.6..8.4
  ];
  it('finds the bar that contains t', () => {
    expect(barAt(units, 100, 100, 0)).toEqual(b44);
    expect(barAt(units, 100, 100, 4.8)).toEqual(b68);
    expect(barAt(units, 100, 100, 7)).toEqual(b34);
  });
  it('uses the last bar at or after the end, the first before the start', () => {
    expect(barAt(units, 100, 100, 8.4)).toEqual(b34);
    expect(barAt(units, 100, 100, -2)).toEqual(b44);
  });
  it('is null when there are no bars', () => {
    expect(barAt([], 100, 100, 0)).toBeNull();
    expect(barAt([{ top: 0, height: 10, bars: [] }], 100, 100, 0)).toBeNull();
  });
  it('counts the numerator', () => {
    expect(countInBeats(b44)).toBe(4);
    expect(countInBeats(b34)).toBe(3);
    expect(countInBeats(b68)).toBe(6);
  });
});

describe('estimateChartBars (sections without bars: chord count)', () => {
  const sec = (lines: ChartSection['lines']): ChartSection => ({
    kind: 'verse',
    label: 'A',
    lines,
  });
  it('counts one bar per chord', () => {
    const s = sec([
      {
        segments: [
          { chord: 'C', lyrics: 'あ' },
          { chord: 'G', lyrics: 'い' },
        ],
      },
      { segments: [{ chord: 'Am', lyrics: 'う' }] },
    ]);
    expect(estimateChartBars(s, b34)).toEqual([b34, b34, b34]);
  });
  it('counts a chordless lyric line as one bar', () => {
    expect(lineBarCount({ segments: [{ lyrics: 'ららら' }] })).toBe(1);
    expect(
      lineBarCount({
        segments: [{ lyrics: 'ら' }, { chord: 'F', lyrics: 'ら' }],
      }),
    ).toBe(1);
  });
  it('ignores blank lines and raw lines', () => {
    expect(lineBarCount({ segments: [] })).toBe(0);
    expect(lineBarCount({ raw: '# memo' })).toBe(0);
    expect(
      estimateChartBars(sec([{ segments: [] }, { raw: '{c: x}' }]), b44),
    ).toEqual([]);
  });
  it('is empty for no chart section', () => {
    expect(estimateChartBars(undefined, b44)).toEqual([]);
  });
});

describe('lineBarCount of dash lines', () => {
  const dash = (text: string) => {
    const song = parseSong(`{start_of_verse: A}\n${text}\n{end_of_verse}\n`);
    return song.chart[0].lines[0];
  };
  it('counts the | delimited bars, not the chords', () => {
    expect(
      lineBarCount(
        dash('|[C]--------|[C]----[F]----|[G]--------|[G]----[G7]----|'),
      ),
    ).toBe(4);
    expect(lineBarCount(dash('|[C]--------|[G]--------|'))).toBe(2);
    expect(lineBarCount(dash('| [C][G] |'))).toBe(1);
  });
  it('keeps the old rule for non-dash lines', () => {
    expect(lineBarCount(dash('[C]--------[G]--------'))).toBe(2);
    expect(lineBarCount(dash('きらきら | ひかる'))).toBe(1);
  });
});

describe('buildScrollPlan / planScrollTopAt (issue #62: system by system)', () => {
  // ♩=120 4/4: a bar is 2s, a beat 0.5s → the ease is 0.5s (the last beat).
  const view = {
    height: 800,
    bottomReserve: 100,
    topGap: 16,
    maxScrollTop: 5000,
  };
  const sys = (top: number, height = 200, n = 4): TimedUnit => ({
    top,
    height,
    bars: bars(n),
  });
  const three = [sys(100), sys(320), sys(540)];
  const plan = buildScrollPlan(three, 120, 100, view);
  const at = (t: number) => planScrollTopAt(plan, t);

  it('lasts as long as the timeline', () => {
    expect(plan.duration).toBeCloseTo(buildTimeline(three, 120, 100).duration);
  });

  it('keeps the playing system still (first one fits → scrollTop 0)', () => {
    for (const t of [0, 1, 4, 7, 7.5]) expect(at(t)).toBe(0);
  });

  it('eases to the next system during the last beat, ending at the bar line', () => {
    expect(at(7.75)).toBeCloseTo(152); // halfway (smoothstep)
    expect(at(7.6)).toBeGreaterThan(0);
    expect(at(7.6)).toBeLessThan(152);
    expect(at(8)).toBeCloseTo(304);
  });

  it('puts the next system topGap below the top, the one after still visible', () => {
    const top = at(9);
    expect(top).toBe(320 - 16);
    // u2 bottom stays above the bar (visible = 800 − 100).
    expect(540 + 200 - top).toBeLessThanOrEqual(700);
    for (const t of [8, 10, 15.5]) expect(at(t)).toBe(304);
  });

  it('the last system rests at the top and stays there at and after the end', () => {
    expect(at(17)).toBe(524);
    expect(at(24)).toBe(524);
    expect(at(99)).toBe(524);
  });

  it('never scrolls past maxScrollTop', () => {
    const p = buildScrollPlan(three, 120, 100, { ...view, maxScrollTop: 400 });
    expect(planScrollTopAt(p, 9)).toBe(304);
    expect(planScrollTopAt(p, 17)).toBe(400);
  });

  it('a first system that does not fit from the top rests at its own top', () => {
    const p = buildScrollPlan([sys(600), sys(820)], 120, 100, view);
    expect(planScrollTopAt(p, 0)).toBe(584);
  });

  it('is tempo-aware: one beat, clamped to 0.3–0.5s', () => {
    // ♩=240: a bar is 1s, a beat 0.25s → 0.3s ease before t=4.
    const fast = buildScrollPlan(three, 240, 100, view);
    expect(planScrollTopAt(fast, 3.69)).toBe(0);
    expect(planScrollTopAt(fast, 3.85)).toBeCloseTo(152);
    // ♩=60: a beat is 1s → 0.5s ease before t=16.
    const slow = buildScrollPlan(three, 60, 100, view);
    expect(planScrollTopAt(slow, 15.4)).toBe(0);
    expect(planScrollTopAt(slow, 15.75)).toBeCloseTo(152);
    // ♩=200: a beat is 0.3s.
    const p200 = buildScrollPlan(three, 200, 100, view);
    const end = 4 * barSeconds(b44, 200, 100);
    expect(planScrollTopAt(p200, end - 0.31)).toBe(0);
    expect(planScrollTopAt(p200, end - 0.15)).toBeCloseTo(152);
  });

  it('follows the speed (50% doubles every time)', () => {
    const half = buildScrollPlan(three, 120, 50, view);
    expect(half.duration).toBeCloseTo(48);
    expect(planScrollTopAt(half, 15)).toBe(0);
    expect(planScrollTopAt(half, 16)).toBeCloseTo(304);
  });

  it('a very short system eases over at most half of it', () => {
    // 1 bar of 2/4 at ♩=240 = 0.5s → 0.25s ease.
    const short = { top: 100, height: 200, bars: [{ num: 2, den: 4 }] };
    const p = buildScrollPlan([short, sys(320)], 240, 100, view);
    expect(planScrollTopAt(p, 0.2)).toBe(0);
    expect(planScrollTopAt(p, 0.375)).toBeCloseTo(152);
  });

  it('skips units without bars', () => {
    const p = buildScrollPlan(
      [sys(100), sys(320, 200, 0), sys(540)],
      120,
      100,
      view,
    );
    expect(p.steps).toHaveLength(2);
    expect(planScrollTopAt(p, 9)).toBe(524);
  });

  it('a system taller than the view scrolls continuously inside it', () => {
    // visible below the gap: 700 − 16; the tall one is 1000px.
    const p = buildScrollPlan(
      [sys(100), sys(320, 1000), sys(1340)],
      120,
      100,
      view,
    );
    expect(planScrollTopAt(p, 8)).toBeCloseTo(304);
    // Its bottom reaches the bar's top when the ease begins (t = 15.5).
    expect(planScrollTopAt(p, 15.5)).toBeCloseTo(320 + 1000 - 700);
    const mid = planScrollTopAt(p, 11.75);
    expect(mid).toBeCloseTo((304 + 620) / 2);
    expect(planScrollTopAt(p, 16)).toBeCloseTo(1324);
  });

  it('a tall last system scrolls until its bottom is above the bar', () => {
    const p = buildScrollPlan([sys(100), sys(320, 1000)], 120, 100, view);
    expect(planScrollTopAt(p, 16)).toBeCloseTo(620);
    expect(planScrollTopAt(p, 30)).toBeCloseTo(620);
  });

  it('keeps time-less lines above a system (leadTop) when they fit', () => {
    const p = buildScrollPlan(
      [sys(100), { ...sys(400), leadTop: 330 }, sys(620)],
      120,
      100,
      view,
    );
    expect(planScrollTopAt(p, 9)).toBe(314);
    const tooTall = buildScrollPlan(
      [sys(100), { ...sys(400, 600), leadTop: 200 }],
      120,
      100,
      view,
    );
    expect(planScrollTopAt(tooTall, 9)).toBe(384);
  });

  it('an empty plan stays at 0', () => {
    const p = buildScrollPlan([], 120, 100, view);
    expect(p.duration).toBe(0);
    expect(planScrollTopAt(p, 3)).toBe(0);
    expect(planStepAt(p, 3)).toBe(-1);
    expect(planTimeAtScrollTop(p, 300)).toBe(0);
  });

  it('planStepAt: the system playing at t (clamped)', () => {
    expect(planStepAt(plan, -1)).toBe(0);
    expect(planStepAt(plan, 7.9)).toBe(0);
    expect(planStepAt(plan, 8)).toBe(1);
    expect(planStepAt(plan, 99)).toBe(2);
  });

  it('planTimeAtScrollTop: the start of the system resting nearest', () => {
    expect(planTimeAtScrollTop(plan, 0)).toBe(0);
    expect(planTimeAtScrollTop(plan, 140)).toBe(0);
    expect(planTimeAtScrollTop(plan, 160)).toBe(8);
    expect(planTimeAtScrollTop(plan, 304)).toBe(8);
    expect(planTimeAtScrollTop(plan, 3000)).toBe(16);
  });
});

describe('approach (settling after a finger scroll)', () => {
  it('moves part of the way, more with more time', () => {
    const a = approach(0, 100, 0.016, 0.12);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(100);
    expect(approach(0, 100, 0.5, 0.12)).toBeGreaterThan(95);
  });
  it('snaps when within half a pixel', () => {
    expect(approach(99.6, 100, 0.001, 0.12)).toBe(100);
  });
  it('dt 0 stays', () => {
    expect(approach(10, 100, 0, 0.12)).toBe(10);
  });
});
