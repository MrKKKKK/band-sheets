import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  barAt,
  barSeconds,
  buildTimeline,
  countInBeats,
  DEFAULT_TEMPO,
  rescaleTime,
  scrollTopAt,
  sectionAt,
  timeAtScrollTop,
} from '../../lib/autoScroll';
import { pageIndexAt, paginate, type Page } from '../../lib/pagination';
import type { Song } from '../../lib/song';
import {
  loadViewerSettings,
  saveViewerSettings,
  type KeyValueStorage,
} from '../../lib/storage';
import { viewerKeyToAction, type ViewerAction } from '../../lib/viewerKeys';
import {
  BASE_FONT_PX,
  clampSpeed,
  normalizeViewerSettings,
  ZOOM_STEPS,
  zoomStep,
  type ViewerSettings,
} from '../../lib/viewerSettings';
import { AutoScrollBar } from '../AutoScrollBar/AutoScrollBar';
import { CountIn } from '../CountIn/CountIn';
import { PageNav } from '../PageNav/PageNav';
import { PlayModeChrome } from '../PlayModeChrome/PlayModeChrome';
import { SettingsDrawer } from '../SettingsDrawer/SettingsDrawer';
import {
  sheetAnchorAt,
  sheetAnchorY,
  type SheetAnchor,
  type SheetLayout,
} from '../ViewerSheet/sheetModel';
import { clampTranspose, formatTranspose, keyLabel } from '../../lib/transpose';
import { ViewerSheet } from '../ViewerSheet/ViewerSheet';
import { ViewerToolbar } from '../ViewerToolbar/ViewerToolbar';
import { browserClock, type ViewerClock } from './viewerClock';
import styles from './Viewer.module.css';

export interface ViewerProps {
  song: Song;
  /** Settings are remembered per song (`band-sheets:viewer:<songId>`). */
  songId: string;
  storage: KeyValueStorage | null;
  /** 「編集に戻る」. */
  onExit: () => void;
  /** Label of the back button (default 「← 編集に戻る」). */
  backLabel?: string;
  /** Time source of auto-scroll (tests pass a manual clock). */
  clock?: ViewerClock;
}

type PlayState = 'idle' | 'countIn' | 'playing' | 'paused' | 'ended';

/** The sheet only re-renders when its own props change (not per scroll). */
const Sheet = memo(ViewerSheet);

const EMPTY_LAYOUT: SheetLayout = { ready: false, units: [], timedUnits: [] };
/** Space above a page's first unit (play mode: no tap hints up there). */
const TOP_GAP = 16;
/** Normal page mode: clears PageNav's 「タップで前／次のページ」 hints. */
const TOP_GAP_HINTS = 44;
/** PageNav's bottom row (‹ n / N ›) covers this much of the content. */
const PAGE_BAR_H = 44;
/** Scroll / pedal step in the scroll modes (a little overlap to keep reading). */
const SCROLL_STEP = 0.85;
/** Auto-scroll keeps the playing position on this line of the viewport. */
const PLAY_LINE = 0.3;
/** A scrollTop this far from the one auto-scroll wrote = the user scrolled. */
const USER_SCROLL_PX = 2;
const FALLBACK_BAR = { num: 4, den: 4 };

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement
  );
}

/** Space / Enter on a focused control activate it; the viewer stays out. */
function activatesTarget(e: KeyboardEvent): boolean {
  const space = e.key === ' ' || e.code === 'Space';
  if (!space && e.key !== 'Enter') return false;
  return (
    e.target instanceof Element &&
    e.target.closest(
      'button, a[href], summary, [role="button"], [role="switch"]',
    ) !== null
  );
}

/**
 * The tablet viewer (M6 T15): the toolbar (plan A), the sheet, and the three
 * ways through it — page turns (one long column shown with `translateY`, a
 * cover below the page's last unit), plain scrolling, and auto-scroll
 * (timeline + rAF loop + 1-bar count-in). Settings are per song and saved
 * on every change. Play mode hides the chrome and tries Fullscreen and a
 * screen Wake Lock (both fail silently). Read-only: it never touches the
 * song text. The viewer owns ONE polite live region (page / playback /
 * play-mode messages); CountIn is aria-hidden.
 */
