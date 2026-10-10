import styles from './PageNav.module.css';

export interface PageNavProps {
  /** 1-based current page */
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  /** Play mode: wider tap zones (32%), no hints, no bottom row. */
  playMode?: boolean;
}

function Chevron({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
    >
      <path d={dir === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

/**
 * Page-turn controls laid over the viewer's content area (the parent must be
 * `position: relative`). The root ignores pointer events except on the zones
 * and buttons, so the content underneath stays usable.
 */
export function PageNav({
  page,
  totalPages,
  onPrev,
  onNext,
  playMode = false,
}: PageNavProps) {
  const atStart = page <= 1;
  const atEnd = page >= totalPages;
  const zoneClass = playMode ? styles.zonePlay : styles.zone;
  // With the bottom row visible, the zones are a touch shortcut only.
  const zoneProps = playMode
    ? {}
    : ({ 'aria-hidden': true, tabIndex: -1 } as const);

  return (
    <div className={styles.root} data-testid="page-nav">
      <button
        type="button"
        className={`${zoneClass} ${styles.left}`}
        aria-label="前のページ"
        disabled={atStart}
        onClick={onPrev}
        data-testid="tap-prev"
        {...zoneProps}
      >
        {!playMode && (
          <>
            <span className={styles.hint}>タップで前のページ</span>
            <span className={styles.arrow}>
              <Chevron dir="prev" />
            </span>
          </>
        )}
      </button>
      <button
        type="button"
        className={`${zoneClass} ${styles.right}`}
        aria-label="次のページ"
        disabled={atEnd}
        onClick={onNext}
        data-testid="tap-next"
        {...zoneProps}
      >
        {!playMode && (
          <>
            <span className={styles.hint}>タップで次のページ</span>
            <span className={styles.arrow}>
              <Chevron dir="next" />
            </span>
          </>
        )}
      </button>
      {!playMode && (
        <div className={styles.bar}>
          <button
            type="button"
            className={styles.step}
            aria-label="前のページ"
            disabled={atStart}
            onClick={onPrev}
          >
            <Chevron dir="prev" />
          </button>
          <div className={styles.count} data-testid="page-count">
            {page} / {totalPages}
          </div>
          <button
            type="button"
            className={styles.step}
            aria-label="次のページ"
            disabled={atEnd}
            onClick={onNext}
          >
            <Chevron dir="next" />
          </button>
        </div>
      )}
    </div>
  );
}
