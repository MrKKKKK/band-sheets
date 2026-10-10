import { useId, useRef, useState, type FormEvent } from 'react';
import {
  metaSummary,
  validateMeta,
  type MetaField,
  type MetaInput,
} from '../../lib/meta';
import type { SongMeta } from '../../lib/song';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './SongInfoPopover.module.css';

export type SongInfoPopoverProps = {
  meta: SongMeta;
  /** Called once per 適用 with the whole meta (other fields preserved). */
  onChange: (meta: SongMeta) => void;
};

const FIELDS: { field: MetaField; label: string; placeholder?: string }[] = [
  { field: 'title', label: '曲名' },
  { field: 'key', label: 'キー', placeholder: 'C, F#m, Bb…' },
  { field: 'tempo', label: 'テンポ', placeholder: '120' },
  { field: 'time', label: '拍子', placeholder: '4/4' },
];

function toInput(meta: SongMeta): MetaInput {
  return {
    title: meta.title,
    key: meta.key ?? '',
    tempo: meta.tempo === undefined ? '' : String(meta.tempo),
    time: meta.time ?? '',
  };
}

/** Trigger button + popover form for title / key / tempo / time. */
export function SongInfoPopover({ meta, onChange }: SongInfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MetaInput>(() => toInput(meta));
  const [errors, setErrors] = useState<Partial<Record<MetaField, string>>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();

  const show = () => {
    setDraft(toInput(meta));
    setErrors({});
    setOpen(true);
  };
  const close = () => setOpen(false);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    // N8: original meta (as the form opened with) lets validateMeta skip
    // the strict format/range check for any field the user left untouched
    // — e.g. an out-of-range {tempo: 0} loaded from a file must not block
    // saving the OTHER fields just because the user never touched tempo.
    const result = validateMeta(draft, toInput(meta));
    if (!result.ok) {
      setErrors(result.errors);
      const first = FIELDS.find(({ field }) => result.errors[field]);
      if (first)
        formRef.current
          ?.querySelector<HTMLInputElement>(`#${CSS.escape(id + first.field)}`)
          ?.focus();
      return;
    }
    // Replace the four form fields (empty ones are removed), keep the rest
    // (palette and anything added later) untouched.
    const { key: _key, tempo: _tempo, time: _time, ...rest } = meta;
    onChange({ ...rest, ...result.meta });
    close();
  };

  return (
    <PopoverAnchor>
      <Button
        ref={triggerRef}
        variant="secondary"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
      >
        {metaSummary(meta)}
      </Button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        aria-labelledby={`${id}heading`}
      >
        <h2 id={`${id}heading`} className={styles.heading}>
          曲情報
        </h2>
        <form ref={formRef} className={styles.form} onSubmit={apply} noValidate>
          {FIELDS.map(({ field, label, placeholder }) => {
            const inputId = id + field;
            const errorId = `${inputId}-error`;
            const error = errors[field];
            return (
              <div key={field} className={styles.field}>
                <label htmlFor={inputId} className={styles.label}>
                  {label}
                </label>
                <input
                  id={inputId}
                  className={styles.input}
                  value={draft[field]}
                  placeholder={placeholder}
                  inputMode={field === 'tempo' ? 'decimal' : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [field]: e.target.value }))
                  }
                />
                {error && (
                  <p id={errorId} className={styles.error}>
                    {error}
                  </p>
                )}
              </div>
            );
          })}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={close}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary">
              適用
            </Button>
          </div>
        </form>
      </Popover>
    </PopoverAnchor>
  );
}
