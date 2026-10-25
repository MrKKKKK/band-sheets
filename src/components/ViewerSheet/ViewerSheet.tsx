import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BarInfo } from '../../lib/autoScroll';
import type { Song } from '../../lib/song';
import { buildViewerSections } from '../../lib/viewerSections';
import { transposeChartSection, transposeKey } from '../../lib/transpose';
import { BASE_FONT_PX } from '../../lib/viewerSettings';
import { SectionScore, type SystemBox } from '../SectionScore/SectionScore';
import { SectionGutter } from '../ViewerChartBlock/SectionGutter';
import { ViewerChartBlock } from '../ViewerChartBlock/ViewerChartBlock';
import {
  droppedLyricsParts,
  planSheet,
  type SheetBlock,
  type SheetLayout,
  type SheetOptions,
  type SheetTimedUnit,
  type SheetUnit,
} from './sheetModel';
import styles from './ViewerSheet.module.css';

export interface ViewerSheetProps extends SheetOptions {
  song: Song;
  /** `ZOOM_STEPS`: the chart font is `BASE_FONT_PX × zoom`, alphaTab scales too. */
  zoom: number;
  /** Display-only transposition (semitones, −6..+6; default 0). */
  transpose?: number;
  /** Section key (`SheetTimedUnit.section`) to highlight as now playing. */
  playingSection?: string | null;
  /**
   * The measured layout, re-sent whenever it changes (renders finishing,
   * zoom, width, settings). Positions are px from the sheet's top edge.
   */
  onLayout?: (layout: SheetLayout) => void;
}

interface Reported {
  /** `${tex}|${zoom}` the systems were reported for. */
  sig: string;
  systems: SystemBox[];
}

