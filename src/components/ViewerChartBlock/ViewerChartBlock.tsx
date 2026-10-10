import { isRawLine, type ChartSection } from '../../lib/song';
import { ChordLyricLine } from '../ChordLyricLine/ChordLyricLine';
import { SectionGutter } from './SectionGutter';
import styles from './ViewerChartBlock.module.css';

export type ViewerChartBlockProps = {
  section: ChartSection;
  /** Unique per section on the page; prefixes the line keys (`<key>-<line>`). */
  sectionKey: string;
  /** Auto-scroll is currently inside this section: highlight its gutter mark. */
  playing?: boolean;
  /**
   * Font size of the chord chart (CSS length, default 22px). Sets
   * `--viewer-font-size`; every size inside the block is in em of it.
   */
  fontSize?: string;
  /**
   * Accessible name of the section region, overriding the label (e.g.
   * 「A（2回目）」 when the chart repeats a section, so region names stay unique).
   */
  ariaLabel?: string;
};

/**
 * One section of the chord chart for the viewer: rehearsal mark in a left
 * gutter, then the chords-over-lyrics lines (read-only `ChordLyricLine`).
 * Every line is wrapped in a `data-unit` element so the viewer can measure
 * each one's height for pagination; the last line also has
 * `data-keep-with-next` (it stays on the page of the score staff below it).
 */
export function ViewerChartBlock({
  section,
  sectionKey,
  playing,
  fontSize,
  ariaLabel,
}: ViewerChartBlockProps) {
  const label = section.label !== '' ? section.label : section.kind;
  const named = section.kind !== '' || section.label !== '';
  const last = section.lines.length - 1;
  return (
    <section
      className={styles.block}
      aria-label={named ? (ariaLabel ?? label) : undefined}
      aria-current={playing || undefined}
      style={
        fontSize === undefined
          ? undefined
          : ({ '--viewer-font-size': fontSize } as React.CSSProperties)
      }
      data-testid={`chart-block-${sectionKey}`}
    >
      <SectionGutter label={named ? label : ''} playing={playing} />
      <div className={styles.lines}>
        {section.lines.map((line, li) => {
          const key = `${sectionKey}-${li}`;
          const keep = li === last ? { 'data-keep-with-next': '' } : {};
          if (isRawLine(line)) {
            return (
              <div
                key={key}
                className={`${styles.unit} ${styles.raw}`}
                data-unit=""
                {...keep}
              >
                {line.raw}
              </div>
            );
          }
          if (line.segments.length === 0) {
            return (
              <div
                key={key}
                className={`${styles.unit} ${styles.blank}`}
                data-unit=""
                aria-hidden="true"
                {...keep}
              />
            );
          }
          const chordOnly = line.segments.every(
            (seg) => seg.lyrics.trim() === '',
          );
          return (
            <div
              key={key}
              className={styles.unit}
              data-unit=""
              data-chord-only={chordOnly || undefined}
              {...keep}
            >
              <ChordLyricLine line={line} lineKey={key} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
