import {
  AlphaTabApi,
  FontFileFormat,
  NotationElement,
  ScrollMode,
  Settings,
} from '@coderline/alphatab';
import bravuraOtf from '@coderline/alphatab/font/Bravura.otf?url';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';
import { useEffect, useRef, useState } from 'react';
import { disambiguateChordCase, restoreChordNames } from '../../lib/chordCase';
import { partsToAlphaTex } from '../../lib/partsToAlphaTex';
import type { Song } from '../../lib/song';
import { injectBravuraFontFace } from './bravuraFont';
import { percussionStemsUp } from './percussionStems';

// Registers `--font-music` (the Bravura @font-face) as a side effect of
// loading this module, so any sibling component rendered alongside
// PartScore can rely on the token without importing bravuraFont.ts itself.
// Components rendered on their own (e.g. a standalone MelodyStaff) should
// still call injectBravuraFontFace() directly — see that file's comment.
injectBravuraFontFace();

export interface PartScoreProps {
  song: Song;
  /** Parts to render (all when omitted). */
  partNames?: string[];
  /**
   * Delay (ms) before a tex/track change reaches alphaTab, so rapid input
   * (e.g. typed-in melody edits) doesn't re-render on every keystroke.
   * The AlphaTabApi instance itself is created once per mount regardless;
   * only the `api.tex(...)` call is debounced. Default 0 (no delay).
   */
  debounceMs?: number;
}

type RenderState = 'loading' | 'rendered' | 'error';

/**
 * Debounce for the resize-recovery render (M2): separate from the `tex`
 * debounce prop, which coalesces upstream song edits, not resize bursts.
 */
const RESIZE_RENDER_DEBOUNCE_MS = 150;

function createSettings(): Settings {
  const settings = new Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;
  // Font URLs resolved by Vite (dev and build) instead of fontDirectory.
  settings.core.smuflFontSources = new Map([
    [FontFileFormat.Woff2, bravuraWoff2],
    [FontFileFormat.OpenType, bravuraOtf],
  ]);
  settings.player.enablePlayer = false;
  // Even without a player, alphaTab places its beat cursor after every
  // render and the default scroll handler (ScrollMode.Continuous) then
  // smooth-scrolls the page (html/body) to that beat: in the editors this
  // yanked the window down to the preview on every note input.
  settings.player.scrollMode = ScrollMode.Off;
  settings.notation.elements.set(NotationElement.EffectDynamics, false);
  return settings;
}

/** Renders the song's instrument parts with alphaTab (verification only). */
export function PartScore({ song, partNames, debounceMs = 0 }: PartScoreProps) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const [state, setState] = useState<RenderState>('loading');
  const [error, setError] = useState('');
  const [apiCreateCount, setApiCreateCount] = useState(0);

  const tex = partsToAlphaTex(song, partNames);
  const trackCount = song.parts.filter(
    (p) => !partNames || partNames.includes(p.name),
  ).length;

  // Create the AlphaTabApi exactly once per mount (recreating it on every
  // tex change caused a re-render flicker); destroy it on unmount.
  useEffect(() => {
    if (!ref.current) return;
    let api: AlphaTabApi;
    try {
      api = new AlphaTabApi(ref.current, createSettings());
    } catch (e) {
      // alphaTab's constructor itself can throw synchronously (e.g. no real
      // browser environment — jsdom in unit tests, which App now reaches
      // through MelodyEditor's preview even off the melody tab, panels
      // staying mounted). Surface it through the existing error state
      // instead of crashing the whole render tree. Deferred (like the
      // `api.error.on` handler below) so setState isn't called synchronously
      // inside the effect.
      const message = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => {
        setError(message);
        setState('error');
      });
      return;
    }
    apiRef.current = api;
    // Deferred (like the catch-block setState above) so this isn't a
    // synchronous setState call inside the effect — oxlint's
    // `set-state-in-effect` flags that pattern even though the increment
    // itself is intentional (T15: prove the api is created once per mount).
    queueMicrotask(() => setApiCreateCount((c) => c + 1));
    // Drum staves: all stems/beams up (render time only, the tex is
    // untouched). scoreLoaded fires after import and before layout.
    api.scoreLoaded.on((score) => {
      restoreChordNames(score);
      percussionStemsUp(score);
    });
    api.renderFinished.on(() => setState('rendered'));
    api.error.on((e) => {
      setError(e.message);
      setState('error');
    });
    return () => {
      api.destroy();
      apiRef.current = null;
    };
  }, []);

  // Recover from alphaTab's width=0 render skip (M2): a `Tabs` panel kept
  // mounted-but-hidden (CLAUDE.md gotcha) has zero width while hidden, so
  // the AlphaTabApi created/tex'd inside it never actually draws anything
  // ("AlphaTab skipped rendering because of width=0"). alphaTab's own
  // internal resize handling doesn't re-trigger from that state in this
  // setup (we drive `api.tex()` ourselves rather than through its
  // markup-driven initial load, which is the path its built-in
  // IntersectionObserver recovery covers). Watch the container directly and
  // nudge a re-render once it gains real width; debounced so a burst of
  // resize entries (e.g. layout settling) only renders once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastWidth = el.getBoundingClientRect().width;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const previous = lastWidth;
      lastWidth = width;
      if (previous === 0 && width > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          apiRef.current?.render();
        }, RESIZE_RENDER_DEBOUNCE_MS);
      }
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // Re-render through the existing api when tex/tracks change, optionally
  // debounced so rapid upstream edits don't re-render on every keystroke.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const trackIndexes = Array.from({ length: trackCount }, (_, i) => i);
    setState('loading');
    if (debounceMs <= 0) {
      api.tex(disambiguateChordCase(tex), trackIndexes);
      return;
    }
    const timer = setTimeout(() => {
      api.tex(disambiguateChordCase(tex), trackIndexes);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [tex, trackCount, debounceMs]);

  return (
    <div data-state={state} data-api-creates={apiCreateCount}>
      {state === 'error' && <p role="alert">{error}</p>}
      <div ref={ref} />
    </div>
  );
}
