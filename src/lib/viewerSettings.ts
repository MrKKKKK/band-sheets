/**
 * Viewer settings (docs/m6-plan.md, decision 10): the per-song display
 * options of the tablet viewer. Pure; persistence lives in `storage.ts`.
 * `normalizeViewerSettings` validates item by item, so one bad value only
 * resets that item.
 */
import { isDrumPart, type Song } from './song';
import { clampTranspose } from './transpose';

export type ViewerLayout = 'part' | 'score';
export type NavMode = 'page' | 'scroll' | 'auto';

export interface ViewerSettings {
  layout: ViewerLayout;
  /** 「自分のパート」。null = コード譜だけ */
  part: string | null;
  /** スコアで隠しているパート名 */
  scoreHidden: string[];
  /** スコアでコード譜を出すか */
  scoreChart: boolean;
  nav: NavMode;
  zoom: number; // ZOOM_STEPS のどれか
  speedPct: number; // 50..150, 5 刻み
  countIn: boolean;
  /** 表示だけの移調（半音、−6..+6）。曲のテキストは変えない */
  transpose: number;
}

export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];
export const BASE_FONT_PX = 22;

const SPEED_MIN = 50;
const SPEED_MAX = 150;
const SPEED_STEP = 5;
const DEFAULT_SPEED = 100;
const DEFAULT_ZOOM = 1;

/** Round to the 5% grid and clamp to 50..150; non-finite → 100. */
export function clampSpeed(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_SPEED;
  const stepped = Math.round(pct / SPEED_STEP) * SPEED_STEP;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, stepped));
}

/** Next / previous zoom step; stays put at either end (or if off-grid → nearest first). */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const last = ZOOM_STEPS.length - 1;
  let nearest = 0;
  for (let i = 1; i <= last; i++) {
    if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[nearest] - zoom)) {
      nearest = i;
    }
  }
  const next = Math.min(last, Math.max(0, nearest + dir));
  return ZOOM_STEPS[next];
}

/** First non-drum part, else the first part, else null (chart only). */
function defaultPart(song: Song): string | null {
  const melodic = song.parts.find((p) => !isDrumPart(p));
  return (melodic ?? song.parts[0])?.name ?? null;
}

export function defaultViewerSettings(song: Song): ViewerSettings {
  return {
    layout: 'part',
    part: defaultPart(song),
    scoreHidden: [],
    scoreChart: true,
    nav: 'page',
    zoom: DEFAULT_ZOOM,
    speedPct: DEFAULT_SPEED,
    countIn: true,
    transpose: 0,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates stored JSON per item; anything invalid falls back to the default. */
export function normalizeViewerSettings(
  raw: unknown,
  song: Song,
): ViewerSettings {
  const d = defaultViewerSettings(song);
  if (!isRecord(raw)) return d;
  const names = new Set(song.parts.map((p) => p.name));

  const layout =
    raw.layout === 'part' || raw.layout === 'score' ? raw.layout : d.layout;

  // null = chart only (valid). A name that no longer exists → the default part.
  let part = d.part;
  if (raw.part === null) part = null;
  else if (typeof raw.part === 'string' && names.has(raw.part)) {
    part = raw.part;
  }

  // Only names that still exist are kept; parts added later show up.
  const scoreHidden = Array.isArray(raw.scoreHidden)
    ? [
        ...new Set(
          raw.scoreHidden.filter(
            (n): n is string => typeof n === 'string' && names.has(n),
          ),
        ),
      ]
    : d.scoreHidden;

  const nav =
    raw.nav === 'page' || raw.nav === 'scroll' || raw.nav === 'auto'
      ? raw.nav
      : d.nav;

  const zoom =
    typeof raw.zoom === 'number' && ZOOM_STEPS.includes(raw.zoom)
      ? raw.zoom
      : d.zoom;

  const speedPct =
    typeof raw.speedPct === 'number' && Number.isFinite(raw.speedPct)
      ? clampSpeed(raw.speedPct)
      : d.speedPct;

  return {
    layout,
    part,
    scoreHidden,
    scoreChart:
      typeof raw.scoreChart === 'boolean' ? raw.scoreChart : d.scoreChart,
    nav,
    zoom,
    speedPct,
    countIn: typeof raw.countIn === 'boolean' ? raw.countIn : d.countIn,
    transpose:
      typeof raw.transpose === 'number' && Number.isFinite(raw.transpose)
        ? clampTranspose(raw.transpose)
        : d.transpose,
  };
}