export function Viewer({
  song,
  songId,
  storage,
  onExit,
  backLabel,
  clock = browserClock,
}: ViewerProps) {
  // ---- settings ---------------------------------------------------------
  const [raw, setRaw] = useState<unknown>(() =>
    loadViewerSettings(storage, songId),
  );
  const settings = useMemo(
    () => normalizeViewerSettings(raw, song),
    [raw, song],
  );
  const partNames = useMemo(() => song.parts.map((p) => p.name), [song]);
  const title = song.meta.title || '無題の曲';
  const hasTempo = song.meta.tempo !== undefined && song.meta.tempo > 0;
  const tempo = hasTempo ? song.meta.tempo! : DEFAULT_TEMPO;

  // ---- live region --------------------------------------------------------
  const [liveMsg, setLiveMsg] = useState('');
  const say = (msg: string) =>
    setLiveMsg((prev) => (prev === msg ? `${msg}\u00A0` : msg));

  // ---- layout / pages -----------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<SheetLayout>(EMPTY_LAYOUT);
  const { units, timedUnits } = layout;
  const [vh, setVh] = useState(0);
  const [playMode, setPlayMode] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nav = settings.nav;
  const topGap = playMode ? TOP_GAP : TOP_GAP_HINTS;
  const pageH = Math.max(1, vh - (playMode ? 0 : PAGE_BAR_H) - topGap);
  const pages = useMemo<Page[]>(
    () => (vh > 0 ? paginate(units, pageH) : [{ top: 0, bottom: Infinity }]),
    [units, pageH, vh],
  );

  /**
   * Reading position in sheet terms (survives zoom / layout / resize).
   * Page mode: state (the page is derived from it). Scroll modes: a ref
   * kept up to date by scroll events and restored after every re-layout.
   */
  const [pageAnchor, setPageAnchor] = useState<SheetAnchor | null>(null);
  const anchorRef = useRef<SheetAnchor | null>(null);
  const restoredRef = useRef(Number.NaN);
  const [scrollPage, setScrollPage] = useState(0);

  const pageIdx = pageAnchor
    ? Math.min(
        pageIndexAt(pages, sheetAnchorY(units, pageAnchor)),
        pages.length - 1,
      )
    : 0;
  const page = pages[pageIdx];
  // Re-announce the page count once when a finished re-layout changes it
  // (layout switch / zoom / resize); adjusted during render so no effect.
  const [announcedTotal, setAnnouncedTotal] = useState(0);
  if (layout.ready && vh > 0 && pages.length !== announcedTotal) {
    setAnnouncedTotal(pages.length);
    // Page mode only: the scroll modes have no pages on screen, and a message
    // would interrupt auto-play.
    if (announcedTotal !== 0 && nav === 'page')
      say(`${pageIdx + 1} / ${pages.length} ページ`);
  }
  // Page 0 starts at the sheet's top (its padding); place its first unit
  // like every other page's.
  const pageStart = pageIdx === 0 ? (units[0]?.top ?? 0) : page.top;
  const pageOffset = pageStart - topGap;
  const coverTop = Number.isFinite(page.bottom)
    ? page.bottom - pageOffset
    : null;

  // ---- auto-scroll --------------------------------------------------------
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [beat, setBeat] = useState<number | null>(null);
  const [playingSection, setPlayingSection] = useState<string | null>(null);
  const timeline = useMemo(
    () => buildTimeline(timedUnits, tempo, settings.speedPct),
    [timedUnits, tempo, settings.speedPct],
  );
  /** What the rAF loop reads (always the committed values). */
  const live = useRef({
    timeline,
    timedUnits,
    tempo,
    speedPct: settings.speedPct,
    ready: layout.ready,
  });
  useLayoutEffect(() => {
    live.current = {
      ready: layout.ready,
      timeline,
      timedUnits,
      tempo,
      speedPct: settings.speedPct,
    };
  });
  const playRef = useRef({
    state: 'idle' as PlayState,
    /** Song time (s) at the current speed. */
    t: 0,
    last: 0,
    frame: null as number | null,
    /** The scrollTop auto-scroll last wrote. */
    written: Number.NaN,
    countElapsed: 0,
    beats: 0,
    beatSec: 0,
  });

  const playLine = () => (viewportRef.current?.clientHeight ?? 0) * PLAY_LINE;

  const showSection = (t: number) => {
    const { timeline: tl, timedUnits: tu } = live.current;
    const i = sectionAt(tl, t);
    setPlayingSection(i >= 0 ? (tu[i]?.section ?? null) : null);
  };

  const cancelFrame = () => {
    const p = playRef.current;
    if (p.frame !== null) {
      clock.cancelFrame(p.frame);
      p.frame = null;
    }
  };

  const tickRef = useRef<() => void>(() => {});
  const tick = () => {
    const p = playRef.current;
    p.frame = null;
    const now = clock.now();
    const dt = Math.max(0, (now - p.last) / 1000);
    p.last = now;
    const el = viewportRef.current;
    const tl = live.current.timeline;
    if (p.state === 'countIn') {
      p.countElapsed += dt;
      const b = Math.floor(p.countElapsed / p.beatSec) + 1;
      if (!(p.beatSec > 0) || b > p.beats) {
        p.state = 'playing';
        setPlayState('playing');
        setBeat(null);
      } else {
        setBeat(b);
      }
    } else if (p.state === 'playing') {
      // A finger scroll during playback: carry on from there (no pause).
      if (el && Math.abs(el.scrollTop - p.written) > USER_SCROLL_PX) {
        p.t = timeAtScrollTop(tl, el.scrollTop, playLine());
      } else {
        p.t += dt;
      }
      if (p.t >= tl.duration) {
        p.t = tl.duration;
        p.state = 'ended';
        setPlayState('ended');
        say('最後まで来ました');
      }
      if (el) {
        el.scrollTop = scrollTopAt(tl, p.t, playLine());
        p.written = el.scrollTop;
      }
      showSection(p.t);
    }
    if (p.state === 'countIn' || p.state === 'playing') {
      p.frame = clock.requestFrame(() => tickRef.current());
    }
  };
  useLayoutEffect(() => {
    tickRef.current = tick;
  });

  const play = (fromStart: boolean) => {
    const p = playRef.current;
    const el = viewportRef.current;
    const { timeline: tl, timedUnits: tu, speedPct, ready } = live.current;
    // Before the sheet is laid out the timeline is empty: it would end at once.
    if (!ready) {
      say('譜面を準備中です');
      return;
    }
    const unmoved =
      p.state === 'paused' &&
      el !== null &&
      Math.abs(el.scrollTop - p.written) <= USER_SCROLL_PX;
    if (!fromStart && !unmoved) {
      p.t = el ? timeAtScrollTop(tl, el.scrollTop, playLine()) : 0;
    }
    if (fromStart || p.t >= tl.duration) {
      p.t = 0;
      if (el) el.scrollTop = 0;
    }
    p.written = el?.scrollTop ?? 0;
    p.last = clock.now();
    if (settings.countIn) {
      const bar = barAt(tu, tempo, speedPct, p.t) ?? FALLBACK_BAR;
      p.beats = countInBeats(bar);
      p.beatSec = barSeconds(bar, tempo, speedPct) / p.beats;
      p.countElapsed = 0;
      p.state = 'countIn';
      setBeat(1);
      setPlayState('countIn');
      say(`カウントイン ${p.beats} 拍`);
    } else {
      p.state = 'playing';
      setPlayState('playing');
      say('自動スクロールを開始');
    }
    showSection(p.t);
    cancelFrame();
    p.frame = clock.requestFrame(() => tickRef.current());
  };

  const pause = () => {
    cancelFrame();
    playRef.current.state = 'paused';
    setPlayState('paused');
    setBeat(null);
    say('一時停止');
  };

  const stopPlayback = () => {
    cancelFrame();
    const p = playRef.current;
    p.state = 'idle';
    p.t = 0;
    p.written = Number.NaN;
    setPlayState('idle');
    setBeat(null);
    setPlayingSection(null);
  };

  const togglePlay = () => {
    const s = playRef.current.state;
    if (s === 'ended') play(true);
    else if (s === 'playing' || s === 'countIn') pause();
    else play(false);
  };

  useEffect(
    () => () => {
      const p = playRef.current;
      if (p.frame !== null) clock.cancelFrame(p.frame);
    },
    [clock],
  );

  // ---- settings changes (one place: toolbar, drawer, play-mode bar) -------
  /** Reading position of the current navigation mode. */
  const currentAnchor = () => (nav === 'page' ? pageAnchor : anchorRef.current);

  const update = (patch: Partial<ViewerSettings>) => {
    const next: ViewerSettings = {
      ...settings,
      ...patch,
      speedPct: clampSpeed(patch.speedPct ?? settings.speedPct),
    };
    if (next.nav !== settings.nav) {
      const a = currentAnchor();
      anchorRef.current = a;
      setPageAnchor(a);
      if (settings.nav === 'auto') stopPlayback();
    }
    if (next.speedPct !== settings.speedPct) {
      const p = playRef.current;
      p.t = rescaleTime(p.t, settings.speedPct, next.speedPct);
      if (p.state === 'countIn') {
        // The count-in follows the speed: same progress, new beat length.
        const k = settings.speedPct / next.speedPct;
        p.beatSec *= k;
        p.countElapsed *= k;
      }
    }
    setRaw(next);
    saveViewerSettings(storage, songId, next);
  };

  const changeTranspose = (n: number) => {
    const t = clampTranspose(n);
    if (t === settings.transpose) return;
    update({ transpose: t });
    const label = keyLabel(song.meta.key, t);
    say(`移調 ${formatTranspose(t)}${label ? `、${label}` : ''}`);
  };

  const zoomIdx = ZOOM_STEPS.indexOf(settings.zoom);
  const canZoomOut = zoomIdx > 0;
  const canZoomIn = zoomIdx < ZOOM_STEPS.length - 1;
  const zoomBy = (dir: 1 | -1) => {
    const z = zoomStep(settings.zoom, dir);
    if (z === settings.zoom) return;
    update({ zoom: z });
    say(`文字の大きさ ${Math.round(BASE_FONT_PX * z)}px`);
  };

  // ---- reading position in the scroll modes -------------------------------
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (nav === 'page') {
      el.scrollTop = 0;
      return;
    }
    // Playing: the loop places the view from the song time instead.
    if (playRef.current.state === 'playing') return;
    el.scrollTop = sheetAnchorY(units, anchorRef.current);
    restoredRef.current = el.scrollTop;
  }, [units, nav, vh]);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el || nav === 'page') return;
    const top = el.scrollTop;
    if (Math.abs(top - restoredRef.current) < 1) return;
    restoredRef.current = Number.NaN;
    if (units.length > 0) anchorRef.current = sheetAnchorAt(units, top);
    setScrollPage(pageIndexAt(pages, top));
  };

  // ---- navigation ---------------------------------------------------------
  /** The 0.3s "nothing more this way" nudge at either end. */
  const bump = (dir: 1 | -1) => {
    const el = viewportRef.current;
    if (!el) return;
    el.dataset.bump = dir > 0 ? 'end' : 'start';
    const reduce =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    const done = () => {
      delete el.dataset.bump;
    };
    if (reduce || typeof el.animate !== 'function') {
      setTimeout(done, 300);
      return;
    }
    const d = -10 * dir;
    el.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${d}px)` },
        { transform: `translateX(${-d / 2}px)` },
        { transform: 'translateX(0)' },
      ],
      { duration: 300, easing: 'ease-out' },
    ).onfinish = done;
  };

  const goPage = (dir: 1 | -1) => {
    const k = pageIdx + dir;
    if (k < 0 || k >= pages.length) {
      bump(dir);
      say(dir > 0 ? '最後のページです' : '最初のページです');
      return;
    }
    const a = sheetAnchorAt(units, pages[k].top);
    setPageAnchor(a);
    anchorRef.current = a;
    say(`${k + 1} / ${pages.length} ページ`);
  };

  const scrollStep = (dir: 1 | -1) => {
    const el = viewportRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (
      (dir > 0 && el.scrollTop >= max - 1) ||
      (dir < 0 && el.scrollTop <= 0)
    ) {
      bump(dir);
      return;
    }
    const playing =
      playRef.current.state === 'playing' ||
      playRef.current.state === 'countIn';
    el.scrollBy({
      top: dir * SCROLL_STEP * el.clientHeight,
      // The auto-scroll loop would fight a smooth scroll.
      behavior: playing ? 'auto' : 'smooth',
    });
  };

  /** Play mode put the viewer in fullscreen (so leaving it ends play mode). */
  const fullscreenRef = useRef(false);
  const enterPlayMode = () => {
    setPlayMode(true);
    setChromeVisible(false);
    say('演奏モード。上端をタップすると操作バーが出ます。Esc で終了');
    viewportRef.current?.focus({ preventScroll: true });
    const root = rootRef.current;
    if (root && typeof root.requestFullscreen === 'function') {
      root.requestFullscreen().then(
        () => {
          fullscreenRef.current = true;
        },
        () => {},
      );
    }
  };

  const exitPlayMode = () => {
    setPlayMode(false);
    setChromeVisible(false);
    say('演奏モードを終了');
    fullscreenRef.current = false;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    viewportRef.current?.focus({ preventScroll: true });
  };

  // Leaving fullscreen from the browser (Esc / gesture) ends play mode too.
  const exitPlayModeRef = useRef(exitPlayMode);
  useLayoutEffect(() => {
    exitPlayModeRef.current = exitPlayMode;
  });
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && fullscreenRef.current) {
        exitPlayModeRef.current();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keep the screen on in play mode and while auto-scrolling.
  const scrolling = playState === 'countIn' || playState === 'playing';
  const wantWakeLock = playMode || scrolling;
  useEffect(() => {
    if (!wantWakeLock || !('wakeLock' in navigator)) return;
    let cancelled = false;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (lock && !lock.released) return;
      navigator.wakeLock.request('screen').then(
        (l) => {
          if (cancelled) l.release().catch(() => {});
          else lock = l;
        },
        () => {},
      );
    };
    // The browser drops the lock when the page is hidden; take it again on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, [wantWakeLock]);

  // ---- keys (pedal) -------------------------------------------------------
  const actions: Record<ViewerAction, () => void> = {
    next: () => (nav === 'page' ? goPage(1) : scrollStep(1)),
    prev: () => (nav === 'page' ? goPage(-1) : scrollStep(-1)),
    togglePlay: () => {
      if (nav === 'auto') togglePlay();
    },
    exitPlayMode: () => {
      if (playMode) exitPlayMode();
    },
  };
  const keyState = useRef({ actions, nav, playMode, drawerOpen });
  useLayoutEffect(() => {
    keyState.current = { actions, nav, playMode, drawerOpen };
  });
  /** True from a pointer press until the next Tab key (keyboard navigation). */
  const pointerModality = useRef(false);
  useEffect(() => {
    const onPointer = () => {
      pointerModality.current = true;
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, []);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') pointerModality.current = false;
      const k = keyState.current;
      if (e.defaultPrevented || k.drawerOpen) return;
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) {
        return;
      }
      if (activatesTarget(e)) {
        // A button focused by the pointer (mouse / Android tap) must not take
        // the pedal's Space / Enter as a click: move focus to the sheet and
        // handle the key (preventDefault below also cancels the click).
        // Keyboard users (Tab-focused) keep the native button behaviour.
        if (!pointerModality.current) return;
        viewportRef.current?.focus({ preventScroll: true });
      }
      const action = viewerKeyToAction(e, {
        nav: k.nav,
        playMode: k.playMode,
        targetIsEditable: isEditable(e.target),
      });
      if (!action) return;
      e.preventDefault();
      k.actions[action]();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * After a pointer click on a toolbar / bar button, hand focus back to the
   * sheet so the pedal's Space / Enter keep meaning "next page" (or play /
   * pause). `detail === 0` = keyboard activation: focus stays for them.
   * Inside a non-modal popover (R13) the popover stays open but focus moves
   * to the sheet too; the modal drawer keeps its own focus.
   */
  const onRootClick = (e: ReactMouseEvent) => {
    if (e.detail === 0 || !(e.target instanceof Element)) return;
    if (!e.target.closest('button')) return;
    if (e.target.closest('[role="dialog"][aria-modal="true"]')) return;
    viewportRef.current?.focus({ preventScroll: true });
  };

  // ---- render -------------------------------------------------------------
  const fontPx = Math.round(BASE_FONT_PX * settings.zoom);
  const shownPage = nav === 'page' ? pageIdx : scrollPage;
  const highlight =
    nav === 'auto' && playState !== 'idle' ? playingSection : null;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-testid="viewer"
      data-nav={nav}
      data-play-mode={playMode || undefined}
      data-play-state={playState}
      data-ready={layout.ready || undefined}
      onClick={onRootClick}
    >
      {!playMode && (
        <ViewerToolbar
          title={title}
          layout={settings.layout}
          onLayoutChange={(l) => update({ layout: l })}
          partNames={partNames}
          part={settings.part}
          onPartChange={(p) => update({ part: p })}
          scoreHidden={settings.scoreHidden}
          onScoreHiddenChange={(h) => update({ scoreHidden: h })}
          scoreChart={settings.scoreChart}
          onScoreChartChange={(on) => update({ scoreChart: on })}
          nav={nav}
          onNavChange={(n) => update({ nav: n })}
          fontPx={fontPx}
          canZoomOut={canZoomOut}
          canZoomIn={canZoomIn}
          onZoomOut={() => zoomBy(-1)}
          transpose={settings.transpose}
          onTransposeChange={changeTranspose}
          songKey={song.meta.key}
          onZoomIn={() => zoomBy(1)}
          onBack={onExit}
          backLabel={backLabel}
          onPlayMode={enterPlayMode}
          onOpenSettings={() => setDrawerOpen(true)}
          settingsRef={settingsBtnRef}
        />
      )}
      <div className={styles.stage}>
        {/* Focusable so keyboard users can scroll it (and pedal keys land here). */}
        <div
          ref={viewportRef}
          className={styles.viewport}
          role="region"
          aria-label="譜面"
          tabIndex={0}
          data-testid="viewer-viewport"
          data-page-mode={nav === 'page' || undefined}
          onScroll={onScroll}
        >
          <div
            className={styles.content}
            data-testid="viewer-content"
            style={
              nav === 'page'
                ? { transform: `translateY(${-pageOffset}px)` }
                : undefined
            }
          >
            <Sheet
              song={song}
              layout={settings.layout}
              part={settings.part}
              scoreHidden={settings.scoreHidden}
              scoreChart={settings.scoreChart}
              zoom={settings.zoom}
              transpose={settings.transpose}
              playingSection={highlight}
              onLayout={setLayout}
            />
          </div>
          {nav === 'page' && (
            // Hides the end of the previous page above this one's first unit.
            <div
              className={styles.cover}
              style={{ top: 0, height: topGap }}
              aria-hidden="true"
            />
          )}
          {nav === 'page' && coverTop !== null && (
            <div
              className={styles.cover}
              style={{ top: coverTop }}
              aria-hidden="true"
              data-testid="page-cover"
            />
          )}
        </div>

        {nav === 'page' && (
          // mousedown guard: a tapped zone must not keep focus, or a pedal's
          // Space would "click" it again (possibly the 前 zone).
          <div
            className={styles.navLayer}
            onMouseDown={(e) => e.preventDefault()}
          >
            <PageNav
              page={pageIdx + 1}
              totalPages={pages.length}
              onPrev={() => goPage(-1)}
              onNext={() => goPage(1)}
              playMode={playMode}
            />
          </div>
        )}

        {playMode && nav === 'page' && (
          <>
            <p className={styles.pedalHint} aria-hidden="true">
              フットペダル対応（← / → ・PageUp / PageDown）
            </p>
            <div className={styles.bigPage} aria-hidden="true">
              {pageIdx + 1}
            </div>
          </>
        )}

        {nav === 'auto' && (
          <>
            <CountIn beat={beat} />
            <div className={styles.autoBar}>
              {!hasTempo && (
                <p className={styles.tempoNote}>
                  テンポ未設定（♩={DEFAULT_TEMPO}）
                </p>
              )}
              <AutoScrollBar
                playing={scrolling}
                playDisabled={!layout.ready}
                ended={playState === 'ended'}
                tempo={tempo}
                speedPct={settings.speedPct}
                countIn={settings.countIn}
                onPlay={() => play(false)}
                onPause={pause}
                onRestart={() => play(true)}
                onSpeedChange={(pct) => update({ speedPct: pct })}
                onCountInChange={(on) => update({ countIn: on })}
              />
            </div>
          </>
        )}

        {playMode && (
          <PlayModeChrome
            title={title}
            page={shownPage + 1}
            pageCount={pages.length}
            visible={chromeVisible}
            onVisibleChange={setChromeVisible}
            onExit={exitPlayMode}
            onZoomOut={() => zoomBy(-1)}
            onZoomIn={() => zoomBy(1)}
            zoomOutDisabled={!canZoomOut}
            zoomInDisabled={!canZoomIn}
          />
        )}
      </div>

      <SettingsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        anchorRef={viewportRef}
        settings={settings}
        partNames={partNames}
        onChange={(next) => update(next)}
      />

      <div
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        data-testid="viewer-live"
      >
        {liveMsg}
      </div>
    </div>
  );
}
