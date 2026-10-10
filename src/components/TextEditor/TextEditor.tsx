import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
} from 'react';
import { nextSectionLabel } from '../../lib/lyrics';
import { paletteGroups } from '../../lib/palette';
import { parseSong } from '../../lib/parseSong';
import { serializeSong } from '../../lib/serializeSong';
import { insertAt, insertSection, type TextEdit } from '../../lib/textEdit';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { ChartPreview } from '../ChartPreview/ChartPreview';
import { PaletteEditor } from '../PaletteEditor/PaletteEditor';
import styles from './TextEditor.module.css';

export type TextEditorProps = {
  /** ChordPro text; the single source of truth (docs/m3-plan.md, 1). */
  text: string;
  onTextChange: (text: string) => void;
};

/** Keeps the textarea focused when a helper is clicked with the mouse. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * The exact inserted slice for a pure-insertion `TextEdit` (`insertedAt`
 * set), by its known position and the old/new length difference — not by
 * diffing old vs. new text. Diffing looked simpler but is ambiguous
 * whenever the inserted content shares a character with what follows it
 * (e.g. `[G]` inserted right before an existing `[F]`, or a block ending in
 * `\n` inserted right before an existing blank line): a prefix/suffix scan
 * can match a char or two into the wrong side and silently pick the wrong
 * split point, even though the *resulting* full text still happens to
 * look right. `insertedAt` sidesteps that: the lib functions already know
 * precisely where they spliced.
 */
function insertedSlice(
  oldText: string,
  result: TextEdit,
): { pos: number; inserted: string } | null {
  if (result.insertedAt === undefined) return null;
  const pos = result.insertedAt;
  const inserted = result.text.slice(
    pos,
    pos + (result.text.length - oldText.length),
  );
  return { pos, inserted };
}

/**
 * Editor B 「テキスト入力」: the raw ChordPro text in a textarea (never
 * reformatted while typing) with a live preview, plus helpers that edit the
 * text at the caret (section block, palette chord) and the palette editor.
 */
export function TextEditor({ text, onTextChange }: TextEditorProps) {
  const song = useMemo(() => parseSong(text), [text]);
  const { all } = paletteGroups(song);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Caret to restore once the parent re-renders with the helper's text. */
  const pendingCaret = useRef<number | null>(null);
  const textareaId = useId();
  const previewId = useId();
  const chipsId = useId();

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = textareaRef.current;
    if (caret === null || el === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [text]);

  /** A textarea keeps selectionStart/End after blur, so read them live. */
  const selection = () => {
    const el = textareaRef.current;
    return el
      ? { start: el.selectionStart, end: el.selectionEnd }
      : { start: text.length, end: text.length };
  };

  const apply = (edit: TextEdit) => {
    pendingCaret.current = edit.caret;
    onTextChange(edit.text);
  };

  /**
   * R10: lets a chip / helper edit join the browser's own undo stack
   * (Ctrl+Z) like typing would, instead of `apply` — which sets the
   * textarea's `value` straight from React and starts a fresh undo entry,
   * losing whatever was there. `result` must be a pure insertion (its
   * `insertedAt` set); this replays just that insertion through
   * `document.execCommand('insertText')` (still supported in Chromium/
   * Firefox) so the textarea's own input handling creates the undo step
   * and fires the one native `input` event React's onChange already
   * listens for — `apply` only runs as a fallback when there's no element
   * to edit natively, or the edit wasn't a pure insertion.
   */
  const applyAsInsertion = (oldText: string, result: TextEdit) => {
    const el = textareaRef.current;
    const found = el && insertedSlice(oldText, result);
    if (!el || !found) {
      apply(result);
      return;
    }
    el.focus();
    el.setSelectionRange(found.pos, found.pos);
    let handled = false;
    if (typeof document.execCommand === 'function') {
      try {
        handled = document.execCommand('insertText', false, found.inserted);
      } catch {
        handled = false;
      }
    }
    if (!handled) {
      el.setRangeText(found.inserted, found.pos, found.pos, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // The native `input` event above already ran onChange → onTextChange
    // with the browser's own post-insertion value. Its caret always lands
    // at the very end of what was just inserted, which is right for a chip
    // (the caret belongs right after `[chord]`) but not for a multi-line
    // block (`result.caret` can point *inside* it, e.g. the blank line
    // between a new section's start/end directives) — nudge it there.
    // `setSelectionRange` alone doesn't fire another input/change event.
    el.setSelectionRange(result.caret, result.caret);
  };

  const addSection = () => {
    const used = song.chart.map((s) => s.label).filter((l) => l !== '');
    applyAsInsertion(
      text,
      insertSection(text, selection().start, nextSectionLabel(used)),
    );
  };

  const insertChord = (chord: string) => {
    const { start, end } = selection();
    applyAsInsertion(
      text,
      insertAt(text, start, end, `[${chord}]`, { mode: 'insert' }),
    );
  };

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <Button
          variant="secondary"
          onMouseDown={keepFocus}
          onClick={addSection}
        >
          ＋セクション
        </Button>
        <span className={styles.divider} aria-hidden="true" />
        <span id={chipsId} className={styles.chipsLabel}>
          コード
        </span>
        <div role="group" aria-labelledby={chipsId} className={styles.chips}>
          {all.map((chord) => (
            <Chip
              key={chord}
              onMouseDown={keepFocus}
              onClick={() => insertChord(chord)}
            >
              {chord}
            </Chip>
          ))}
          <PaletteEditor
            song={song}
            onChange={(next) => onTextChange(serializeSong(next))}
          />
        </div>
      </div>

      <div className={styles.columns}>
        <div className={styles.column}>
          <label htmlFor={textareaId} className={styles.columnLabel}>
            ChordPro テキスト
          </label>
          <textarea
            ref={textareaRef}
            id={textareaId}
            className={styles.textarea}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
        <section className={styles.column} aria-labelledby={previewId}>
          <h2 id={previewId} className={styles.columnLabel}>
            プレビュー
          </h2>
          <div className={styles.preview}>
            <ChartPreview song={song} />
          </div>
        </section>
      </div>
    </div>
  );
}
