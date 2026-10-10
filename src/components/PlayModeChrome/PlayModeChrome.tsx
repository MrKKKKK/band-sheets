import { useEffect, useRef } from 'react';
import styles from './PlayModeChrome.module.css';

export interface PlayModeChromeProps {
  title: string;
  /** 1-based current page and total (page-turn mode). */
  page: number;
  pageCount: number;
  /** Whether the slide-down bar is shown (controlled by the parent). */
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  onExit: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  zoomOutDisabled?: boolean;
  zoomInDisabled?: boolean;
  /** Auto-hide delay after the last interaction; tests pass a small value. */
  autoHideMs?: number;
}

/**
 * Play-mode chrome (M6 T10): a thin always-present strip at the top edge
 * ("tap for the bar") and the slide-down bar. The bar hides again on a second
 * strip tap / the transparent area of the bar, or after `autoHideMs` without
 * any interaction inside it. Positioned absolutely: mount inside a
 * `position: relative` viewer root.
 */
export function PlayModeChrome({
  title,
  page,
  pageCount,
  visible,
  onVisibleChange,
  onExit,
  onZoomOut,
  onZoomIn,
  zoomOutDisabled = false,
  zoomInDisabled = false,
  autoHideMs = 4000,
}: PlayModeChromeProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRef = useRef(onVisibleChange);
  useEffect(() => {
    hideRef.current = onVisibleChange;
  });

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const arm = () => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      hideRef.current(false);
    }, autoHideMs);
  };

  useEffect(() => {
    if (!visible) return undefined;
    const id = setTimeout(() => {
      timer.current = null;
      hideRef.current(false);
    }, autoHideMs);
    timer.current = id;
    return () => {
      clearTimeout(id);
      timer.current = null;
    };
  }, [visible, autoHideMs]);

  return (
    <>
      <button
        type="button"
        className={styles.strip}
        aria-label="操作バーを表示"
        aria-expanded={visible}
        onClick={() => onVisibleChange(!visible)}
      >
        <span className={styles.stripHint} aria-hidden="true">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          上端をタップで操作バー
        </span>
      </button>
      {visible && (
        <div
          className={styles.bar}
          data-testid="play-mode-bar"
          onPointerDown={arm}
          onKeyDown={arm}
        >
          <button
            type="button"
            className={styles.iconButton}
            aria-label="演奏モードを終了"
            onClick={onExit}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              aria-hidden="true"
            >
              <path d="M15 3H6a2 2 0 00-2 2v14a2 2 0 002 2h9M10 12h11M17 8l4 4-4 4" />
            </svg>
          </button>
          <span className={styles.title}>{title}</span>
          <button
            type="button"
            className={styles.spacer}
            aria-label="操作バーを隠す"
            onClick={() => onVisibleChange(false)}
          />
          <span className={styles.page} data-testid="play-mode-page">
            {page} / {pageCount}
          </span>
          <span className={styles.divider} aria-hidden="true" />
          <button
            type="button"
            className={styles.zoomButton}
            aria-label="文字を小さく"
            disabled={zoomOutDisabled}
            onClick={onZoomOut}
          >
            A−
          </button>
          <button
            type="button"
            className={styles.zoomButton}
            aria-label="文字を大きく"
            disabled={zoomInDisabled}
            onClick={onZoomIn}
          >
            A＋
          </button>
        </div>
      )}
    </>
  );
}
