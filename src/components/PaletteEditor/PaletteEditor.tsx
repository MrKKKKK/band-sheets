import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { isValidChordText } from '../../lib/chordText';
import {
  addToPalette,
  paletteGroups,
  removeFromPalette,
} from '../../lib/palette';
import type { Song } from '../../lib/song';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './PaletteEditor.module.css';

export type PaletteEditorProps = {
  song: Song;
  onChange: (song: Song) => void;
};

const INVALID_MESSAGE = '空白や [ ] { } は使えません';
const DUPLICATE_MESSAGE = 'すでにパレットにあります';

/** Keep in sync with PaletteEditor.module.css `.popover`'s `width`/margin. */
const POPOVER_WIDTH = 340;
const EDGE_MARGIN = 16; // var(--space-4)

/**
 * 「＋」 button that opens a popover for managing the song's palette:
 * remove user-added chords, view the automatic groups (used / diatonic),
 * and add a chord by free text. Each add/remove → one onChange.
 */
export function PaletteEditor({ song, onChange }: PaletteEditorProps) {
  const [open, setOpen] = useState(false);
  /** Left offset (px, relative to the anchor) that keeps the popover on
   * screen; computed from the anchor's position *before* it opens (R6), so
   * it never renders in an overflowing position in the first place — see
   * ChordPopover's `--chord-popover-left` for the same idea. */
  const [popoverLeft, setPopoverLeft] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const userListRef = useRef<HTMLUListElement>(null);
  /** Index of the removed chip, to move focus after the list re-renders. */
  const removedIndex = useRef<number | null>(null);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();

  const { user, used, diatonic } = paletteGroups(song);

  // Runs after Popover's own open effect (child effects run first), so the
  // text input wins over "first focusable" (which would be a remove button).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // After a remove, keep keyboard users in place: next remove button, else
  // the previous one, else the input.
  useEffect(() => {
    const i = removedIndex.current;
    if (i === null) return;
    removedIndex.current = null;
    const buttons =
      userListRef.current?.querySelectorAll<HTMLButtonElement>('button');
    const target = buttons?.[Math.min(i, buttons.length - 1)];
    (target ?? inputRef.current)?.focus();
  }, [user.length]);

  const openEditor = () => {
    const anchor = anchorRef.current;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      // The popover itself may shrink to fit (module CSS max-width), so
      // clamp against the same width that will actually render.
      const width = Math.min(
        POPOVER_WIDTH,
        window.innerWidth - 2 * EDGE_MARGIN,
      );
      const maxLeft = Math.max(
        EDGE_MARGIN,
        window.innerWidth - EDGE_MARGIN - width,
      );
      const desiredLeft = Math.min(Math.max(rect.left, EDGE_MARGIN), maxLeft);
      setPopoverLeft(Math.round(desiredLeft - rect.left));
    }
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setText('');
    setError(null);
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const chord = text.trim();
    if (chord === '') return;
    if (!isValidChordText(chord)) {
      setError(INVALID_MESSAGE);
    } else if (user.includes(chord)) {
      setError(DUPLICATE_MESSAGE);
    } else {
      onChange(addToPalette(song, chord));
      setText('');
      setError(null);
    }
    inputRef.current?.focus();
  };

  const remove = (chord: string, index: number) => {
    removedIndex.current = index;
    onChange(removeFromPalette(song, chord));
  };

  return (
    <PopoverAnchor>
      <Button
        ref={anchorRef}
        variant="secondary"
        aria-label="パレットを編集"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openEditor())}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" />
        </svg>
      </Button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        aria-labelledby={titleId}
        className={styles.popover}
        style={
          {
            '--palette-popover-left': `${popoverLeft}px`,
          } as CSSProperties
        }
      >
        <h2 id={titleId} className={styles.title}>
          パレットを編集
        </h2>

        <section className={styles.group}>
          <h3 className={styles.label}>追加したコード（曲ファイルに保存）</h3>
          {user.length === 0 ? (
            <p className={styles.empty}>まだありません</p>
          ) : (
            <ul ref={userListRef} className={styles.chips}>
              {user.map((chord, i) => (
                <li key={chord} className={styles.userChip}>
                  <span className={styles.chordText}>{chord}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`${chord} をパレットから外す`}
                    onClick={() => remove(chord, i)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 3l8 8M11 3l-8 8"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {used.length > 0 && (
          <ReadOnlyGroup label="この曲で使用中（自動）" chords={used} />
        )}
        {diatonic.length > 0 && (
          <ReadOnlyGroup
            label={`キー ${song.meta.key} のダイアトニック（自動）`}
            chords={diatonic}
          />
        )}

        <form className={styles.addForm} onSubmit={add} noValidate>
          <label htmlFor={inputId} className={styles.inputLabel}>
            コードを追加
          </label>
          <div className={styles.addRow}>
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
              placeholder="例: C7(9,13)"
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
            />
            <Button type="submit" variant="primary">
              追加
            </Button>
          </div>
          {error !== null && (
            <p id={errorId} className={styles.error} role="alert">
              {error}
            </p>
          )}
        </form>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={close}>
            閉じる
          </Button>
        </div>
      </Popover>
    </PopoverAnchor>
  );
}

function ReadOnlyGroup({ label, chords }: { label: string; chords: string[] }) {
  return (
    <section className={styles.group}>
      <h3 className={styles.label}>{label}</h3>
      <ul className={styles.chips}>
        {chords.map((chord) => (
          <li key={chord} className={styles.readOnlyChip}>
            {chord}
          </li>
        ))}
      </ul>
    </section>
  );
}
