import type { ReactNode } from 'react';
import { Button } from '../Button/Button';
import styles from './ImportFrame.module.css';

export type ImportFrameProps = {
  /** The back button's text, e.g. 「‹ 曲の一覧」. */
  backLabel: string;
  onBack: () => void;
  /** Muted text at the right end of the header. */
  note: string;
  /** Extra class for the note (a screen's own tweak). */
  noteClassName?: string;
  children: ReactNode;
};

/**
 * The page + header shared by the import screens (S1 / S3): back button, brand and a
 * muted note. The page heading (`h1`) is the content's; it takes the `h1` class of
 * ImportFrame.module.css (CSS Modules `composes`).
 */
export function ImportFrame({
  backLabel,
  onBack,
  note,
  noteClassName,
  children,
}: ImportFrameProps) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Button variant="ghost" className={styles.back} onClick={onBack}>
          {backLabel}
        </Button>
        <p className={styles.brand}>band-sheets</p>
        <span className={styles.spacer} />
        <span
          className={
            noteClassName ? `${styles.muted} ${noteClassName}` : styles.muted
          }
        >
          {note}
        </span>
      </header>
      {children}
    </div>
  );
}
