import {
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  displayKey,
  formatTranspose,
  keyLabel,
} from '../../lib/transpose';
import { Button } from '../Button/Button';
import styles from './TransposeControl.module.css';

export type TransposeControlProps = {
  /** Current semitones, −6..+6. */
  transpose: number;
  onTransposeChange: (next: number) => void;
  /** The song's own key (meta); without a usable one no key text is shown. */
  songKey?: string;
  /** 'inline' = the wide toolbar group, 'popover' = the compact popover body. */
  variant?: 'inline' | 'popover';
};

/**
 * Viewer transposition: a −/value/+ stepper whose side buttons show the
 * RESULTING value (at +3: 「+2」 and 「+4」), the key line, and an explicit
 * 「原曲キーに戻す」 button (disabled, not hidden, at 0). The middle value is
 * display-only.
 */
export function TransposeControl({
  transpose,
  onTransposeChange,
  songKey,
  variant = 'inline',
}: TransposeControlProps) {
  const down = transpose - 1;
  const up = transpose + 1;
  const label = keyLabel(songKey, transpose);
  const popover = variant === 'popover';
  const resetLabel =
    popover && label !== null && songKey
      ? `原曲キーに戻す（${displayKey(songKey)}）`
      : '原曲キーに戻す';
  return (
    <div
      role="group"
      aria-label="移調"
      className={`${styles.root} ${popover ? styles.popover : ''}`}
      data-testid="transpose-control"
    >
      {popover ? (
        <span className={styles.heading}>移調（半音）</span>
      ) : (
        <span className={styles.heading} aria-hidden="true">
          移調
        </span>
      )}
      <span className={styles.stepper}>
        <Button
          variant="ghost"
          className={styles.step}
          disabled={down < TRANSPOSE_MIN}
          aria-label={`移調を ${formatTranspose(down)} にする`}
          data-testid="transpose-down"
          onClick={() => onTransposeChange(down)}
        >
          {formatTranspose(down)}
        </Button>
        <span
          className={`${styles.value} ${transpose !== 0 ? styles.active : ''}`}
          data-testid="transpose-value"
          aria-label={`現在の移調 ${formatTranspose(transpose)}`}
          role="img"
        >
          {formatTranspose(transpose)}
        </span>
        <Button
          variant="ghost"
          className={styles.step}
          disabled={up > TRANSPOSE_MAX}
          aria-label={`移調を ${formatTranspose(up)} にする`}
          data-testid="transpose-up"
          onClick={() => onTransposeChange(up)}
        >
          {formatTranspose(up)}
        </Button>
      </span>
      {label !== null && (
        <span className={styles.key} data-testid="transpose-key">
          {label}
        </span>
      )}
      <Button
        variant="secondary"
        className={styles.reset}
        disabled={transpose === 0}
        data-testid="transpose-reset"
        onClick={() => onTransposeChange(0)}
      >
        {resetLabel}
      </Button>
    </div>
  );
}
