import { useEffect, useId, useRef, type RefObject } from 'react';
import {
  BASE_FONT_PX,
  ZOOM_STEPS,
  zoomStep,
  type NavMode,
  type ViewerLayout,
  type ViewerSettings,
} from '../../lib/viewerSettings';
import styles from './SettingsDrawer.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** The 「設定」 button: focus returns here on close. */
  anchorRef: RefObject<HTMLElement | null>;
  settings: ViewerSettings;
  /** Part names of the song, in song order. */
  partNames: readonly string[];
  /** One combined update per user action. */
  onChange: (next: ViewerSettings) => void;
};

const LAYOUTS: { value: ViewerLayout; title: string; desc: string }[] = [
  {
    value: 'part',
    title: '自分のパート＋コード譜',
    desc: '1つのパートをコード譜と一緒に表示',
  },
  {
    value: 'score',
    title: 'スコア（全パート）',
    desc: '全パートを小節で揃えて表示',
  },
];

const NAVS: { value: NavMode; title: string; desc: string }[] = [
  {
    value: 'page',
    title: 'ページめくり',
    desc: '左右タップ／フットペダルで送る',
  },
  {
    value: 'scroll',
    title: '縦スクロール',
    desc: '指でスクロールして読み進める',
  },
  {
    value: 'auto',
    title: '自動スクロール',
    desc: 'テンポに合わせて自動で流す',
  },
];

function Choice({
  title,
  desc,
  selected,
  onSelect,
}: {
  title: string;
  desc: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={styles.choice}
      onClick={onSelect}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>
        <span className={styles.choiceTitle}>{title}</span>
        <span className={styles.choiceDesc}>{desc}</span>
      </span>
    </button>
  );
}

/**
 * Right-hand modal drawer for the viewer's settings (canvas ⑤). Esc /
 * backdrop tap closes; opening focuses the close button, Tab is trapped
 * inside, closing returns focus to the 「設定」 button.
 */
export function SettingsDrawer({
  open,
  onClose,
  anchorRef,
  settings,
  partNames,
  onChange,
}: SettingsDrawerProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const anchor = anchorRef.current;
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (anchor?.isConnected) anchor.focus();
    };
  }, [open, anchorRef]);

  if (!open) return null;

  const set = (patch: Partial<ViewerSettings>) =>
    onChange({ ...settings, ...patch });
  const zoomIdx = ZOOM_STEPS.indexOf(settings.zoom);
  const canDec = zoomIdx !== 0;
  const canInc = zoomIdx !== ZOOM_STEPS.length - 1;
  const px = Math.round(BASE_FONT_PX * settings.zoom);

  const toggleHidden = (name: string) =>
    set({
      scoreHidden: settings.scoreHidden.includes(name)
        ? settings.scoreHidden.filter((n) => n !== name)
        : [...settings.scoreHidden, name],
    });

  return (
    <div className={styles.root}>
      <div
        className={styles.backdrop}
        data-testid="settings-backdrop"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.drawer}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            曲・表示の設定
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="閉じる"
            className={styles.close}
            onClick={onClose}
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
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.label}>レイアウト</h3>
            <div className={styles.choices}>
              {LAYOUTS.map((l) => (
                <Choice
                  key={l.value}
                  title={l.title}
                  desc={l.desc}
                  selected={settings.layout === l.value}
                  onSelect={() => set({ layout: l.value })}
                />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.label}>表示するパート</h3>
            {settings.layout === 'part' ? (
              <div
                className={styles.chips}
                role="group"
                aria-label="自分のパート"
              >
                {partNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={settings.part === name}
                    className={styles.chip}
                    onClick={() => set({ part: name })}
                  >
                    {name}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={settings.part === null}
                  className={styles.chip}
                  onClick={() => set({ part: null })}
                >
                  コード譜だけ
                </button>
              </div>
            ) : (
              <div
                className={styles.chips}
                role="group"
                aria-label="表示するパート"
              >
                {partNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={!settings.scoreHidden.includes(name)}
                    className={styles.chip}
                    onClick={() => toggleHidden(name)}
                  >
                    {name}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={settings.scoreChart}
                  className={styles.chip}
                  onClick={() => set({ scoreChart: !settings.scoreChart })}
                >
                  コード譜
                </button>
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.label}>ページ送り方式</h3>
            <div className={styles.choices}>
              {NAVS.map((n) => (
                <Choice
                  key={n.value}
                  title={n.title}
                  desc={n.desc}
                  selected={settings.nav === n.value}
                  onSelect={() => set({ nav: n.value })}
                />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.label}>文字サイズ</h3>
            <div className={styles.sizeRow}>
              <button
                type="button"
                aria-label="文字を小さく"
                className={styles.sizeBtn}
                disabled={!canDec}
                onClick={() => set({ zoom: zoomStep(settings.zoom, -1) })}
              >
                A−
              </button>
              <div
                className={styles.sample}
                style={{ fontSize: `${px}px` }}
                data-testid="size-sample"
              >
                あいう 123
              </div>
              <button
                type="button"
                aria-label="文字を大きく"
                className={styles.sizeBtn}
                disabled={!canInc}
                onClick={() => set({ zoom: zoomStep(settings.zoom, 1) })}
              >
                A＋
              </button>
            </div>
            <p className={styles.px} data-testid="size-px">
              {px}px
            </p>
          </section>
        </div>

        <p className={styles.footer}>この曲につき設定を記憶します</p>
      </div>
    </div>
  );
}
