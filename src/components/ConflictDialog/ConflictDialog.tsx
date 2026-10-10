import { useState } from 'react';
import type { ConflictChoice } from '../../lib/syncTypes';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import { formatWhen } from '../Dialog/formatWhen';
import styles from './ConflictDialog.module.css';

export type ConflictDialogProps = {
  open: boolean;
  songTitle: string;
  /** The version now on Drive. */
  drive: { modifiedTime: string; device?: string };
  /** The version on this screen. */
  local: {
    /** Draft time (RFC 3339 / ISO). */
    editedAt: string;
    device: string;
    /** modifiedTime of the Drive version this edit started from. */
    baseModifiedTime?: string;
  };
  /** Number of differing lines (shown only when given and > 0). */
  changedLines?: number;
  onChoose: (choice: ConflictChoice) => void;
  /** Cancel button and Esc: do nothing, stay unsaved (disabled while busy). */
  onCancel: () => void;
  busy?: boolean;
  /** For tests / stories. */
  now?: Date;
};

const CHOICES: {
  id: ConflictChoice;
  title: string;
  desc: string;
  action: string;
}[] = [
  {
    id: 'overwrite',
    title: '上書きする',
    desc: 'この画面の版で Drive を置き換えます。Drive にある新しい変更は消えます。',
    action: '上書きして保存',
  },
  {
    id: 'reloadKeepCopy',
    title: 'Drive の方を読み直す（手元の変更は別の曲として残す）',
    desc: 'Drive の最新を開きます。いまの手元の変更は「<曲名>（手元の版 …）」という別の曲として Drive に保存します。',
    action: '読み直す',
  },
  {
    id: 'reloadDiscard',
    title: 'Drive の方を読み直す（手元の変更は捨てる）',
    desc: 'Drive の最新を開きます。手元の変更は消えます。下書きも破棄します。',
    action: '読み直して破棄',
  },
];

export function ConflictDialog({
  open,
  songTitle,
  drive,
  local,
  changedLines,
  onChoose,
  onCancel,
  busy = false,
  now,
}: ConflictDialogProps) {
  const [choice, setChoice] = useState<ConflictChoice>('reloadKeepCopy');
  const current = CHOICES.find((c) => c.id === choice) ?? CHOICES[1];
  const driveWhen = formatWhen(drive.modifiedTime, now);
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Drive の方が新しくなっています"
      icon={<WarnIcon />}
      description={`「${songTitle}」は、この画面の版のもとにした Drive の版のあとに、別の端末で保存されました。このまま保存すると、そちらの変更が消えます。`}
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onChoose(choice)}
          >
            {current.action}
          </Button>
        </>
      }
    >
      <div className={styles.versions}>
        <section className={styles.version} aria-label="Drive の版">
          <div className={styles.versionLabel}>Drive の版</div>
          <div className={styles.versionMain}>
            {driveWhen}
            {drive.device ? ` ・ ${drive.device}` : ''}
          </div>
          {changedLines !== undefined && changedLines > 0 ? (
            <div className={styles.versionSub}>
              変更の目安: {changedLines} 行が違います
            </div>
          ) : null}
        </section>
        <section
          className={`${styles.version} ${styles.local}`}
          aria-label="この画面の版"
        >
          <div className={styles.versionLabel}>この画面の版（手元の変更）</div>
          <div className={styles.versionMain}>
            {formatWhen(local.editedAt, now)} まで編集 ・ {local.device}
          </div>
          {local.baseModifiedTime ? (
            <div className={styles.versionSub}>
              元にした Drive の版は {formatWhen(local.baseModifiedTime, now)}{' '}
              保存のもの
            </div>
          ) : null}
        </section>
      </div>
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>どうしますか</legend>
        {CHOICES.map((c) => (
          <label
            key={c.id}
            className={`${styles.choice} ${choice === c.id ? styles.selected : ''}`}
          >
            <input
              type="radio"
              name="conflict-choice"
              className={styles.radio}
              checked={choice === c.id}
              onChange={() => setChoice(c.id)}
            />
            <span>
              <span className={styles.choiceTitle}>{c.title}</span>
              <span className={styles.choiceDesc}>{c.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

function WarnIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M12 8v5M12 16.5v.5" />
      <path d="M10.3 3.9L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}