/** Region names for the sheet's own rows: "A", "A（2回目）", … */
function uniqueLabels(blocks: readonly SheetBlock[]): Map<string, string> {
  const total = new Map<string, number>();
  for (const b of blocks) total.set(b.label, (total.get(b.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (!b.label) continue;
    const n = (seen.get(b.label) ?? 0) + 1;
    seen.set(b.label, n);
    out.set(
      b.key,
      total.get(b.label)! > 1 ? `${b.label}（${n}回目）` : b.label,
    );
  }
  return out;
}

const sigOf = (tex: string, zoom: number, transpose: number) =>
  `${zoom}|${transpose}|${tex}`;

function rect(el: Element, origin: DOMRect) {
  const r = el.getBoundingClientRect();
  return { top: r.top - origin.top, height: r.height };
}

function measure(
  root: HTMLElement,
  blocks: readonly SheetBlock[],
  reported: ReadonlyMap<string, Reported>,
  zoom: number,
  transpose: number,
): SheetLayout {
  const origin = root.getBoundingClientRect();
  const units: SheetUnit[] = [];
  const timedUnits: SheetTimedUnit[] = [];
  let ready = true;

  root
    .querySelectorAll(':scope > [data-sheet-notice]')
    .forEach((el, i) => units.push({ id: `notice:${i}`, ...rect(el, origin) }));

  for (const b of blocks) {
    const el = root.querySelector(`[data-block="${CSS.escape(b.key)}"]`);
    if (!el) continue;
    const lines = el.querySelectorAll('[data-chart] [data-unit]');
    lines.forEach((line, i) => {
      const u: SheetUnit = {
        id: `line:${b.key}:${i}`,
        section: b.key,
        ...rect(line, origin),
      };
      // The last chart line stays on the page of the first system below it.
      if (b.score && i === lines.length - 1) u.keepWithNext = true;
      units.push(u);
    });
    if (b.chartBars && lines.length > 0) {
      const first = rect(lines[0], origin);
      const last = rect(lines[lines.length - 1], origin);
      timedUnits.push({
        section: b.key,
        top: first.top,
        height: last.top + last.height - first.top,
        bars: b.chartBars,
      });
    }
    // The chart lines above a score have no time of their own: auto-scroll
    // keeps them in view with the section's first system (issue #62).
    const leadTop =
      !b.chartBars && lines.length > 0 ? rect(lines[0], origin).top : undefined;
    const lead = leadTop === undefined ? {} : { leadTop };
    if (b.score) {
      const slot = el.querySelector('[data-score-slot]');
      const rep = reported.get(b.key);
      const failed = slot?.querySelector('[data-state="error"]');
      if (
        !failed &&
        (!rep || rep.sig !== sigOf(b.score.tex, zoom, transpose))
      ) {
        ready = false;
      }
      if (slot && failed) {
        // The error message is a unit of its own, so a page always shows it
        // whole (R7); it carries the section's time for auto-scroll.
        const r = rect(slot, origin);
        units.push({ id: `score-error:${b.key}`, section: b.key, ...r });
        timedUnits.push({
          section: b.key,
          ...r,
          bars: [...b.score.bars, ...b.score.extraBars],
          ...lead,
        });
      } else if (slot && rep) {
        const top = rect(slot, origin).top;
        rep.systems.forEach((s, i) => {
          let bars: BarInfo[] = b.score!.bars.slice(
            s.barStart,
            s.barStart + s.barCount,
          );
          if (i === rep.systems.length - 1) {
            bars = [...b.score!.bars.slice(s.barStart), ...b.score!.extraBars];
          }
          units.push({
            id: `score:${b.key}:${s.barStart}`,
            section: b.key,
            top: top + s.top,
            height: s.height,
            bars: { start: s.barStart, count: s.barCount },
          });
          timedUnits.push({
            section: b.key,
            top: top + s.top,
            height: s.height,
            bars,
            ...(i === 0 ? lead : {}),
          });
        });
      }
    }
    if (b.restBars) {
      const rest = el.querySelector('[data-rest]');
      if (rest) {
        // The whole row: its gutter mark is taller than the one-line text.
        const r = rect(rest.parentElement ?? rest, origin);
        units.push({ id: `rest:${b.key}`, section: b.key, ...r });
        timedUnits.push({
          section: b.key,
          ...r,
          bars: b.restBars,
          ...(b.score ? {} : lead),
        });
      }
    }
  }

  root.querySelectorAll(':scope > [data-sheet-tail]').forEach((el) =>
    units.push({
      id: (el as HTMLElement).dataset.sheetTail ?? 'tail',
      ...rect(el, origin),
    }),
  );
  return { ready, units, timedUnits };
}

/**
 * The viewer's whole sheet as one long column (M6 T14): for every section
 * block, the chord chart (`ViewerChartBlock`) and/or one `SectionScore`
 * with the shown parts, rehearsal marks in the left gutter, plus the
 * unreadable-part / dropped-lyrics notices on top and a single "rendered by
 * alphaTab" credit at the end. It does not scroll or paginate itself; it
 * measures its units (chart lines from the DOM, systems from each
 * SectionScore's `onLayout`) and reports them through `onLayout` for the
 * Viewer's pagination and auto-scroll.
 */
export function ViewerSheet({
  song,
  layout,
  part,
  scoreHidden,
  scoreChart,
  zoom,
  transpose = 0,
  playingSection,
  onLayout,
}: ViewerSheetProps) {
  const { sections, errors } = useMemo(() => buildViewerSections(song), [song]);
  const opts = useMemo<SheetOptions>(
    () => ({ layout, part, scoreHidden, scoreChart }),
    [layout, part, scoreHidden, scoreChart],
  );
  const blocks = useMemo(() => {
    const planned = planSheet(song, sections, opts);
    if (transpose === 0) return planned;
    const target = transposeKey(song.meta.key, transpose) ?? undefined;
    return planned.map((b) =>
      b.chart
        ? { ...b, chart: transposeChartSection(b.chart, transpose, target) }
        : b,
    );
  }, [song, sections, opts, transpose]);
  const lyricsParts = useMemo(
    () => droppedLyricsParts(song, opts),
    [song, opts],
  );
  const hasScore = blocks.some((b) => b.score);
  const regionLabels = useMemo(() => uniqueLabels(blocks), [blocks]);

  const rootRef = useRef<HTMLDivElement>(null);
  const reported = useRef(new Map<string, Reported>());
  const [tick, setTick] = useState(0);
  const onLayoutRef = useRef(onLayout);
  useEffect(() => {
    onLayoutRef.current = onLayout;
  });
  const lastSent = useRef('');

  const remeasure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const result = measure(root, blocks, reported.current, zoom, transpose);
    const json = JSON.stringify(result);
    if (json === lastSent.current) return;
    lastSent.current = json;
    onLayoutRef.current?.(result);
  }, [blocks, zoom, transpose]);

  // After every commit that may move things: a score reporting (its new
  // height is committed in the same batch), settings, zoom.
  useLayoutEffect(() => {
    remeasure();
  }, [remeasure, tick]);

  // Anything else that changes heights (fonts, width) shows up here.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(root);
    return () => ro.disconnect();
  }, [remeasure]);

  const fontSize = `${BASE_FONT_PX * zoom}px`;

  return (
    <div
      ref={rootRef}
      className={styles.sheet}
      style={{ '--viewer-font-size': fontSize } as React.CSSProperties}
      data-testid="viewer-sheet"
    >
      {errors.length > 0 && (
        <ul
          className={styles.notice}
          data-sheet-notice=""
          data-testid="sheet-errors"
        >
          {errors.map((e) => (
            <li key={e.part}>{e.message}</li>
          ))}
        </ul>
      )}
      {lyricsParts.length > 0 && (
        <p
          className={styles.note}
          data-sheet-notice=""
          data-testid="sheet-lyrics-note"
        >
          {lyricsParts.join('・')}{' '}
          のパート全体の歌詞（\lyrics）は閲覧画面には出ません。メロディ画面で音符ごとの歌詞に変換すると表示されます。
        </p>
      )}
      {blocks.map((b) => {
        const playing = playingSection === b.key;
        return (
          <div
            key={b.key}
            className={styles.block}
            data-block={b.key}
            data-playing={playing || undefined}
          >
            {b.chart && (
              <div data-chart="">
                <ViewerChartBlock
                  section={b.chart}
                  sectionKey={b.key}
                  playing={playing}
                  fontSize={fontSize}
                  ariaLabel={regionLabels.get(b.key)}
                />
              </div>
            )}
            {b.score && (
              <section
                className={styles.row}
                aria-label={b.chart ? undefined : regionLabels.get(b.key)}
                aria-current={(!b.chart && playing) || undefined}
              >
                <SectionGutter
                  label={b.chart ? '' : b.label}
                  playing={playing}
                />
                <div className={styles.scoreSlot} data-score-slot="">
                  <ScoreSlot
                    block={b}
                    zoom={zoom}
                    transpose={transpose}
                    reported={reported}
                    onTick={setTick}
                  />
                </div>
              </section>
            )}
            {b.restBars && (
              <section
                className={styles.row}
                aria-label={regionLabels.get(b.key)}
                aria-current={playing || undefined}
              >
                <SectionGutter label={b.label} playing={playing} />
                <p className={styles.rest} data-rest="">
                  {b.restBars.length}{' '}
                  小節（表示中のパートはこのセクションにありません）
                </p>
              </section>
            )}
          </div>
        );
      })}
      {blocks.length === 0 && (
        <p className={styles.empty} data-sheet-tail="empty">
          表示する内容がありません。コード譜かパートを表示してください。
        </p>
      )}
      {hasScore && (
        <p className={styles.credit} data-sheet-tail="credit">
          rendered by alphaTab
        </p>
      )}
    </div>
  );
}

function ScoreSlot({
  block,
  zoom,
  transpose,
  reported,
  onTick,
}: {
  block: SheetBlock;
  zoom: number;
  transpose: number;
  reported: React.RefObject<Map<string, Reported>>;
  onTick: React.Dispatch<React.SetStateAction<number>>;
}) {
  const score = block.score!;
  const sig = sigOf(score.tex, zoom, transpose);
  const { key } = block;
  // A remounted score must report again before the sheet is ready.
  useEffect(() => {
    const map = reported.current;
    return () => {
      map.delete(key);
    };
  }, [key, reported]);
  return (
    <SectionScore
      tex={score.tex}
      trackCount={score.trackCount}
      zoom={zoom}
      transpose={transpose}
      firstBar={block.firstBar}
      shuffleMarks={score.shuffleMarks}
      onLayout={(systems) => {
        reported.current.set(key, { sig, systems });
        onTick((t) => t + 1);
      }}
      // A failed render is a layout change too (R14): measure again.
      onError={() => onTick((t) => t + 1)}
    />
  );
}
