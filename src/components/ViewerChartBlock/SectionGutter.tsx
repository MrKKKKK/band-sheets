import styles from './ViewerChartBlock.module.css';

export type SectionGutterProps = {
  /** Section label ("A", "サビ", …). '' = no label: an empty gutter of the same width. */
  label: string;
  /** Highlights the label while auto-scroll is inside this section. */
  playing?: boolean;
};

/**
 * The fixed-width left column that holds a section's rehearsal mark. It has
 * the same width with or without a label, so the sheet's left edge never moves.
 * Decorative (aria-hidden): the owning section carries the accessible label.
 */
export function SectionGutter({ label, playing }: SectionGutterProps) {
  return (
    <div className={styles.gutter} aria-hidden="true">
      {label !== '' && (
        <span
          className={styles.mark}
          data-playing={playing || undefined}
          data-testid="section-mark"
        >
          {label}
        </span>
      )}
    </div>
  );
}
