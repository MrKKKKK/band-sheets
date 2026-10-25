/**
 * Auto-scroll math for the viewer (M6, docs/m6-plan.md 設計判断 8; issue #62).
 *
 * A timeline maps time → the timed units (an alphaTab system, or a chart-only
 * block): one key at the top of every unit at the time its first bar starts,
 * plus an end key at the bottom of the last unit (`sectionAt` reads it).
 * Time-less units (chart lines between systems) are not in the input.
 * The view moves system by system (`buildScrollPlan`): the playing unit
 * stays still and the next one eases to the top during the last beat.
 */
import { dashBarCount, isDashLine } from './dashChart';
import type { ChartLine, ChartSection } from './song';

/**
 * Same shape as `BarInfo` in `viewerSections.ts` (T12), declared here so this
 * module has no dependency on it; the two are structurally interchangeable.
 */
export interface BarInfo {
  num: number;
  den: number;
}

export interface TimedUnit {
  top: number;
  height: number;
  bars: BarInfo[];
  /**
   * Top of time-less content to keep in view with this unit (the section's
   * chart lines above its first system); only `buildScrollPlan` reads it.
   */
  leadTop?: number;
}

export interface Timeline {
  keys: { t: number; y: number }[];
  duration: number;
}

/** ♩ per minute used when the song has no valid {tempo:}. */
export const DEFAULT_TEMPO = 100;

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Seconds of one bar. `{tempo:}` counts quarter notes, so a bar lasts
 * `num × 4/den` quarters. Invalid tempo → DEFAULT_TEMPO, invalid speed →
 * 100%, malformed bar → 0.
 */
export function barSeconds(
  bar: BarInfo,
  tempo: number,
  speedPct: number,
): number {
  if (!positive(bar.num) || !positive(bar.den)) return 0;
  const bpm = positive(tempo) ? tempo : DEFAULT_TEMPO;
  const speed = positive(speedPct) ? speedPct : 100;
  return (bar.num * (4 / bar.den) * 60) / ((bpm * speed) / 100);
}

/**
 * Units must be in document (top-to-bottom) order. A unit with no bars
 * becomes a zero-length jump (two keys at the same t).
 */
export function buildTimeline(
  units: readonly TimedUnit[],
  tempo: number,
  speedPct: number,
): Timeline {
  if (units.length === 0) return { keys: [], duration: 0 };
  const keys: Timeline['keys'] = [];
  let t = 0;
  for (const u of units) {
    keys.push({ t, y: u.top });
    for (const bar of u.bars) t += barSeconds(bar, tempo, speedPct);
  }
  const last = units[units.length - 1];
  keys.push({ t, y: last.top + last.height });
  return { keys, duration: t };
}

/** Index of the last key with `key.t <= t` (0 when t is before the start). */
function keyIndexAt(keys: Timeline['keys'], t: number): number {
  let i = 0;
  for (let k = 1; k < keys.length; k++) {
    if (keys[k].t <= t) i = k;
    else break;
  }
  return i;
}

/** The viewport as the system-by-system auto-scroll sees it (issue #62). */
export interface ScrollView {
  /** Viewport height (px). */
  height: number;
  /** Bottom strip covered by the auto-scroll bar (px). */
  bottomReserve: number;
  /** Gap kept above a system resting at the top (px). */
  topGap: number;
  /** scrollHeight − clientHeight. */
  maxScrollTop: number;
}

interface ScrollStep {
  /** Song time (s) the unit starts / ends. */
  start: number;
  end: number;
  /** scrollTop while the unit plays. */
  rest: number;
  /** Tall unit: scrollTop reached (continuously) when the ease begins. */
  tallEnd: number | null;
  /** Length (s) of the move to the next unit, ending at `end`. */
  ease: number;
}

export interface ScrollPlan {
  steps: ScrollStep[];
  duration: number;
}

/** The move to the next system takes one beat, within these bounds (s). */
export const EASE_MIN_SEC = 0.3;
export const EASE_MAX_SEC = 0.5;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/**
 * System-by-system auto-scroll (issue #62): while a unit plays it stays
 * still; during its last beat (0.3–0.5s, at most half the unit) the view
 * eases so the next unit rests `topGap` below the top. The first unit rests
 * at scrollTop 0 when it fits there. A unit taller than the visible height
 * (viewport minus the bar) scrolls continuously until its bottom is above the
 * bar, then eases on. Units without bars are skipped. The time axis is the
 * same as `buildTimeline`'s.
 */
export function buildScrollPlan(
  units: readonly TimedUnit[],
  tempo: number,
  speedPct: number,
  view: ScrollView,
): ScrollPlan {
  const visible = view.height - view.bottomReserve;
  const max = Math.max(0, view.maxScrollTop);
  const steps: ScrollStep[] = [];
  let t = 0;
  for (const u of units) {
    const start = t;
    for (const bar of u.bars) t += barSeconds(bar, tempo, speedPct);
    if (!(t > start)) continue;
    const bottom = u.top + u.height;
    let rest: number;
    if (steps.length === 0 && bottom <= visible) rest = 0;
    else {
      const lead = u.leadTop ?? u.top;
      const fits = bottom - lead + view.topGap <= visible;
      rest = (fits ? Math.min(lead, u.top) : u.top) - view.topGap;
    }
    rest = clamp(rest, 0, max);
    const tall = u.height + view.topGap > visible;
    const last = u.bars[u.bars.length - 1];
    const beat = barSeconds(last, tempo, speedPct) / last.num;
    steps.push({
      start,
      end: t,
      rest,
      tallEnd: tall ? clamp(Math.max(rest, bottom - visible), 0, max) : null,
      ease: Math.min(clamp(beat, EASE_MIN_SEC, EASE_MAX_SEC), (t - start) / 2),
    });
  }
  return { steps, duration: t };
}

