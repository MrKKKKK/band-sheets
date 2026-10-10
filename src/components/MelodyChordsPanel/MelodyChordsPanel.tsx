import { useId, useRef, useState } from 'react';
import type { MelodyEvent } from '../../lib/melody';
import {
  chordSummary,
  copyResultLines,
  type ChartChords,
  type CopyMode,
  type CopySummary,
} from '../../lib/melodyChords';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './MelodyChordsPanel.module.css';

export interface MelodyChordsPanelProps {
  events: MelodyEvent[];
  /** The chart section's chords mapped to syllables (`chartChords`). */
  chart: ChartChords;
  /** Label of the section being edited, for hint text. */
  sectionLabel: string;
  /** Selected event index from the staff (null = none). */
  selected: number | null;
  /** Result of the last copy in this section, or null. */
  result?: CopySummary | null;
  /** Copy the chart's chords (after the confirm when chords exist). */
  onCopy: (mode: CopyMode) => void;
  /** Open the chord popover for the selected event (Shift+C). */
  onEdit: () => void;
  /** Delete the selected event's chord (Shift+⌫). */
  onDelete: () => void;
  /** Delete every chord of the section (after a confirm). */
  onClearAll: () => void;
}

/**
 * Melody editor 「コード」 panel (issue #6, sketch 案 B): copies the chord
 * chart's chords onto the section's notes (confirming 上書き / 空いている
 * 音符だけ when chords exist), lists the section's chords with counts,
 * changes / deletes the selected note's chord (the popover itself is
 * MelodyEditor's, over the staff) and clears the section's chords. Buttons
 * that act directly are `onMouseDown`-guarded so the staff keeps keyboard
 * focus; nothing here is a live region (MelodyEditor announces).
 */
