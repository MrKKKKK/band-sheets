import styles from './ConnectionBanner.module.css';

export type ConnectionBannerProps = {
  /**
   * offline: no connection to Drive; reconnect: the login expired (needs a
   * user gesture to renew); unconfigured: no OAuth client id (local only).
   */
  kind: 'offline' | 'reconnect' | 'unconfigured';
  /** offline only: when the list shown was loaded (ISO). */
  listedAt?: string;
  /** Retry / reconnect. The button is hidden for `unconfigured`. */
  onRetry?: () => void;
  /** true while a retry is in progress: the button is disabled. */
  retrying?: boolean;
};

/** 'M/D HH:MM' in local time; '' when missing or invalid. */
function stamp(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${mm}`;
}

function content(
  kind: ConnectionBannerProps['kind'],
  listedAt: string | undefined,
) {
  switch (kind) {
    case 'offline': {
      const t = stamp(listedAt);
      return {
        head: 'Drive につながりません。',
        body: `${t ? `前回読み込んだ一覧（${t} 時点）を表示しています。` : ''}開いて編集はできますが、保存はつながってからになります。`,
        button: 'もう一度つなぐ',
      };
    }
    case 'reconnect':
      return {
        head: 'Drive への接続の期限が切れました。',
        body: '前回読み込んだ内容を表示しています。この端末の下書きは残っています。再接続すると保存や更新ができます。',
        button: 'Drive に再接続',
      };
    case 'unconfigured':
      return {
        head: 'Drive は設定されていません。',
        body: 'この端末だけで使えます（設定は docs/m7-google-setup.md）。',
        button: null,
      };
  }
}

/** Full-width notice under the top bar about the Drive connection. */
export function ConnectionBanner({
  kind,
  listedAt,
  onRetry,
  retrying = false,
}: ConnectionBannerProps) {
  const c = content(kind, listedAt);
  return (
    <div
      className={styles.banner}
      role="status"
      data-testid="connection-banner"
      data-kind={kind}
    >
      <svg
        className={styles.icon}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16.5v.5" />
      </svg>
      <p className={styles.message}>
        <b>{c.head}</b>
        {c.body}
      </p>
      {c.button && onRetry && (
        <button
          type="button"
          className={styles.button}
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? '接続中…' : c.button}
        </button>
      )}
    </div>
  );
}
