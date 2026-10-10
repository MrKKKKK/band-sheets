/**
 * Pure helpers behind `ViewerSheet` (M6 T14): which blocks the sheet shows
 * for the current settings (`planSheet`), and a reading-position anchor that
 * survives a re-layout (`sheetAnchorAt` / `sheetAnchorY`).
 */
import { estimateChartBars, type TimedUnit } from '../../lib/autoScroll';
import { hasPartLevelLyrics } from '../../lib/melodyPart';
import { anchorOf, type FlowUnit } from '../../lib/pagination';
import type { ChartSection, Song } from '../../lib/song';
import {
  sectionScoreTex,
  songTimeSig,
  type BarInfo,
  type ShuffleMarkAt,
  type ViewerSection,
} from '../../lib/viewerSections';
import type { ViewerSettings } from '../../lib/viewerSettings';

export type SheetOptions = Pick<
  ViewerSettings,
  'layout' | 'part' | 'scoreHidden' | 'scoreChart'
>;

export interface SheetScore {
  tex: string;
  trackCount: number;
  /** One per drum track that has a Shuffle / Straight mark (R5). */
  shuffleMarks?: ShuffleMarkAt[];
  /** Bars of the shown tracks (the longest one); what the systems hold. */
  bars: BarInfo[];
  /**
   * The section's remaining bars that only hidden parts have: their time is
   * added to the last system so auto-scroll stays in step with the band.
   */
  extraBars: BarInfo[];
}

export interface SheetBlock {
  /** `ViewerSection.key`. */
  key: string;
  /** Gutter label ('' = none): the label, or the chart section's kind. */
  label: string;
  firstBar: number;
  /** The chart section, when it is shown. */
  chart?: ChartSection;
  score?: SheetScore;
  /**
   * Chart shown without a score: the whole section's time, carried by the
   * chart block (estimated from its chords when no part has bars).
   */
  chartBars?: BarInfo[];
  /**
   * Nothing of the section is shown, but it takes time: a one-line
   * placeholder ("N 小節") carries it.
   */
  restBars?: BarInfo[];
}

/** Part names shown with these settings, in song order. */
export function shownParts(song: Song, opts: SheetOptions): string[] {
  const names = song.parts.map((p) => p.name);
  if (opts.layout === 'part') {
    return opts.part !== null && names.includes(opts.part) ? [opts.part] : [];
  }
  return names.filter((n) => !opts.scoreHidden.includes(n));
}

function sectionTime(song: Song, s: ViewerSection): BarInfo[] {
  return s.bars.length
    ? s.bars
    : estimateChartBars(s.chart, songTimeSig(song.meta));
}

export function planSheet(
  song: Song,
  sections: readonly ViewerSection[],
  opts: SheetOptions,
): SheetBlock[] {
  const parts = shownParts(song, opts);
  const withChart = opts.layout === 'part' || opts.scoreChart;
  const blocks: SheetBlock[] = [];
  for (const s of sections) {
    const chart =
      withChart && s.chart && s.chart.lines.length > 0 ? s.chart : undefined;
    const block: SheetBlock = {
      key: s.key,
      label: s.label || s.chart?.kind || '',
      firstBar: s.firstBar,
    };
    if (chart) block.chart = chart;
    const doc = sectionScoreTex(s, parts);
    if (doc) {
      const bars = s.parts
        .filter((p) => parts.includes(p.part))
        .reduce<BarInfo[]>(
          (longest, p) => (p.bars.length > longest.length ? p.bars : longest),
          [],
        );
      block.score = {
        tex: doc.tex,
        trackCount: doc.trackCount,
        bars,
        extraBars: s.bars.slice(bars.length),
      };
      if (doc.shuffleMarks) block.score.shuffleMarks = doc.shuffleMarks;
    } else if (chart) {
      block.chartBars = sectionTime(song, s);
    } else {
      const bars = sectionTime(song, s);
      if (bars.length === 0) continue;
      block.restBars = bars;
    }
    blocks.push(block);
  }
  return blocks;
}

/** Shown parts whose part-level `\lyrics` line the viewer drops. */
export function droppedLyricsParts(song: Song, opts: SheetOptions): string[] {
  const shown = shownParts(song, opts);
  return song.parts
    .filter((p) => shown.includes(p.name) && hasPartLevelLyrics(p.body))
    .map((p) => p.name);
}

// ---------------------------------------------------------------------------
// Measured layout

export interface SheetUnit extends FlowUnit {
  /**
   * Stable across zoom / part changes: `notice`, `line:<key>:<i>`,
   * `score:<key>:<barStart>`, `score-error:<key>`, `rest:<key>`, `credit`, `empty`.
   */
  id: string;
  /** Section key (absent for notices / the credit line). */
  section?: string;
  /** Score systems only: which of the section's bars the system holds. */
  bars?: { start: number; count: number };
}

export interface SheetTimedUnit extends TimedUnit {
  /** Section key, for the "now playing" highlight. */
  section: string;
}

export interface SheetLayout {
  /** Every score has reported a layout for the current tex and zoom. */
  ready: boolean;
  /** Pagination units, top to bottom (px from the sheet's top). */
  units: SheetUnit[];
  /** Auto-scroll units (`buildTimeline` input), top to bottom. */
  timedUnits: SheetTimedUnit[];
}

/**
 * A reading position that survives a re-layout. On a score system it is a
 * fractional bar of the section (systems re-break when zooming), elsewhere
 * a unit id + ratio.
 */
export interface SheetAnchor {
  id: string;
  section?: string;
  /** Fractional bar within the section (score systems only). */
  bar?: number;
  ratio: number;
}

export function sheetAnchorAt(
  units: readonly SheetUnit[],
  y: number,
): SheetAnchor | null {
  if (units.length === 0) return null;
  const { unit, ratio } = anchorOf(units, y);
  const u = units[unit];
  const a: SheetAnchor = { id: u.id, ratio };
  if (u.section !== undefined) a.section = u.section;
  if (u.bars) a.bar = u.bars.start + ratio * u.bars.count;
  return a;
}

export function sheetAnchorY(
  units: readonly SheetUnit[],
  a: SheetAnchor | null,
): number {
  if (!a || units.length === 0) return 0;
  const at = (u: SheetUnit, r: number) =>
    u.top + Math.min(Math.max(r, 0), 1) * u.height;
  if (a.bar !== undefined) {
    const systems = units.filter((u) => u.section === a.section && u.bars);
    if (systems.length) {
      const bar = a.bar;
      const hit =
        systems.find(
          (u) => bar >= u.bars!.start && bar < u.bars!.start + u.bars!.count,
        ) ?? (bar < systems[0].bars!.start ? systems[0] : systems.at(-1)!);
      const { start, count } = hit.bars!;
      return at(hit, count > 0 ? (bar - start) / count : 0);
    }
  }
  const same = units.find((u) => u.id === a.id);
  if (same) return at(same, a.ratio);
  const first =
    a.section !== undefined
      ? units.find((u) => u.section === a.section)
      : undefined;
  return first ? first.top : 0;
}
