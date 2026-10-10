import { graphemes } from '../../lib/chartEdit';
import type { LyricLine } from '../../lib/song';
import styles from './ChordLyricLine.module.css';

export type ChordLyricLineProps = {
  line: LyricLine;
  /** Unique per line on the page (e.g. "0-1"); used in data-testid values. */
  lineKey: string;
  /**
   * Makes every lyric character (grapheme cluster, see `graphemes` in
   * chartEdit.ts) a button, plus one end-of-line button (charIndex = line
   * length). `anchor` is the clicked button, for positioning a popover.
   */
  onCharClick?: (charIndex: number, anchor: HTMLButtonElement) => void;
  /** Makes existing chords buttons; `segIndex` indexes `line.segments`. */
  onChordClick?: (segIndex: number, anchor: HTMLButtonElement) => void;
  /** Highlighted character position (may equal the line length = line end). */
  activeCharIndex?: number;
};

/**
 * One chart line as inline-block columns: chord on top (or an empty row of
 * the same height), lyrics below. The chord shares its column's left edge
 * with the segment's first character, so alignment does not depend on
 * monospace padding (works for Japanese text).
 */
export function ChordLyricLine({
  line,
  lineKey,
  onCharClick,
  onChordClick,
  activeCharIndex,
}: ChordLyricLineProps) {
  const editable = onCharClick !== undefined || onChordClick !== undefined;
  const segChars = line.segments.map((seg) => graphemes(seg.lyrics));
  const starts: number[] = [];
  let length = 0;
  for (const chars of segChars) {
    starts.push(length);
    length += chars.length;
  }
  const segments = line.segments.map((seg, segIndex) => {
    const chars = segChars[segIndex];
    const start = starts[segIndex];
    return (
      <span
        key={segIndex}
        className={styles.segment}
        data-testid={`seg-${lineKey}-${segIndex}`}
      >
        <span className={styles.chordRow}>
          {seg.chord === undefined ? null : onChordClick ? (
            <button
              type="button"
              className={`${styles.chord} ${styles.chordButton}`}
              aria-label={`コード ${seg.chord} を編集`}
              data-testid={`chord-${lineKey}-${segIndex}`}
              onClick={(e) => onChordClick(segIndex, e.currentTarget)}
            >
              {seg.chord}
            </button>
          ) : (
            <span
              className={styles.chord}
              data-testid={`chord-${lineKey}-${segIndex}`}
            >
              {seg.chord}
            </span>
          )}
        </span>
        <span className={styles.lyricRow}>
          {onCharClick
            ? chars.map((ch, i) => {
                const charIndex = start + i;
                return (
                  <button
                    key={i}
                    type="button"
                    className={styles.charButton}
                    data-active={activeCharIndex === charIndex || undefined}
                    aria-label={`${charIndex + 1}文字目「${ch}」にコードを置く`}
                    data-testid={`char-${lineKey}-${charIndex}`}
                    onClick={(e) => onCharClick(charIndex, e.currentTarget)}
                  >
                    {ch}
                  </button>
                );
              })
            : seg.lyrics}
        </span>
      </span>
    );
  });

  // Read-only chord-only lines (riffs, N.C.) drop the empty lyric row.
  const chordOnly =
    !editable && line.segments.every((seg) => seg.lyrics.trim() === '');
  const cls = [
    styles.line,
    editable && styles.editable,
    chordOnly && styles.chordOnly,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} data-testid={`line-${lineKey}`}>
      {segments}
      {onCharClick && (
        <span className={styles.segment}>
          <span className={styles.chordRow} />
          <span className={styles.lyricRow}>
            <button
              type="button"
              className={`${styles.charButton} ${styles.endButton}`}
              data-active={activeCharIndex === length || undefined}
              aria-label="行末にコードを置く"
              data-testid={`char-${lineKey}-${length}`}
              onClick={(e) => onCharClick(length, e.currentTarget)}
            >
              <span aria-hidden="true" className={styles.endMark} />
            </button>
          </span>
        </span>
      )}
    </div>
  );
}
