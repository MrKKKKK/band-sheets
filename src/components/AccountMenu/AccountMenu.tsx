import { useRef, useState } from 'react';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './AccountMenu.module.css';

export type AccountMenuProps = {
  signedIn: boolean;
  /** Shown in the menu; its first character is the avatar. Optional. */
  accountName?: string;
  onSignIn: () => void;
  onSignOut: () => void;
  /** true while a login is in progress: the button is disabled. */
  busy?: boolean;
  /** false: no Drive client id; shows a muted note instead of a button. */
  configured?: boolean;
};

/** Top-bar account control: 「ログイン」 or the avatar + 「ログアウト」 menu. */
export function AccountMenu({
  signedIn,
  accountName,
  onSignIn,
  onSignOut,
  busy = false,
  configured = true,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (!configured && !signedIn) {
    return (
      <span className={styles.note} data-testid="account-menu">
        Drive 未設定
      </span>
    );
  }
  if (!signedIn) {
    return (
      <span data-testid="account-menu">
        <Button variant="secondary" onClick={onSignIn} disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </Button>
      </span>
    );
  }
  const initial = accountName ? Array.from(accountName)[0] : '';
  return (
    <span data-testid="account-menu">
      <PopoverAnchor>
        <button
          ref={anchorRef}
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          ログイン中
        </button>
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          align="end"
          aria-label="アカウント"
        >
          <div className={styles.menu}>
            {accountName && <p className={styles.name}>{accountName}</p>}
            <p className={styles.hint}>
              ログアウトしても、この端末の下書きは残ります。
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              ログアウト
            </Button>
          </div>
        </Popover>
      </PopoverAnchor>
    </span>
  );
}
