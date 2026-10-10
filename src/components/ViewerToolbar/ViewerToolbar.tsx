import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { NavMode, ViewerLayout } from '../../lib/viewerSettings';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import { SegmentedControl } from '../SegmentedControl/SegmentedControl';
import styles from './ViewerToolbar.module.css';

export type ViewerToolbarProps = {
  title: string;
  layout: ViewerLayout;
  onLayoutChange: (layout: ViewerLayout) => void;
  /** All part names of the song, in song order. */
  partNames: readonly string[];
  /** 「自分のパート」。null = コード譜だけ */
  part: string | null;
  onPartChange: (part: string | null) => void;
  /** Score view: names of the parts that are switched off. */
  scoreHidden: readonly string[];
  onScoreHiddenChange: (hidden: string[]) => void;
  scoreChart: boolean;
  onScoreChartChange: (on: boolean) => void;
  nav: NavMode;
  onNavChange: (nav: NavMode) => void;
  /** Effective font size shown between A− and A＋ (BASE_FONT_PX × zoom). */
  fontPx: number;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onBack: () => void;
  /** Label of the back button. Default 「← 編集に戻る」. */
  backLabel?: string;
  onPlayMode: () => void;
  onOpenSettings: () => void;
  /** Lets the settings drawer return focus to the 設定 button. */
  settingsRef?: Ref<HTMLButtonElement>;
};

const LAYOUT_OPTIONS: { value: ViewerLayout; label: string }[] = [
  { value: 'part', label: '自分のパート＋コード譜' },
  { value: 'score', label: 'スコア' },
];

const NAV_OPTIONS: { value: NavMode; label: string }[] = [
  { value: 'page', label: 'ページめくり' },
  { value: 'scroll', label: 'スクロール' },
  { value: 'auto', label: '自動' },
];

/** Below this bar width the nav / zoom groups are left to the settings drawer and score chips collapse into a popover. */
export const COMPACT_BELOW_PX = 1400;

/** True when the element is narrower than `limit` px (measured on the element, not the viewport). */
function useNarrow(ref: { current: HTMLElement | null }, limit: number) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setNarrow(el.getBoundingClientRect().width < limit);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, limit]);
  return narrow;
}

/** Viewer top bar (canvas plan A). Below COMPACT_BELOW_PX the nav / zoom groups are left to the settings drawer and score chips go into a popover. */
export function ViewerToolbar({
  title,
  layout,
  onLayoutChange,
  partNames,
  part,
  onPartChange,
  scoreHidden,
  onScoreHiddenChange,
  scoreChart,
  onScoreChartChange,
  nav,
  onNavChange,
  fontPx,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onBack,
  backLabel = '← 編集に戻る',
  onPlayMode,
  onOpenSettings,
  settingsRef,
}: ViewerToolbarProps) {
  const [partOpen, setPartOpen] = useState(false);
  const partBtnRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const compact = useNarrow(barRef, COMPACT_BELOW_PX);

  const choose = (p: string | null) => {
    onPartChange(p);
    setPartOpen(false);
  };
  const toggleHidden = (name: string) =>
    onScoreHiddenChange(
      scoreHidden.includes(name)
        ? scoreHidden.filter((n) => n !== name)
        : [...scoreHidden, name],
    );

  return (
    <header ref={barRef} className={styles.bar} aria-label="閲覧の操作">
      <Button variant="ghost" className={styles.nowrap} onClick={onBack}>
        {backLabel}
      </Button>
      <h1 className={styles.title} title={title}>
        {title}
      </h1>
      <span className={styles.sep} aria-hidden="true" />
      <SegmentedControl
        label="表示の組み合わせ"
        options={LAYOUT_OPTIONS}
        value={layout}
        onChange={onLayoutChange}
      />
      {layout === 'part' ? (
        <PopoverAnchor>
          <Button
            ref={partBtnRef}
            variant="secondary"
            className={styles.nowrap}
            aria-haspopup="dialog"
            aria-expanded={partOpen}
            onClick={() => setPartOpen((o) => !o)}
          >
            パート: {part ?? 'コード譜だけ'}
            <span aria-hidden="true">▾</span>
          </Button>
          <Popover
            open={partOpen}
            onClose={() => setPartOpen(false)}
            anchorRef={partBtnRef}
            aria-label="自分のパート"
          >
            <div className={styles.partList}>
              <Button
                variant="ghost"
                aria-pressed={part === null}
                className={styles.partItem}
                onClick={() => choose(null)}
              >
                コード譜だけ
              </Button>
              {partNames.map((n) => (
                <Button
                  key={n}
                  variant="ghost"
                  aria-pressed={part === n}
                  className={styles.partItem}
                  onClick={() => choose(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </Popover>
        </PopoverAnchor>
      ) : (
        <ScoreParts
          compact={compact}
          partNames={partNames}
          scoreHidden={scoreHidden}
          scoreChart={scoreChart}
          onToggleHidden={toggleHidden}
          onScoreChartChange={onScoreChartChange}
        />
      )}
      {!compact && (
        <>
          <span className={styles.sep} aria-hidden="true" />
          <SegmentedControl
            label="ページの進め方"
            options={NAV_OPTIONS}
            value={nav}
            onChange={onNavChange}
          />
        </>
      )}
      <span className={styles.spacer} />
      {!compact && (
        <div role="group" aria-label="文字の大きさ" className={styles.zoom}>
          <Button
            variant="ghost"
            aria-label="文字を小さく"
            disabled={!canZoomOut}
            onClick={onZoomOut}
          >
            A−
          </Button>
          <span className={styles.px} data-testid="font-px">
            {fontPx}px
          </span>
          <Button
            variant="ghost"
            aria-label="文字を大きく"
            disabled={!canZoomIn}
            onClick={onZoomIn}
          >
            A＋
          </Button>
        </div>
      )}
      <Button variant="primary" className={styles.nowrap} onClick={onPlayMode}>
        演奏モード
      </Button>
      <Button
        ref={settingsRef}
        variant="secondary"
        className={styles.nowrap}
        onClick={onOpenSettings}
      >
        設定
      </Button>
    </header>
  );
}

type ScorePartsProps = {
  compact: boolean;
  partNames: readonly string[];
  scoreHidden: readonly string[];
  scoreChart: boolean;
  onToggleHidden: (name: string) => void;
  onScoreChartChange: (on: boolean) => void;
};

/** Score layout: the コード譜 / part chips, or one 「パート ▾」 popover when compact. */
function ScoreParts({
  compact,
  partNames,
  scoreHidden,
  scoreChart,
  onToggleHidden,
  onScoreChartChange,
}: ScorePartsProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const chips = (
    <div role="group" aria-label="表示するパート" className={styles.chips}>
      <Chip
        selected={scoreChart}
        onClick={() => onScoreChartChange(!scoreChart)}
      >
        コード譜
      </Chip>
      {partNames.map((n) => (
        <Chip
          key={n}
          selected={!scoreHidden.includes(n)}
          onClick={() => onToggleHidden(n)}
        >
          {n}
        </Chip>
      ))}
    </div>
  );
  if (!compact) return chips;
  return (
    <PopoverAnchor>
      <Button
        ref={btnRef}
        variant="secondary"
        className={styles.nowrap}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        パート<span aria-hidden="true">▾</span>
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={btnRef}
        aria-label="表示するパート"
      >
        <div className={styles.chipsPopover}>{chips}</div>
      </Popover>
    </PopoverAnchor>
  );
}
