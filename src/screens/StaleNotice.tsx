/**
 * 「前回読み込んだ版です」 + 「Drive に再接続」 (docs/m7-review.md R2): shown
 * on the editor and the viewer while the song is this device's cached copy
 * and Drive could not be checked (sign-in expired, or offline).
 * `onReconnect` must call `ensureToken()` synchronously (it is the click).
 */

import { Button } from '../components/Button/Button';
import type { FailReason } from '../hooks/useDriveSession';
import styles from './StaleNotice.module.css';

export type StaleNoticeProps = {
  onReconnect: () => void;
  busy?: boolean;
  error?: FailReason | null;
  /** Nothing cached to show (viewer placeholder). */
  nothingCached?: boolean;
};

const ERROR: Record<FailReason, string> = {
  network: '通信できませんでした。通信を確認して、もう一度お試しください。',
  auth: 'ログインできませんでした。もう一度お試しください。',
  other: '再接続できませんでした。もう一度お試しください。',
};

export function StaleNotice({
  onReconnect,
  busy = false,
  error = null,
  nothingCached = false,
}: StaleNoticeProps) {
  return (
    <div className={styles.notice} data-testid="stale-notice">
      <p className={styles.text} role="status">
        {nothingCached
          ? 'Drive に再接続すると開けます。'
          : '前回読み込んだ版です（Drive の最新かどうか確認できていません）。'}
        {error && <span className={styles.error}> {ERROR[error]}</span>}
      </p>
      <Button disabled={busy} onClick={onReconnect}>
        {busy ? '接続中…' : 'Drive に再接続'}
      </Button>
    </div>
  );
}
