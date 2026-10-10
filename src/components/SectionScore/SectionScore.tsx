import {
  AlphaTabApi,
  FontFileFormat,
  NotationElement,
  ScrollMode,
  Settings,
  type model,
} from '@coderline/alphatab';
import bravuraOtf from '@coderline/alphatab/font/Bravura.otf?url';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import { useEffect, useRef, useState } from 'react';
import type { ShuffleMarkAt } from '../../lib/viewerSections';
import { injectBravuraFontFace } from '../PartScore/bravuraFont';
import { percussionStemsUp } from '../PartScore/percussionStems';
import styles from './SectionScore.module.css';
import { ShuffleMark } from './ShuffleMark';

injectBravuraFontFace();

/** One alphaTab system (row of staves), relative to the SectionScore's top. */
export interface SystemBox {
  top: number;
  height: number;
  /** 0-based bar index within the section. */
  barStart: number;
  barCount: number;
}

export interface SectionScoreProps {
  /** alphaTex of one section (all its tracks, `sectionScoreTex`). */
  tex: string;
  trackCount: number;
  /** Viewer zoom (`ZOOM_STEPS`); alphaTab scale = ALPHATAB_BASE_SCALE × zoom. */
  zoom: number;
  /** Song-wide number of the section's first bar (1-based). */
  firstBar: number;
  /**
   * Draw a Shuffle marking above each listed track's first bar ('none'
   * draws "Straight" — pass it only where a section returns to straight).
   * One entry per drum track (m6-review.md R5).
   */
  shuffleMarks?: readonly ShuffleMarkAt[];
  /**
   * Called after every finished render (alphaTab can finish twice per
   * `tex()`, and again after a zoom/width change) — use the latest call.
   * The boxes tile the component: the first starts at 0 (incl. the top
   * padding), each runs to the next one's top (incl. the gap between
   * systems), the last ends at the component's bottom.
   */
  onLayout?: (systems: SystemBox[]) => void;
  /**
   * Called after a render fails (the error message is shown in place of the
   * score), so a parent that measures can measure again (m6-review.md R14).
   */
  onError?: (message: string) => void;
}

/** alphaTab `display.scale` at zoom 1 (T17 may tune it). */
export const ALPHATAB_BASE_SCALE = 1;

/**
 * alphaTab's page padding [left, top, right, bottom] in px (not scaled by
 * `display.scale`). Smaller than alphaTab's 35px default: sections stack
 * vertically and the viewer has its own gutter on the left.
 */
const PADDING = [12, 6, 12, 0];

/**
 * Invisible text lines put on the marked track's first beat at render time
 * (like `percussionStemsUp`, the tex is untouched) so alphaTab reserves an
 * effect band above that staff — the ShuffleMark is drawn into that room
 * instead of colliding with the notes or the track above. The lines are
 * found again in the rendered SVG by their content.
 */
const BAND_LINE = '\u200b';
const BAND_LINES = 3;

/** alphaTab's fixed credit line (`_layoutAndRenderAnnotation`). */
const CREDIT = 'rendered by alphaTab';

const RESIZE_RENDER_DEBOUNCE_MS = 150;

/** Bar number font size and box height, in staff spaces. */
const NUMBER_FONT_SS = 1.25;
const NUMBER_BOX_SS = NUMBER_FONT_SS * 1.2;

function createSettings(zoom: number): Settings {
  const settings = new Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;
  // Draw everything up front: the viewer hides parts with transforms.
  settings.core.enableLazyLoading = false;
  settings.core.smuflFontSources = new Map([
    [FontFileFormat.Woff2, bravuraWoff2],
    [FontFileFormat.OpenType, bravuraOtf],
  ]);
  settings.player.enablePlayer = false;
  // Even without a player, alphaTab places its beat cursor after every
  // render and the default scroll handler (ScrollMode.Continuous) then
  // smooth-scrolls the page (html/body) to that beat (see PartScore, where
  // this yanked the editor page down on every note input). The viewer does
  // its own positioning, so never let alphaTab scroll.
  settings.player.scrollMode = ScrollMode.Off;
  settings.display.scale = ALPHATAB_BASE_SCALE * zoom;
  settings.display.padding = PADDING;
  settings.display.justifyLastSystem = true;
  // The viewer draws rehearsal marks (gutter), bar numbers and the Shuffle
  // marking itself (m6-plan.md design decisions 3 and 4).
  for (const el of [
    NotationElement.EffectDynamics,
    NotationElement.EffectMarker,
    NotationElement.EffectTripletFeel,
    NotationElement.BarNumber,
    NotationElement.TrackNames,
    NotationElement.EffectTempo,
    NotationElement.ScoreTitle,
    NotationElement.ScoreSubTitle,
    NotationElement.ScoreArtist,
    NotationElement.ScoreAlbum,
    NotationElement.ScoreWords,
    NotationElement.ScoreMusic,
    NotationElement.ScoreWordsAndMusic,
    NotationElement.ScoreCopyright,
  ]) {
    settings.notation.elements.set(el, false);
  }
  return settings;
}