/** Index of the step playing at t (clamped); -1 for an empty plan. */
export function planStepAt(plan: ScrollPlan, t: number): number {
  const { steps } = plan;
  if (steps.length === 0) return -1;
  let i = 0;
  while (i < steps.length - 1 && t >= steps[i].end) i++;
  return i;
}

const smoothstep = (p: number) => p * p * (3 - 2 * p);

/** scrollTop at time t (see `buildScrollPlan`). */
export function planScrollTopAt(plan: ScrollPlan, t: number): number {
  const i = planStepAt(plan, t);
  if (i < 0) return 0;
  const s = plan.steps[i];
  const next = plan.steps[i + 1];
  const easeFrom = next ? s.end - s.ease : s.end;
  let pos = s.rest;
  if (s.tallEnd !== null && t > s.start) {
    const p = Math.min(1, (t - s.start) / (easeFrom - s.start));
    pos = s.rest + p * (s.tallEnd - s.rest);
  }
  if (next && t > easeFrom) {
    const p = Math.min(1, (t - easeFrom) / s.ease);
    pos += smoothstep(p) * (next.rest - pos);
  }
  return pos;
}

/**
 * Where playback resumes from a scrolled view: the start of the step whose
 * rest position is nearest to scrollTop (ties → the earlier one).
 */
export function planTimeAtScrollTop(
  plan: ScrollPlan,
  scrollTop: number,
): number {
  let best: ScrollStep | null = null;
  for (const s of plan.steps) {
    if (!best || Math.abs(s.rest - scrollTop) < Math.abs(best.rest - scrollTop))
      best = s;
  }
  return best ? best.start : 0;
}

/**
 * One frame of an exponential approach from `current` to `target` (time
 * constant `tauSec`); within half a pixel it snaps to the target.
 */
export function approach(
  current: number,
  target: number,
  dtSec: number,
  tauSec: number,
): number {
  const next = current + (target - current) * (1 - Math.exp(-dtSec / tauSec));
  return Math.abs(target - next) < 0.5 ? target : next;
}

/**
 * Converts a playing time when the speed changes from `fromPct` to `toPct`,
 * so the position (y) stays the same: every duration scales by from/to.
 */
export function rescaleTime(t: number, fromPct: number, toPct: number): number {
  if (!positive(fromPct) || !positive(toPct) || fromPct === toPct) return t;
  return (t * fromPct) / toPct;
}

/**
 * Index (into the units given to `buildTimeline`) of the unit playing at t.
 * Zero-length units are skipped; clamps to the first / last unit; -1 when
 * the timeline is empty.
 */
export function sectionAt(tl: Timeline, t: number): number {
  const unitCount = tl.keys.length - 1;
  if (unitCount <= 0) return -1;
  return Math.min(keyIndexAt(tl.keys, t), unitCount - 1);
}

/**
 * The bar playing at time t (for the count-in's time signature). Before the
 * start → the first bar; at/after the end → the last; no bars → null.
 */
export function barAt(
  units: readonly TimedUnit[],
  tempo: number,
  speedPct: number,
  t: number,
): BarInfo | null {
  let end = 0;
  let last: BarInfo | null = null;
  for (const u of units) {
    for (const bar of u.bars) {
      end += barSeconds(bar, tempo, speedPct);
      if (t < end) return bar;
      last = bar;
    }
  }
  return last;
}

/** Count-in = one bar, counted in the bar's own beats (6/8 → 6). */
export function countInBeats(bar: BarInfo): number {
  return bar.num;
}

/**
 * Estimated bars of one chart line for sections no part has bars for
 * (m6-plan.md 確認したい点 3 → (a)): one bar per chord, a lyric line without
 * chords = 1 bar, blank / raw lines = 0. Dash lines count their bars.
 */
export function lineBarCount(line: ChartLine): number {
  if ('raw' in line || line.segments.length === 0) return 0;
  // Dash lines (audio-integration-plan §3.6): the `|`-delimited bars.
  if (isDashLine(line)) return dashBarCount(line);
  const chords = line.segments.filter((s) => s.chord !== undefined).length;
  return Math.max(1, chords);
}

/** `lineBarCount` summed over a chart section, each bar in `bar`'s meter. */
export function estimateChartBars(
  section: ChartSection | undefined,
  bar: BarInfo,
): BarInfo[] {
  if (!section) return [];
  const n = section.lines.reduce((sum, l) => sum + lineBarCount(l), 0);
  return Array.from({ length: n }, () => bar);
}