export function MelodyChordsPanel({
  events,
  chart,
  sectionLabel,
  selected,
  result = null,
  onCopy,
  onEdit,
  onDelete,
  onClearAll,
}: MelodyChordsPanelProps) {
  const headingId = useId();
  const copyRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState<'copy' | 'clear' | null>(null);

  const summary = chordSummary(events);
  const hasChart = chart.syllables.length > 0 || chart.chords.length > 0;
  const hasChartChords = chart.chords.length > 0;
  const hasLyricNotes = events.some((e) => e.kind === 'note' && e.lyric);
  const copyDisabled = !hasChartChords || !hasLyricNotes;

  const target =
    selected !== null && selected >= 0 && selected < events.length
      ? events[selected]
      : undefined;
  const noun = target?.kind === 'rest' ? '休符' : '音符';

  const copy = (mode: CopyMode) => {
    setConfirm(null);
    onCopy(mode);
  };
  const handleCopyClick = () => {
    if (summary.total > 0) setConfirm('copy');
    else copy('overwrite');
  };
  const clearAll = () => {
    setConfirm(null);
    onClearAll();
  };
  const guard = (e: { preventDefault: () => void }) => e.preventDefault();

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        コード
      </h3>

      <div className={styles.block}>
        <PopoverAnchor>
          <Button
            ref={copyRef}
            variant="secondary"
            className={styles.copyButton}
            disabled={copyDisabled}
            aria-haspopup={summary.total > 0 ? 'dialog' : undefined}
            aria-expanded={summary.total > 0 ? confirm === 'copy' : undefined}
            onMouseDown={guard}
            onClick={handleCopyClick}
          >
            コード譜からコードを写す
          </Button>
          <Popover
            open={confirm === 'copy'}
            onClose={() => setConfirm(null)}
            anchorRef={copyRef}
            aria-label="コードを写す方法"
            className={styles.confirmPopover}
          >
            <p className={styles.confirmText}>
              すでにコードが {summary.total} 個付いています。どうしますか？
            </p>
            <div className={styles.confirmActions}>
              <Button
                variant="primary"
                onMouseDown={guard}
                onClick={() => copy('overwrite')}
              >
                すべて上書きする
              </Button>
              <Button
                variant="secondary"
                onMouseDown={guard}
                onClick={() => copy('fillEmpty')}
              >
                空いている音符だけに写す
              </Button>
              <Button
                variant="ghost"
                onMouseDown={guard}
                onClick={() => setConfirm(null)}
              >
                キャンセル
              </Button>
            </div>
          </Popover>
        </PopoverAnchor>
        {!hasChart && (
          <p className={styles.hint}>
            コード譜にセクション {sectionLabel} がありません
          </p>
        )}
        {hasChart && !hasChartChords && (
          <p className={styles.hint}>
            コード譜のセクション {sectionLabel} にコードがありません
          </p>
        )}
        {hasChartChords && !hasLyricNotes && (
          <p className={styles.hint}>
            先に歌詞を音符に付けてください（コードは歌詞の音節をたよりに写します）
          </p>
        )}
        {result && (
          <div className={styles.result} data-testid="chord-copy-result">
            {copyResultLines(result).map((line, i) => (
              <p
                key={i}
                className={
                  i === 0 && result.copied > 0
                    ? styles.success
                    : i === 0
                      ? styles.hint
                      : styles.warning
                }
              >
                {i === 0 && result.copied > 0 && (
                  <span aria-hidden="true">✓ </span>
                )}
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className={styles.block}>
        <p className={styles.groupLabel}>このセクションのコード（付いた数）</p>
        {summary.chords.length > 0 ? (
          <ul className={styles.chips} aria-label="このセクションのコード">
            {summary.chords.map(({ chord, count }) => (
              <li key={chord} className={styles.chip}>
                {chord}
                <span className={styles.count}> ×{count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>まだコードがありません</p>
        )}
        <p className={styles.counter}>
          コードが付いた音符 {summary.notesWithChord} / {summary.noteCount}
        </p>
      </div>

      <div className={styles.selectedBox}>
        {target ? (
          <>
            <p className={styles.selectedText}>
              選んだ{noun}（{selected! + 1} 音目）のコード
              <span
                className={target.chord ? styles.selectedChord : styles.none}
              >
                {target.chord ?? 'なし'}
              </span>
            </p>
            <div className={styles.selectedActions}>
              <Button
                variant="secondary"
                aria-keyshortcuts="Shift+C"
                className={styles.opButton}
                onClick={onEdit}
              >
                {target.chord ? '変更' : '置く'}
                <span aria-hidden="true" className={styles.mnemonic}>
                  Shift+C
                </span>
              </Button>
              {target.chord && (
                <Button
                  variant="secondary"
                  aria-keyshortcuts="Shift+Backspace"
                  className={`${styles.opButton} ${styles.deleteButton}`}
                  onMouseDown={guard}
                  onClick={onDelete}
                >
                  消す
                  <span aria-hidden="true" className={styles.mnemonic}>
                    Shift+⌫
                  </span>
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className={styles.hint}>
            音符を選ぶと、その音符のコードを置く・変える・消すことができます
          </p>
        )}
      </div>

      <PopoverAnchor>
        <Button
          ref={clearRef}
          variant="ghost"
          className={styles.clearButton}
          disabled={summary.total === 0}
          aria-haspopup="dialog"
          aria-expanded={confirm === 'clear'}
          onMouseDown={guard}
          onClick={() => setConfirm('clear')}
        >
          このセクションのコードをすべて消す
        </Button>
        <Popover
          open={confirm === 'clear'}
          onClose={() => setConfirm(null)}
          anchorRef={clearRef}
          aria-label="コードをすべて消す確認"
          className={styles.confirmPopover}
        >
          <p className={styles.confirmText}>
            このセクションのコード {summary.total}{' '}
            個をすべて消します。よろしいですか？
          </p>
          <div className={styles.confirmActions}>
            <Button variant="danger" onMouseDown={guard} onClick={clearAll}>
              すべて消す
            </Button>
            <Button
              variant="ghost"
              onMouseDown={guard}
              onClick={() => setConfirm(null)}
            >
              キャンセル
            </Button>
          </div>
        </Popover>
      </PopoverAnchor>
    </section>
  );
}