function reserveMarkBand(score: model.Score, track: number): void {
  const beat = score.tracks[track]?.staves[0]?.bars[0]?.voices[0]?.beats[0];
  if (!beat) return;
  const band = Array.from({ length: BAND_LINES }, () => BAND_LINE).join('\n');
  beat.text = beat.text ? `${band}\n${beat.text}` : band;
}

interface Overlay {
  /**
   * Room added above alphaTab's drawing (px) so the first system's bar
   * number fits inside the component (R1). Positions below are in
   * alphaTab's coordinates; the drawing and overlay are shifted down by it.
   */
  shift: number;
  /**
   * Visible height incl. `shift`: the last system's bottom (hides
   * "rendered by alphaTab").
   */
  height: number;
  systems: SystemBox[];
  /** `y` = the number box's top; the box is `NUMBER_BOX_SS` staff spaces. */
  numbers: { n: number; x: number; y: number }[];
  staffSpace: number;
  marks: { track: number; x: number; y: number }[];
}

function measure(
  api: AlphaTabApi,
  host: HTMLElement,
  firstBar: number,
  markTracks: readonly number[],
): Overlay | null {
  const lookup = api.renderer.boundsLookup;
  const sys = lookup?.staffSystems ?? [];
  if (sys.length === 0) return null;
  const hostTop = host.getBoundingClientRect().top;
  // Cut at the "rendered by alphaTab" partial (its own SVG right below the
  // last system; the last system's realBounds reach a little into it).
  const last = sys[sys.length - 1].realBounds;
  const credit = [...host.querySelectorAll<SVGTextElement>('svg text')].find(
    (t) => t.textContent === CREDIT,
  );
  // The glyphs poke slightly above their partial's top edge.
  const creditTop = credit
    ? Math.min(
        credit.getBoundingClientRect().top,
        credit.ownerSVGElement?.getBoundingClientRect().top ?? Infinity,
      ) - hostTop
    : Infinity;
  const bottom = Math.floor(Math.min(last.y + last.h, creditTop));
  const firstStaff = sys[0].bars[0]?.bars[0]?.visualBounds;
  const staffSpace = firstStaff ? firstStaff.h / 4 : 9;
  // Bar numbers sit right above the top staff. With no chord names on the
  // top track there is little room there, so a number can reach above its
  // system's realBounds (R1): each system starts at its number's top when
  // that is higher, and the first number gets room via `shift`.
  const numberBox = NUMBER_BOX_SS * staffSpace;
  const numbers = sys.flatMap((s) => {
    const vb = s.bars[0]?.bars[0]?.visualBounds;
    return vb
      ? [{ n: firstBar + s.bars[0].index, x: vb.x, y: vb.y - numberBox }]
      : [];
  });
  const numberTop = (i: number) => {
    const vb = sys[i].bars[0]?.bars[0]?.visualBounds;
    return vb ? vb.y - numberBox : Infinity;
  };
  const shift = Math.ceil(Math.max(0, -Math.floor(numberTop(0))));
  const tops = sys.map((s, i) =>
    i === 0 ? 0 : Math.floor(Math.min(s.realBounds.y, numberTop(i))) + shift,
  );
  const height = bottom + shift;
  const systems = sys.map((s, i) => {
    const top = tops[i];
    const end = i + 1 < sys.length ? tops[i + 1] : height;
    return {
      top,
      height: end - top,
      barStart: s.bars[0]?.index ?? 0,
      barCount: s.bars.length,
    };
  });
  // Band lines (alphaTab coordinates), to find each marked track's band.
  const bandTops = [...host.querySelectorAll('svg text')]
    .filter((t) => t.textContent === BAND_LINE)
    .map((t) => t.getBoundingClientRect().top - hostTop);
  const marks = markTracks.flatMap((track) => {
    const bar = sys[0].bars[0]?.bars[track]?.visualBounds;
    if (!bar) return [];
    // The track's band lies between the staff above (if any) and its own.
    const above =
      track > 0 ? sys[0].bars[0]?.bars[track - 1]?.visualBounds : undefined;
    const floor = above ? above.y + above.h : -Infinity;
    const mine = bandTops.filter((y) => y > floor && y < bar.y);
    return [
      {
        track,
        // Leave room for the bar number when the marked staff is the top one.
        x: bar.x + (track === 0 ? 3 * staffSpace : 0),
        y: mine.length > 0 ? Math.min(...mine) : bar.y - 4 * staffSpace,
      },
    ];
  });
  return { shift, height, systems, numbers, staffSpace, marks };
}

