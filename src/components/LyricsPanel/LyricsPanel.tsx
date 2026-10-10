import { useId, useRef, useState } from 'react';
import type { MelodyEvent } from '../../lib/melody';
import {
  autoAssign,
  extend,
  lyricMismatch,
  merge,
  noLyric,
  split,
} from '../../lib/melodyLyrics';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './LyricsPanel.module.css';

export interface LyricsPanelProps {
  events: MelodyEvent[];
  /** Syllables of the chart section with this label; `[]` if there is none. */
  chartSyllables: string[];
  /** Event index of the selected note, from the staff (null = none). */
  selectedNote: number | null;
  /** Label of the melody section being edited, for hint text. */
  sectionLabel: string;
  /**
   * Called exactly once per action; skipped when an op is a no-op.
   * `action` says which one (for the editor's status announcement).
   */
  onChange: (events: MelodyEvent[], action: LyricsAction) => void;
  /** True when the part uses one whole-part `\lyrics` line (T14's target). */
  partLevelLyrics?: boolean;
  onConvertPartLyrics?: () => void;
}

export type LyricsAction = 'import' | 'extend' | 'merge' | 'split' | 'noLyric';

interface Op {
  key: Exclude<LyricsAction, 'import'>;
  label: string;
  /**
   * Keyboard shortcut, shown on the button and as `aria-keyshortcuts`. The
   * key itself is handled by MelodyEditor (`LYRIC_KEYS`, on the focused
   * staff), not here. Letters avoid every code bound in melodyInput.ts:
   * note input (A S D F G H J K, W E T Y U), duration (1 2 4 8 6), rest
   * (R), dot (Period), arrows, Enter, Backspace.
   */
  hint: string;
  ariaLabel: string;
  apply: (
    events: MelodyEvent[],
    index: number,
    chart?: readonly string[],
  ) => MelodyEvent[];
}

const OPS: readonly Op[] = [
  {
    key: 'extend',
    label: 'のばす',
    hint: 'N',
    ariaLabel: 'のばす: 選んだ音節を次の音符までのばし、後ろをずらす',
    apply: extend,
  },
  {
    key: 'merge',
    label: 'つめる',
    hint: 'M',
    ariaLabel: 'つめる: 次の音節を選んだ音符にまとめて、後ろをずらす',
    apply: merge,
  },
  {
    key: 'split',
    label: '分ける',
    hint: 'V',
    ariaLabel: '分ける: 選んだ音符の歌詞を2つに分けて、後ろをずらす',
    apply: split,
  },
  {
    key: 'noLyric',
    label: '歌詞なし',
    hint: 'C',
    ariaLabel: '歌詞なし: 選んだ音符の歌詞をなくして、後ろをずらす',
    apply: noLyric,
  },
];

/**
 * Melody editor lyrics panel (T13, docs/m4-plan.md decision 5,
 * docs/m4-decisions.md). Imports a chart section's lyrics onto the notes
 * (`autoAssign`), shows a read-only syllable preview and a notes/syllables
 * counter (`lyricMismatch`), and exposes the four re-flow operations
 * (`extend` / `merge` / `split` / `noLyric`) on the staff's selected note.
 * All buttons are `onMouseDown`-guarded so clicking them never steals
 * keyboard focus from the melody staff.
 */
