import {
  fullWidthDashCandidate,
  isDashLine,
  meterOf,
  toHalfWidthDashLine,
  validateDashLine,
} from '../../lib/dashChart';
import { serializeLine } from '../../lib/serializeSong';
import { isRawLine, type Song } from '../../lib/song';
import { Button } from '../Button/Button';
import { ChordLyricLine } from '../ChordLyricLine/ChordLyricLine';
import styles from './ChartPreview.module.css';

export type ChartPreviewProps = {
  song: Song;
  /**
   * Editor only: shows 「半角に直す」 under a line with full-width dash
   * symbols. Gets the line's text now, its half-width text, and which
   * occurrence (0-based) of that text it is, so the caller can replace
   * just that text line. Without it the warning is shown without a button.
   */
  onFixFullWidth?: (from: string, to: string, occurrence: number) => void;
};

/** Read-only chord chart (editor preview): headings, chord/lyric lines, raw lines; dash lines that fail validation get a warning list. */
export function ChartPreview({ song, onFixFullWidth }: ChartPreviewProps) {
  const meter = meterOf(song.meta.time);
  const seen = new Map<string, number>();
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
              const text = serializeLine(line);
              const occurrence = seen.get(text) ?? 0;
              seen.set(text, occurrence + 1);
              if (fullWidthDashCandidate(line)) {
                return (
                  <div key={key}>
                    <ChordLyricLine line={line} lineKey={key} />
                    <div
                      className={styles.fullWidth}
                      data-testid={`fullwidth-warning-${key}`}
                    >
                      <span>全角の記号があります（｜ ー －）。</span>
                      {onFixFullWidth && (
                        <Button
                          variant="secondary"
                          className={styles.fixButton}
                          onClick={() =>
                            onFixFullWidth(
                              text,
                              serializeLine(toHalfWidthDashLine(line)),
                              occurrence,
                            )
                          }
                        >
                          半角に直す
                        </Button>
                      )}
                    </div>
                  </div>
                );
              }
              const errors = isDashLine(line)
                ? validateDashLine(line, meter)
                : [];
              if (errors.length === 0)
                return <ChordLyricLine key={key} line={line} lineKey={key} />;
              // Editor-only hint (no live region / alert): the line renders as is.
              return (
                <div key={key}>
                  <ChordLyricLine line={line} lineKey={key} />
                  <ul
                    className={styles.dashWarning}
                    data-testid={`dash-warning-${key}`}
                  >
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
