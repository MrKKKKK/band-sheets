import { useId, useState, type FormEvent } from 'react';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import styles from './RenameDialog.module.css';

export type RenameDialogProps = {
  open: boolean;
  initialTitle: string;
  /** Called with the trimmed, non-empty title. */
  onSubmit: (title: string) => void;
  onCancel: () => void;
  busy?: boolean;
};

export function RenameDialog({
  open,
  initialTitle,
  onSubmit,
  onCancel,
  busy = false,
}: RenameDialogProps) {
  // Remount the body per open so the field restarts from initialTitle.
  return (
    <Dialog open={open} onClose={onCancel} title="曲名を変える" size="sm">
      <RenameForm
        initialTitle={initialTitle}
        onSubmit={onSubmit}
        onCancel={onCancel}
        busy={busy}
      />
    </Dialog>
  );
}

function RenameForm({
  initialTitle,
  onSubmit,
  onCancel,
  busy,
}: Omit<RenameDialogProps, 'open'> & { busy: boolean }) {
  const [value, setValue] = useState(initialTitle);
  const id = useId();
  const trimmed = value.trim();
  const empty = trimmed === '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!empty && !busy) onSubmit(trimmed);
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <label htmlFor={id} className={styles.label}>
        曲名
      </label>
      <input
        id={id}
        className={styles.input}
        value={value}
        autoComplete="off"
        aria-invalid={empty}
        aria-describedby={empty ? `${id}-err` : undefined}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
      {empty ? (
        <p id={`${id}-err`} className={styles.error} role="alert">
          曲名を入力してください
        </p>
      ) : null}
      <div className={styles.footer}>
        <Button onClick={onCancel}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={empty || busy}>
          変更する
        </Button>
      </div>
    </form>
  );
}