export function LyricsPanel({
  events,
  chartSyllables,
  selectedNote,
  sectionLabel,
  onChange,
  partLevelLyrics = false,
  onConvertPartLyrics,
}: LyricsPanelProps) {
  const headingId = useId();
  const importRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);

  const noteCount = events.filter((e) => e.kind === 'note').length;
  const { placed, expected } = lyricMismatch(events, chartSyllables);
  const diff = expected - placed;

  const hasChart = chartSyllables.length > 0;
  const hasExistingLyric = events.some(
    (e) => e.kind === 'note' && e.lyric !== undefined,
  );
  const importDisabled = partLevelLyrics || !hasChart || noteCount === 0;

  const selected =
    selectedNote !== null && selectedNote >= 0 && selectedNote < events.length
      ? events[selectedNote]
      : undefined;
  const isRestSelected = selected !== undefined && selected.kind === 'rest';
  const opsDisabled = partLevelLyrics || !selected || isRestSelected;

  const runImport = () => {
    setConfirming(false);
    if (noteCount === 0) return;
    onChange(autoAssign(events, chartSyllables), 'import');
  };

  const handleImportClick = () => {
    if (hasExistingLyric) {
      setConfirming(true);
    } else {
      runImport();
    }
  };

  const runOp = (op: Op) => {
    if (selectedNote === null) return;
    const next = op.apply(events, selectedNote, chartSyllables);
    if (next !== events) onChange(next, op.key);
  };

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        歌詞
      </h3>

      {partLevelLyrics && (
        <div className={styles.notice}>
          <p className={styles.noticeText}>
            このパートは歌詞をまとめて書く形式です。アプリで編集するには音符ごとの歌詞に変換してください
          </p>
          <Button
            variant="primary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onConvertPartLyrics}
          >
            音符ごとの歌詞に変換
          </Button>
        </div>
      )}

      <div className={styles.importRow}>
        <PopoverAnchor>
          <Button
            ref={importRef}
            variant="primary"
            disabled={importDisabled}
            aria-haspopup="dialog"
            aria-expanded={confirming}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleImportClick}
          >
            コード譜から歌詞を取り込む
          </Button>
          <Popover
            open={confirming}
            onClose={() => setConfirming(false)}
            anchorRef={importRef}
            aria-label="歌詞の置き換えの確認"
            className={styles.confirmPopover}
          >
            <p className={styles.confirmText}>
              今の歌詞を置き換えます。よろしいですか？
            </p>
            <div className={styles.confirmActions}>
              <Button
                variant="primary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={runImport}
              >
                置き換える
              </Button>
              <Button
                variant="ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setConfirming(false)}
              >
                キャンセル
              </Button>
            </div>
          </Popover>
        </PopoverAnchor>
        {!partLevelLyrics && !hasChart && (
          <p className={styles.hint}>
            コード譜にセクション {sectionLabel} がありません
          </p>
        )}
        {!partLevelLyrics && hasChart && noteCount === 0 && (
          <p className={styles.hint}>先に音符を入力してください</p>
        )}
      </div>

      {hasChart && (
        <div className={styles.chipsBlock}>
          <p className={styles.groupLabel}>コード譜の音節</p>
          <ul className={styles.chips}>
            {chartSyllables.map((s, i) => (
              <li key={i} className={styles.chip}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Not a live region: MelodyEditor announces changes in its own one. */}
      <div className={styles.counterRow}>
        <p className={styles.counter}>
          音符 {noteCount}・音節 {placed}
          <span className={styles.expected}>（期待 {expected}）</span>
        </p>
        {placed !== expected && (
          <p className={styles.warning}>
            {diff > 0
              ? `音節が${diff}個足りません`
              : `音節が${-diff}個多すぎます`}
          </p>
        )}
      </div>

      <div className={styles.opsGroup} role="group" aria-label="歌詞の操作">
        {OPS.map((op) => (
          <Button
            key={op.key}
            variant="secondary"
            disabled={opsDisabled}
            aria-label={op.ariaLabel}
            aria-keyshortcuts={op.hint}
            className={styles.opButton}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runOp(op)}
          >
            {op.label}
            <span aria-hidden="true" className={styles.mnemonic}>
              {op.hint}
            </span>
          </Button>
        ))}
      </div>
      {!partLevelLyrics && selectedNote === null && (
        <p className={styles.hint}>音符を選んでください</p>
      )}
      {!partLevelLyrics && isRestSelected && (
        <p className={styles.hint}>休符には歌詞を付けられません</p>
      )}
    </section>
  );
}
