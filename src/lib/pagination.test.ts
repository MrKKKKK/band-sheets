import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  anchorY,
  pageIndexAt,
  paginate,
  type FlowUnit,
} from './pagination';

const col = (heights: number[], keep: number[] = []): FlowUnit[] => {
  let top = 0;
  return heights.map((height, i) => {
    const u: FlowUnit = { top, height };
    if (keep.includes(i)) u.keepWithNext = true;
    top += height;
    return u;
  });
};

describe('paginate', () => {
  it('returns one page of viewport height when empty', () => {
    expect(paginate([], 100)).toEqual([{ top: 0, bottom: 100 }]);
  });

  it('packs units without splitting them', () => {
    expect(paginate(col([40, 40, 40, 40]), 100)).toEqual([
      { top: 0, bottom: 80 },
      { top: 80, bottom: 160 },
    ]);
  });

  it('fits exactly', () => {
    expect(paginate(col([50, 50, 50]), 100)).toEqual([
      { top: 0, bottom: 100 },
      { top: 100, bottom: 150 },
    ]);
  });

  it('keeps a keepWithNext unit with the next one', () => {
    expect(paginate(col([40, 40, 40], [1]), 100)).toEqual([
      { top: 0, bottom: 40 },
      { top: 40, bottom: 120 },
    ]);
  });

  it('chains keepWithNext', () => {
    expect(paginate(col([30, 30, 30, 30], [1, 2]), 100)).toEqual([
      { top: 0, bottom: 30 },
      { top: 30, bottom: 120 },
    ]);
  });

  it('ignores keepWithNext when the chain is taller than a page', () => {
    expect(paginate(col([60, 60], [0]), 100)).toEqual([
      { top: 0, bottom: 60 },
      { top: 60, bottom: 120 },
    ]);
  });

  it('ignores keepWithNext on the last unit', () => {
    expect(paginate(col([40, 40], [1]), 100)).toEqual([{ top: 0, bottom: 80 }]);
  });

  it('cuts a unit taller than the page every viewport height', () => {
    expect(paginate(col([250]), 100)).toEqual([
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
      { top: 200, bottom: 250 },
    ]);
  });

  it('lets following units share the last chunk of a tall unit', () => {
    expect(paginate(col([30, 150, 30]), 100)).toEqual([
      { top: 0, bottom: 30 },
      { top: 30, bottom: 130 },
      { top: 130, bottom: 210 },
    ]);
  });

  it('handles zero-height units', () => {
    expect(paginate(col([0, 60, 0, 60]), 100)).toEqual([
      { top: 0, bottom: 60 },
      { top: 60, bottom: 120 },
    ]);
    expect(paginate(col([0, 0]), 100)).toEqual([{ top: 0, bottom: 0 }]);
  });

  it('starts the first page at 0 even when content starts lower', () => {
    const units: FlowUnit[] = [{ top: 20, height: 50 }];
    expect(paginate(units, 100)).toEqual([{ top: 0, bottom: 70 }]);
  });

  it('leaves the gap between pages out of both pages', () => {
    const units: FlowUnit[] = [
      { top: 0, height: 60 },
      { top: 70, height: 60 },
    ];
    expect(paginate(units, 100)).toEqual([
      { top: 0, bottom: 60 },
      { top: 70, bottom: 130 },
    ]);
  });
});

describe('pageIndexAt', () => {
  const pages = [
    { top: 0, bottom: 60 },
    { top: 70, bottom: 130 },
  ];
  it('finds the page containing y', () => {
    expect(pageIndexAt(pages, 0)).toBe(0);
    expect(pageIndexAt(pages, 59)).toBe(0);
    expect(pageIndexAt(pages, 70)).toBe(1);
    expect(pageIndexAt(pages, 500)).toBe(1);
  });
  it('puts a gap into the page before and clamps negatives', () => {
    expect(pageIndexAt(pages, 65)).toBe(0);
    expect(pageIndexAt(pages, -10)).toBe(0);
  });
  it('returns 0 for no pages', () => {
    expect(pageIndexAt([], 10)).toBe(0);
  });
});

describe('anchorOf / anchorY', () => {
  const units = col([100, 50, 0, 50]);
  it('maps y to unit and ratio', () => {
    expect(anchorOf(units, 0)).toEqual({ unit: 0, ratio: 0 });
    expect(anchorOf(units, 25)).toEqual({ unit: 0, ratio: 0.25 });
    expect(anchorOf(units, 125)).toEqual({ unit: 1, ratio: 0.5 });
    expect(anchorOf(units, 150)).toEqual({ unit: 3, ratio: 0 });
  });
  it('clamps before the start and after the end', () => {
    expect(anchorOf(units, -5)).toEqual({ unit: 0, ratio: 0 });
    expect(anchorOf(units, 999)).toEqual({ unit: 3, ratio: 1 });
  });
  it('returns the end of the previous unit inside a gap', () => {
    const gap: FlowUnit[] = [
      { top: 0, height: 10 },
      { top: 20, height: 10 },
    ];
    expect(anchorOf(gap, 15)).toEqual({ unit: 0, ratio: 1 });
  });
  it('handles empty units', () => {
    expect(anchorOf([], 50)).toEqual({ unit: 0, ratio: 0 });
    expect(anchorY([], { unit: 0, ratio: 0.5 })).toBe(0);
  });
  it('round-trips and keeps position when units get scaled (zoom)', () => {
    const y = 125;
    const a = anchorOf(units, y);
    expect(anchorY(units, a)).toBe(y);
    const zoomed = units.map((u) => ({
      top: u.top * 1.5,
      height: u.height * 1.5,
    }));
    expect(anchorY(zoomed, a)).toBe(187.5);
  });
  it('clamps out-of-range anchors', () => {
    expect(anchorY(units, { unit: 99, ratio: 2 })).toBe(200);
    expect(anchorY(units, { unit: -1, ratio: -1 })).toBe(0);
  });
});
