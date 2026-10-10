import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { RefObject } from 'react';
import { isValidChordText } from '../../lib/chordText';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { Popover } from '../Popover/Popover';
import styles from './ChordPopover.module.css';

export type ChordPopoverProps = {
  open: boolean;
  /** Element the popover belongs to (focus returns here on close). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Existing chord being edited; omit to place a new chord. */
  initialChord?: string;
  /** User-added + used chords (paletteGroups(song).all minus diatonic). */
  palette: string[];
  diatonic: string[];
  keyLabel?: string;
  onCommit: (chord: string) => void;
  /** Shows 「削除」; pass only when editing an existing chord. */
  onDelete?: () => void;
  onClose: () => void;
  className?: string;
};

const INVALID_MESSAGE = '空白や [ ] { } は使えません';
const EMPTY_MESSAGE = 'コードを入力してください';

/**
 * Small dialog for placing / changing / deleting one chord: free-text input
 * plus palette and diatonic chips (one click = one onCommit). Positioning is
 * the caller's job (Popover sits below its `position: relative` parent).
 */
export function ChordPopover({
  open,
  anchorRef,
  onClose,
  className,
  ...rest
}: ChordPopoverProps) {
  const editing = rest.initialChord !== undefined;
  const titleId = useId();
  const cls = [styles.popover, className].filter(Boolean).join(' ');
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      aria-labelledby={titleId}
      className={cls}
    >
      {/* Mounted only while open, so the input state resets on each open. */}
      <ChordForm titleId={titleId} editing={editing} {...rest} />
    </Popover>
  );
}

function ChordForm({
  titleId,
  editing,
  initialChord,
  palette,
  diatonic,
  keyLabel,
  onCommit,
  onDelete,
}: Omit<ChordPopoverProps, 'open' | 'anchorRef' | 'onClose' | 'className'> & {
  titleId: string;
  editing: boolean;
}) {
  const [text, setText] = useState(initialChord ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  // Child effects run before Popover's open effect, which then focuses the
  // first focusable element — this input — again, keeping the selection.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const chord = text.trim();
    if (chord === '') setError(EMPTY_MESSAGE);
    else if (!isValidChordText(chord)) setError(INVALID_MESSAGE);
    else {
      onCommit(chord);
      return;
    }
    inputRef.current?.focus();
  };

  return (
    <>
      <h2 id={titleId} className={styles.title}>
        {editing ? 'コードを変更' : 'コードを置く'}
      </h2>
      <form className={styles.form} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className={styles.inputLabel}>
          コード
        </label>
        <div className={styles.inputRow}>
          <input
            ref={inputRef}
            id={inputId}
            className={styles.input}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="例: Am7"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
          />
          <Button type="submit" variant="primary">
            {editing ? '変更' : '置く'}
          </Button>
        </div>
        {error !== null && (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>

      {palette.length > 0 && (
        <ChipGroup
          label="この曲のパレット"
          chords={palette}
          onPick={onCommit}
        />
      )}
      {diatonic.length > 0 && (
        <ChipGroup
          label={
            keyLabel ? `キー ${keyLabel} のダイアトニック` : 'ダイアトニック'
          }
          chords={diatonic}
          onPick={onCommit}
        />
      )}

      {onDelete && (
        <div className={styles.footer}>
          <Button variant="danger" onClick={onDelete}>
            削除
          </Button>
        </div>
      )}
    </>
  );
}

function ChipGroup({
  label,
  chords,
  onPick,
}: {
  label: string;
  chords: string[];
  onPick: (chord: string) => void;
}) {
  const labelId = useId();
  return (
    <section className={styles.group} aria-labelledby={labelId}>
      <h3 id={labelId} className={styles.label}>
        {label}
      </h3>
      <ul className={styles.chips}>
        {chords.map((chord) => (
          <li key={chord}>
            <Chip onClick={() => onPick(chord)}>{chord}</Chip>
          </li>
        ))}
      </ul>
    </section>
  );
}
