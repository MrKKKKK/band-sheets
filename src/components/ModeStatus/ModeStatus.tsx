import type { MouseEvent as ReactMouseEvent } from 'react';
import { Button } from '../Button/Button';
import styles from './ModeStatus.module.css';

export interface ModeStatusProps {
  /** No input/selection is possible at all (the section can't be edited). */
  readOnly: boolean;
  /** 0-based index of the selected item, or `null` while in input mode. */
  selected: number | null;
  /**
   * Noun for the thing being placed/selected, e.g. `音` for melody notes or
   * `拍` for drum beats — used as `入力中（カーソル位置に{unit}を追加）` and
   * `N {unit}目を選択中` (unless `ordinal` is given).
   */
  unit: string;
  /**
   * Counter for the selected item's position, e.g. `番目` (drums: a beat
   * here is the N-th note/rest of the section, not a musical beat;
   * m5-review.md R8). Defaults to `{unit}目`.
   */
  ordinal?: string;
  /** Click on 「入力に戻る」 (only shown while something is selected). */
  onClearSelection: () => void;
}

/**
 * The editor's one-line mode indicator (`mode-status` test id, M4/M8):
 * 入力中 / N {unit}目を選択中 + 「入力に戻る」, or 読み取り専用. Shared by
 * MelodyEditor and DrumEditor (M5 T10) — melody-specific wording goes
 * through `unit` / `ordinal` so callers can say 「拍」/「番目」 instead of
 * 「音」/「音目」.
 */
export function ModeStatus({
  readOnly,
  selected,
  unit,
  ordinal = `${unit}目`,
  onClearSelection,
}: ModeStatusProps) {
  const showClear = !readOnly && selected !== null;
  return (
    <div
      className={styles.modeRow}
      data-testid="mode-status"
      data-mode={readOnly ? 'readonly' : selected !== null ? 'select' : 'input'}
    >
      <span
        className={[styles.modeChip, showClear && styles.modeChipSelect]
          .filter(Boolean)
          .join(' ')}
      >
        {readOnly
          ? '読み取り専用'
          : selected !== null
            ? `${selected + 1} ${ordinal}を選択中 — Esc または五線の空いた所をクリックで入力に戻る`
            : `入力中（カーソル位置に${unit}を追加）`}
      </span>
      {showClear && (
        <Button
          className={styles.modeButton}
          onMouseDown={(e: ReactMouseEvent<HTMLButtonElement>) =>
            e.preventDefault()
          }
          onClick={onClearSelection}
        >
          入力に戻る
        </Button>
      )}
    </div>
  );
}
