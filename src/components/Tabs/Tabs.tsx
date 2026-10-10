import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Tabs.module.css';

export type TabItem<T extends string> = {
  id: T;
  label: string;
  content: ReactNode;
};

export type TabsProps<T extends string> = {
  /** Accessible name of the tablist. */
  label: string;
  tabs: TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  /** Class of the wrapper around the tablist (e.g. a full-width bar). */
  barClassName?: string;
  /** Class of the inner element that holds the tab buttons. */
  listClassName?: string;
  panelClassName?: string;
};

/**
 * WAI-ARIA tabs with automatic activation: ←/→ move (wrapping), Home/End
 * jump; the focused tab is selected. Inactive panels stay mounted but hidden.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  barClassName,
  listClassName,
  panelClassName,
}: TabsProps<T>) {
  const id = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (t: T) => `${id}tab-${t}`;
  const panelId = (t: T) => `${id}panel-${t}`;

  const onKeyDown = (e: KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === selected);
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = tabs[next].id;
    onSelect(target);
    refs.current.get(target)?.focus();
  };

  return (
    <>
      <div className={barClassName}>
        <div
          role="tablist"
          aria-label={label}
          className={[styles.list, listClassName].filter(Boolean).join(' ')}
          onKeyDown={onKeyDown}
        >
          {tabs.map((t) => {
            const active = t.id === selected;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) refs.current.set(t.id, el);
                  else refs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                id={tabId(t.id)}
                aria-selected={active}
                aria-controls={panelId(t.id)}
                tabIndex={active ? 0 : -1}
                className={styles.tab}
                onClick={() => onSelect(t.id)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={panelId(t.id)}
          aria-labelledby={tabId(t.id)}
          hidden={t.id !== selected}
          className={panelClassName}
        >
          {t.content}
        </div>
      ))}
    </>
  );
}
