import styles from './CountIn.module.css';

export interface CountInProps {
  /** Beat number to show (1-based), or null when not counting in. */
  beat: number | null;
}

/**
 * Big beat number in the middle of the screen during the 1-bar count-in
 * (M6). Purely visual: `aria-hidden`, no live region (no sound either).
 */
export function CountIn({ beat }: CountInProps) {
  if (beat === null) return null;
  return (
    <div className={styles.overlay} aria-hidden="true" data-testid="count-in">
      <span key={beat} className={styles.beat}>
        {beat}
      </span>
    </div>
  );
}