type RenderState = 'loading' | 'rendered' | 'error';

/**
 * One viewer section rendered by its own alphaTab (m6-plan.md design
 * decision 2): rehearsal marks, Shuffle (triplet feel), bar numbers, track
 * names, tempo and title are switched off in alphaTab; bar numbers
 * (song-wide, from `firstBar`) and the drum staff's Shuffle marking are
 * drawn on top from `boundsLookup`. The height is cut at the last system so
 * alphaTab's "rendered by alphaTab" line is hidden (the viewer credits it
 * once itself).
 */
export function SectionScore({
  tex,
  trackCount,
  zoom,
  firstBar,
  shuffleMarks,
  onLayout,
  onError,
}: SectionScoreProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const [state, setState] = useState<RenderState>('loading');
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  // Latest values for the alphaTab callbacks (registered once).
  const markKey = (shuffleMarks ?? []).map((m) => m.track).join(',');
  const live = useRef({
    firstBar,
    onLayout,
    onError,
    markTracks: markKey ? markKey.split(',').map(Number) : [],
  });
  useEffect(() => {
    live.current.firstBar = firstBar;
    live.current.onLayout = onLayout;
    live.current.onError = onError;
  });
  const zoomRef = useRef(zoom);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let api: AlphaTabApi;
    try {
      api = new AlphaTabApi(host, createSettings(zoomRef.current));
    } catch (e) {
      // No real browser (jsdom): see PartScore.
      const message = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => {
        setError(message);
        setState('error');
        live.current.onError?.(message);
      });
      return;
    }
    apiRef.current = api;
    api.scoreLoaded.on((score) => {
      percussionStemsUp(score);
      for (const t of live.current.markTracks) reserveMarkBand(score, t);
    });
    api.postRenderFinished.on(() => {
      const o = measure(
        api,
        host,
        live.current.firstBar,
        live.current.markTracks,
      );
      if (!o) return;
      setOverlay(o);
      setState('rendered');
      live.current.onLayout?.(o.systems);
    });
    api.error.on((e) => {
      setError(e.message);
      setState('error');
      live.current.onError?.(e.message);
    });
    return () => {
      api.destroy();
      apiRef.current = null;
    };
  }, []);

  // alphaTab skips rendering at width 0 (a hidden panel) and doesn't
  // recover by itself (see PartScore); other width changes it handles.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let lastWidth = el.getBoundingClientRect().width;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const previous = lastWidth;
      lastWidth = width;
      if (previous === 0 && width > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () => apiRef.current?.render(),
          RESIZE_RENDER_DEBOUNCE_MS,
        );
      }
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    live.current.markTracks = markKey ? markKey.split(',').map(Number) : [];
    setState('loading');
    api.tex(
      tex,
      Array.from({ length: trackCount }, (_, i) => i),
    );
  }, [tex, trackCount, markKey]);

  useEffect(() => {
    if (zoomRef.current === zoom) return;
    zoomRef.current = zoom;
    const api = apiRef.current;
    if (!api) return;
    api.settings.display.scale = ALPHATAB_BASE_SCALE * zoom;
    api.updateSettings();
    api.render();
  }, [zoom]);

  return (
    <div
      className={styles.root}
      data-testid="section-score"
      data-state={state}
      style={overlay ? { height: overlay.height } : undefined}
    >
      {state === 'error' && (
        <p role="alert" className={styles.error}>
          譜面を表示できませんでした: {error}
        </p>
      )}
      <div
        className={styles.content}
        style={overlay ? { marginTop: overlay.shift } : undefined}
      >
        <div ref={hostRef} className={styles.host} />
        {overlay && (
          <div className={styles.overlay} aria-hidden="true">
            {overlay.numbers.map((b) => {
              const box = NUMBER_BOX_SS * overlay.staffSpace;
              return (
                <span
                  key={b.n}
                  className={styles.barNumber}
                  data-testid="bar-number"
                  style={{
                    left: b.x,
                    top: b.y,
                    height: box,
                    lineHeight: `${box}px`,
                    fontSize: NUMBER_FONT_SS * overlay.staffSpace,
                  }}
                >
                  {b.n}
                </span>
              );
            })}
            {overlay.marks.map((m) => {
              const mark = shuffleMarks?.find((s) => s.track === m.track);
              return (
                mark && (
                  <div
                    key={m.track}
                    className={styles.mark}
                    style={{ left: m.x, top: m.y }}
                  >
                    <ShuffleMark
                      shuffle={mark.shuffle}
                      staffSpace={overlay.staffSpace}
                    />
                  </div>
                )
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
