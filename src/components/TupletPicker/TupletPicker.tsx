import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isValidTupletN, TUPLET_PRESETS } from '../../lib/tuplet';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './TupletPicker.module.css';

export interface TupletPickerProps {
  /**
   * Inserts an n-tuplet of rests at the input cursor. The caller decides
   * whether the position is valid (inside another group, crossing a
   * barline, …) and reports that separately (live region / error banner);
   * this component only reports which n the user picked.
   */
  onInsert: (n: number) => void;
  /** Removes the tuplet group at the cursor/selection. */
  onRemove: () => void;
  /** Whether the cursor/selection is currently inside a tuplet group. */
  canRemove: boolean;
  /** Disables the trigger button entirely (e.g. a read-only section). */
  disabled?: boolean;
  /**
   * Called right after `onInsert`/`onRemove`, synchronously in the same
   * click handler, so the caller can move focus to the staff before this
   * popover unmounts and Popover's own cleanup would otherwise return focus
   * to the trigger button instead.
   */
  onDone: () => void;
}

/**
 * 「連符」button + popover (M5 T8): 3 / 5 / 6 / 7 presets, その他 for any
 * other valid n (`isValidTupletN`, 3–15 except 4 and 8), and 連符を削除.
 * Shared by the melody and drum editors. Every button inside the popover is
 * `onMouseDown`-guarded like `DurationBar`/`PianoKeyboard`, so choosing a
 * value never steals keyboard focus by itself — the caller's `onDone`
 * decides where focus goes next (normally back to the staff).
 */
export function TupletPicker({
  onInsert,
  onRemove,
  canRemove,
  disabled,
  onDone,
}: TupletPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = () => setOpen(false);
  const finish = () => {
    setOpen(false);
    onDone();
  };

  return (
    <PopoverAnchor>
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        連符
      </Button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        aria-labelledby={titleId}
        className={styles.popover}
      >
        {/* Mounted only while open, so its draft input resets each time. */}
        <TupletForm
          titleId={titleId}
          canRemove={canRemove}
          onInsert={(n) => {
            onInsert(n);
            finish();
          }}
          onRemove={() => {
            onRemove();
            finish();
          }}
        />
      </Popover>
    </PopoverAnchor>
  );
}

function describeOtherInput(raw: string): { n: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { error: '数を入力してください' };
  if (!/^\d+$/.test(trimmed)) {
    return { error: '半角の数字で入力してください' };
  }
  const n = Number(trimmed);
  if (!isValidTupletN(n)) {
    return { error: `${n} 連符は扱えません（3〜15、4 と 8 を除く）` };
  }
  return { n };
}

function TupletForm({
  titleId,
  canRemove,
  onInsert,
  onRemove,
}: {
  titleId: string;
  canRemove: boolean;
  onInsert: (n: number) => void;
  onRemove: () => void;
}) {
  const [showOther, setShowOther] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    if (showOther) inputRef.current?.focus();
  }, [showOther]);

  const submitOther = (e: FormEvent) => {
    e.preventDefault();
    const result = describeOtherInput(value);
    if ('error' in result) {
      setError(result.error);
      inputRef.current?.focus();
      return;
    }
    onInsert(result.n);
  };

  return (
    <>
      <h2 id={titleId} className={styles.title}>
        連符
      </h2>
      <div role="group" aria-label="連符の数" className={styles.presets}>
        {TUPLET_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            className={styles.preset}
            aria-label={`${n}連符`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(n)}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          className={styles.preset}
          aria-pressed={showOther}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowOther((s) => !s)}
        >
          その他
        </button>
      </div>
      {showOther && (
        <form className={styles.otherForm} onSubmit={submitOther} noValidate>
          <label htmlFor={inputId} className={styles.label}>
            連符の数（3〜15、4・8を除く）
          </label>
          <div className={styles.otherRow}>
            <input
              ref={inputRef}
              id={inputId}
              className={styles.input}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
            />
            <Button
              type="submit"
              variant="primary"
              onMouseDown={(e) => e.preventDefault()}
            >
              挿入
            </Button>
          </div>
          {error !== null && (
            <p id={errorId} role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      )}
      <div className={styles.footer}>
        <Button
          variant="danger"
          disabled={!canRemove}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
        >
          連符を削除
        </Button>
      </div>
    </>
  );
}
