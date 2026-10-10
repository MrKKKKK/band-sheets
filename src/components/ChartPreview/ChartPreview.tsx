import { isRawLine, type Song } from '../../lib/song';
import { ChordLyricLine } from '../ChordLyricLine/ChordLyricLine';
import styles from './ChartPreview.module.css';

export type ChartPreviewProps = {
  song: Song;
};

/** Read-only chord chart: section headings, chord/lyric lines, raw lines. */
export function ChartPreview({ song }: ChartPreviewProps) {
  return (
    <div className={styles.preview}>
      {song.chart.map((section, si) => {
        const hasHeading = section.kind !== '';
        return (
          <section
            key={si}
            className={styles.section}
            aria-label={hasHeading ? section.label || section.kind : undefined}
          >
            {hasHeading && (
              <h3 className={styles.heading}>
                {section.label && (
                  <span className={styles.label}>{section.label}</span>
                )}
                <span className={styles.kind}>{section.kind}</span>
              </h3>
            )}
            {section.lines.map((line, li) => {
              const key = `${si}-${li}`;
              if (isRawLine(line)) {
                return (
                  <div key={key} className={styles.raw}>
                    {line.raw}
                  </div>
                );
              }
              if (line.segments.length === 0) {
                return (
                  <div key={key} className={styles.blank} aria-hidden="true" />
                );
              }
              return <ChordLyricLine key={key} line={line} lineKey={key} />;
            })}
          </section>
        );
      })}
    </div>
  );
}
