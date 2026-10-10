import { describe, expect, it } from 'vitest';
import type { ChartSection } from './song';
import {
  DEFAULT_TEMPO,
  barAt,
  barSeconds,
  buildTimeline,
  countInBeats,
  estimateChartBars,
  lineBarCount,
  rescaleTime,
  scrollTopAt,
  sectionAt,
  timeAtScrollTop,
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

describe('scrollTopAt', () => {
  const tl = buildTimeline(
    [
      { top: 100, height: 200, bars: bars(4) }, // t 0..8, y 100..400 (to the next top)
      { top: 400, height: 100, bars: bars(2) }, // t 8..12, y 400..500
    ],
    120,
    100,
  );

  it('interpolates linearly and subtracts the anchor', () => {
    expect(scrollTopAt(tl, 0, 50)).toBe(50);
    expect(scrollTopAt(tl, 4, 50)).toBeCloseTo(200);
    // keys are unit tops: the chart lines in the gap (300..400) are passed
    // through during the first unit (y 100 → 400 over t 0 → 8)
    expect(scrollTopAt(tl, 10, 0)).toBeCloseTo(450);
  });
  it('clamps time to the timeline and scrollTop to ≥ 0', () => {
    expect(scrollTopAt(tl, -3, 0)).toBe(100);
    expect(scrollTopAt(tl, 99, 0)).toBe(500);
    expect(scrollTopAt(tl, 0, 250)).toBe(0);
  });
  it('is 0 for an empty timeline', () => {
    expect(scrollTopAt({ keys: [], duration: 0 }, 5, 100)).toBe(0);
  });
  it('takes the later position at a zero-length jump', () => {
    const jump = buildTimeline(
      [
        { top: 0, height: 100, bars: bars(1) },
        { top: 100, height: 50, bars: [] },
        { top: 150, height: 100, bars: bars(1) },
      ],
      120,
      100,
    );
    expect(scrollTopAt(jump, 2, 0)).toBe(150);
    expect(scrollTopAt(jump, 1, 0)).toBeCloseTo(50);
  });
});

describe('timeAtScrollTop', () => {
  const tl = buildTimeline(
    [
      { top: 100, height: 200, bars: bars(4) },
      { top: 400, height: 100, bars: bars(2) },
    ],
    120,
    100,
  );

  it('inverts scrollTopAt', () => {
    for (const t of [0.5, 3, 7.9, 9, 11.5]) {
      expect(timeAtScrollTop(tl, scrollTopAt(tl, t, 80), 80)).toBeCloseTo(t);
    }
  });
  it('starts from 0 when the first unit is not yet past the anchor line', () => {
    expect(timeAtScrollTop(tl, 0, 0)).toBe(0);
    expect(timeAtScrollTop(tl, 0, 250)).toBe(0);
    expect(timeAtScrollTop(tl, 20, 50)).toBe(0);
  });
  it('returns duration beyond the end', () => {
    expect(timeAtScrollTop(tl, 10_000, 0)).toBe(12);
  });
  it('is 0 for an empty timeline', () => {
    expect(timeAtScrollTop({ keys: [], duration: 0 }, 300, 100)).toBe(0);
  });
  it('maps a y inside a zero-length jump to the jump time', () => {
    const jump = buildTimeline(
      [
        { top: 0, height: 100, bars: bars(1) },
        { top: 100, height: 50, bars: [] },
        { top: 150, height: 100, bars: bars(1) },
      ],
      120,
      100,
    );
    expect(timeAtScrollTop(jump, 120, 0)).toBe(2);
    expect(timeAtScrollTop(jump, 200, 0)).toBeCloseTo(3);
  });
  it('maps a flat stretch (zero-height unit) to its start', () => {
    const flat = buildTimeline(
      [
        { top: 0, height: 100, bars: bars(1) },
        { top: 100, height: 0, bars: bars(2) }, // t 2..6 at y 100
        { top: 100, height: 100, bars: bars(1) },
      ],
      120,
      100,
    );
    expect(timeAtScrollTop(flat, 100, 0)).toBe(2);
    expect(scrollTopAt(flat, 4, 0)).toBe(100);
  });
});

describe('rescaleTime (speed change mid-play keeps the position)', () => {
  const units: TimedUnit[] = [
    { top: 0, height: 300, bars: [b44, b34, b68] },
    { top: 350, height: 300, bars: bars(3) },
  ];
  it('maps a time on the old timeline to the same y on the new one', () => {
    const before = buildTimeline(units, 90, 100);
    const after = buildTimeline(units, 90, 135);
    for (const t of [0, 1.3, 5, 9.9, before.duration]) {
      expect(scrollTopAt(after, rescaleTime(t, 100, 135), 120)).toBeCloseTo(
        scrollTopAt(before, t, 120),
      );
    }
  });
  it('is the same time when the speed is unchanged', () => {
    expect(rescaleTime(4.2, 105, 105)).toBe(4.2);
  });
  it('agrees with timeAtScrollTop on the new timeline', () => {
    const before = buildTimeline(units, 90, 100);
    const after = buildTimeline(units, 90, 60);
    const st = scrollTopAt(before, 7, 100);
    expect(timeAtScrollTop(after, st, 100)).toBeCloseTo(
      rescaleTime(7, 100, 60),
    );
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
