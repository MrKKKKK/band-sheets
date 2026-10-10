import { describe, expect, it } from 'vitest';
import {
  chartOnlySongText,
  viewerSongText,
} from '../../lib/fixtures/viewerFixtures';
import { parseSong } from '../../lib/parseSong';
import { buildViewerSections } from '../../lib/viewerSections';
import {
  droppedLyricsParts,
  planSheet,
  sheetAnchorAt,
  sheetAnchorY,
  shownParts,
  type SheetOptions,
  type SheetUnit,
} from './sheetModel';

const song = parseSong(viewerSongText);
const { sections } = buildViewerSections(song);
const part = (p: string | null): SheetOptions => ({
  layout: 'part',
  part: p,
  scoreHidden: [],
  scoreChart: true,
});
const score = (hidden: string[], chart = true): SheetOptions => ({
  layout: 'score',
  part: null,
  scoreHidden: hidden,
  scoreChart: chart,
});

describe('shownParts', () => {
  it('part layout: the chosen part, none for chart only / unknown', () => {
    expect(shownParts(song, part('Bass'))).toEqual(['Bass']);
    expect(shownParts(song, part(null))).toEqual([]);
    expect(shownParts(song, part('Nope'))).toEqual([]);
  });
  it('score layout: all but hidden, song order', () => {
    expect(shownParts(song, score(['Bass']))).toEqual(['Vocal', 'Drums']);
  });
});

describe('planSheet', () => {
  it('part layout: chart everywhere, the part where it has bars', () => {
    const blocks = planSheet(song, sections, part('Vocal'));
    expect(blocks.map((b) => b.label)).toEqual([
      'A',
      'B',
      'Fill',
      'A',
      'C',
      '',
    ]);
    const [a, b, fill, a2, c, fine] = blocks;
    expect(a.chart).toBeDefined();
    expect(a.score?.trackCount).toBe(1);
    expect(a.score?.bars).toHaveLength(4);
    expect(b.score?.shuffleMarks).toBeUndefined();
    // Fill: drums only, no chart → a placeholder carrying its 1 bar.
    expect(fill.chart).toBeUndefined();
    expect(fill.score).toBeUndefined();
    expect(fill.restBars).toHaveLength(1);
    expect(a2.firstBar).toBe(10);
    expect(c.firstBar).toBe(14);
    // "Fine" comment: raw line only, no bars → shown, estimated 0 bars.
    expect(fine.chart).toBeDefined();
    expect(fine.chartBars).toEqual([]);
  });

  it('chart only: chart blocks carry the section time', () => {
    const blocks = planSheet(song, sections, part(null));
    expect(blocks[0].score).toBeUndefined();
    expect(blocks[0].chartBars).toHaveLength(4);
  });

  it('score layout: drum shuffle mark on B, extra bars of hidden parts', () => {
    const blocks = planSheet(song, sections, score([]));
    const b = blocks[1];
    expect(b.score?.trackCount).toBe(3);
    expect(b.score?.shuffleMarks).toEqual([{ track: 2, shuffle: '8' }]);
    // Fill inherits B's shuffle; the repeated A returns to straight.
    const [, , fill, a2, c] = blocks;
    expect(fill.score?.trackCount).toBe(1);
    expect(fill.score?.shuffleMarks).toEqual([{ track: 0, shuffle: '8' }]);
    expect(a2.score?.shuffleMarks).toEqual([{ track: 2, shuffle: 'none' }]);
    expect(c.score?.shuffleMarks).toBeUndefined();
    expect(fill.score?.extraBars).toEqual([]);
  });

  it('score without chart: chart-only sections become placeholders', () => {
    const only = parseSong(chartOnlySongText);
    const blocks = planSheet(
      only,
      buildViewerSections(only).sections,
      score([], false),
    );
    expect(blocks.map((b) => b.restBars?.length)).toEqual([3, 2]);
    expect(blocks[0].restBars?.[0]).toEqual({ num: 3, den: 4 });
  });
});

describe('droppedLyricsParts', () => {
  it('only shown parts with a part-level \\lyrics line', () => {
    expect(droppedLyricsParts(song, part('Vocal'))).toEqual(['Vocal']);
    expect(droppedLyricsParts(song, part('Bass'))).toEqual([]);
    expect(droppedLyricsParts(song, score(['Vocal']))).toEqual([]);
  });
});

describe('sheet anchors', () => {
  const before: SheetUnit[] = [
    { id: 'line:0-A:0', section: '0-A', top: 0, height: 40 },
    {
      id: 'score:0-A:0',
      section: '0-A',
      top: 40,
      height: 100,
      bars: { start: 0, count: 4 },
    },
    { id: 'line:1-B:0', section: '1-B', top: 140, height: 40 },
  ];
  // Zoomed: the 4 bars now take two systems.
  const after: SheetUnit[] = [
    { id: 'line:0-A:0', section: '0-A', top: 0, height: 60 },
    {
      id: 'score:0-A:0',
      section: '0-A',
      top: 60,
      height: 150,
      bars: { start: 0, count: 3 },
    },
    {
      id: 'score:0-A:3',
      section: '0-A',
      top: 210,
      height: 150,
      bars: { start: 3, count: 1 },
    },
    { id: 'line:1-B:0', section: '1-B', top: 360, height: 60 },
  ];

  it('keeps the bar on a score system across re-breaking', () => {
    const a = sheetAnchorAt(before, 40 + 87.5)!; // 3.5 bars in
    expect(a.bar).toBeCloseTo(3.5);
    expect(sheetAnchorY(after, a)).toBeCloseTo(210 + 75);
  });

  it('keeps a chart line by id + ratio', () => {
    const a = sheetAnchorAt(before, 150)!;
    expect(a.id).toBe('line:1-B:0');
    expect(sheetAnchorY(after, a)).toBeCloseTo(360 + 15);
  });

  it('falls back to the section start, then 0', () => {
    expect(
      sheetAnchorY(after, { id: 'rest:1-B', section: '1-B', ratio: 0.5 }),
    ).toBe(360);
    expect(
      sheetAnchorY(after, {
        id: 'score:1-B:0',
        section: '1-B',
        bar: 2,
        ratio: 0.5,
      }),
    ).toBe(360);
    expect(sheetAnchorY(after, { id: 'x', ratio: 0 })).toBe(0);
    expect(sheetAnchorY([], null)).toBe(0);
    expect(sheetAnchorAt([], 10)).toBeNull();
  });
});
