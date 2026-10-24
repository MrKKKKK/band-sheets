import { useId, useRef, useState } from 'react';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './DashHelp.module.css';

/**
 * 「? 書き方」: a button opening a small popover that explains the dash
 * notation for chord-only lines (docs/audio-integration-plan.md §3.6). One
 * shared component for the review screen (S3) and the text editor (B).
 * Esc / outside click closes it; focus returns to the button (Popover).
 */
export function DashHelp({ align = 'end' }: { align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <PopoverAnchor>
      <Button
        ref={anchorRef}
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ? 書き方
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        align={align}
        aria-labelledby={titleId}
        className={styles.popover}
      >
        <div className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            コードだけの行の書き方
          </h2>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            閉じる
          </Button>
        </div>
        <p className={styles.example} data-testid="dash-help-example">
          |[C]--------|[C]----[F]----|
        </p>
        <dl className={styles.list}>
          <dt className={styles.mono}>[C]</dt>
          <dd>コード名は [ ] で囲む。[N.C.] はコードなし</dd>
          <dt className={styles.mono}>-</dt>
          <dd>八分音符 1 つぶん。4/4 は 1 小節に 8 個</dd>
          <dt className={styles.mono}>=</dt>
          <dd>十六分音符 1 つぶん（- の半分）</dd>
          <dt className={styles.mono}>|</dt>
          <dd>小節の区切り</dd>
        </dl>
        <p className={styles.note}>
          数えるのは「-」と「=」だけです（コード名は長さに入りません）。
        </p>
        <p className={styles.note}>
          「-」を 1 つも書かない小節は、コードで等分します。
        </p>
        <p className={`${styles.note} ${styles.warn}`}>
          <strong>記号は半角で書いてください。</strong>
          全角の「｜ ー －」は、コードの長さとして読めません。
        </p>
      </Popover>
    </PopoverAnchor>
  );
}
