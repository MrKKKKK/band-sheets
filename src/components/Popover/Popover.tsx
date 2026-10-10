import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import styles from './Popover.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** Trigger element: focus returns here on close; clicks on it are not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  align?: 'start' | 'end';
  className?: string;
  /**
   * Escape hatch for a caller-computed position (R6), e.g. a horizontal
   * offset custom property read by the caller's own CSS — see
   * `ChordPopover`'s `--chord-popover-left`. Popover itself stays unaware
   * of the clamp math; this just forwards the style.
   */
  style?: CSSProperties;
  children: ReactNode;
};

/**
 * Non-modal dialog positioned below its anchor. The caller wraps the anchor
 * and the popover in a `position: relative` element (e.g. `PopoverAnchor`).
 * Esc / outside click → onClose; opening focuses the first focusable child;
 * closing returns focus to the anchor unless the user moved focus elsewhere.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  align = 'start',
  className,
  style,
  children,
  ...aria
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const anchor = anchorRef.current;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      // While an IME composition is active, Escape cancels the conversion
      // instead of the dialog; ignore it so in-progress input isn't lost
      // (isComposing is the standard flag, keyCode 229 the legacy fallback
      // some browsers still send for composition events).
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || el.contains(t) || anchor?.contains(t)) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      // Runs after the popover left the DOM. If focus was inside it, it is now
      // on <body>: hand it back to the anchor. If the user clicked another
      // focusable element, leave focus there.
      queueMicrotask(() => {
        // Still mounted (StrictMode effect re-run, or only deps changed).
        if (el.isConnected) return;
        const active = document.activeElement;
        if (!active || active === document.body) {
          anchor?.focus();
        }
      });
    };
  }, [open, anchorRef]);

  if (!open) return null;
  const cls = [styles.popover, styles[align], className]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      className={cls}
      style={style}
      {...aria}
    >
      {children}
    </div>
  );
}

/** `position: relative` wrapper for an anchor + its Popover. */
export function PopoverAnchor({ children }: { children: ReactNode }) {
  return <div className={styles.anchor}>{children}</div>;
}
