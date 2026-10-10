import { useId, useMemo, useRef, useState } from 'react';
import type { SongEntry, SongStatus, SortOrder } from '../../lib/syncTypes';
import { filterSongs, formatModified, sortSongs } from '../../lib/songIndex';
import { AccountMenu } from '../AccountMenu/AccountMenu';
import { Button } from '../Button/Button';
import {
  ConnectionBanner,
  type ConnectionBannerProps,
} from '../ConnectionBanner/ConnectionBanner';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import { RenameDialog } from '../RenameDialog/RenameDialog';
import styles from './SongList.module.css';

export type SongListProps = {
  songs: readonly SongEntry[];
  /** Per songId. A missing entry is 'synced' with a Drive file, else 'localOnly'. */
  statuses?: Readonly<Record<string, SongStatus>>;

  // Top bar
  signedIn: boolean;
  /** false: no Drive client id (AccountMenu shows 「Drive 未設定」). */
  configured?: boolean;
  accountName?: string;
  onSignIn: () => void;
  onSignOut: () => void;
  /** true while a login is in progress. */
  signingIn?: boolean;
  /** Refresh from Drive; the button is hidden while signed out. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Offline / reconnect / unconfigured notice under the top bar. */
  connection?: ConnectionBannerProps;

  // Actions (the caller owns Drive / navigation)
  onNew: () => void;
  onOpen: (songId: string) => void;
  onOpenView: (songId: string) => void;
  /**
   * Whether 「名前を変える」 is allowed (the library's `canRename`: on Drive
   * with no unsaved changes). Defaults to "status is synced".
   */
  canRename?: (songId: string) => boolean;
  /** Called with the trimmed, non-empty title. Never called when `canRename` is false. */
  onRename: (songId: string, title: string) => void;
  onDuplicate: (songId: string) => void;
  /** After the user confirmed the dialog. */
  onDelete: (songId: string) => void;
  /** Disables the dialogs' action buttons while a request is running. */
  busy?: boolean;

  /** Sort order (controlled when `onOrderChange` + `order` are given). */
  order?: SortOrder;
  onOrderChange?: (order: SortOrder) => void;
  /** For 「今日」/「昨日」 in the modified column (tests). */
  now?: Date;
};

const STATUS_LABEL: Record<SongStatus, string> = {
  synced: '同期済み',
  dirty: '未保存の変更あり',
  driveNewer: 'Drive が新しい',
  localOnly: 'この端末だけ',
};

const ORDER_LABEL: Record<SortOrder, string> = {
  modified: '更新が新しい順',
  title: '曲名順',
};

function modifiedLabel(iso: string, now: Date | undefined): string {
  return formatModified(iso, now ?? new Date());
}

function statusOf(
  s: SongEntry,
  statuses: SongListProps['statuses'],
): SongStatus {
  return statuses?.[s.songId] ?? (s.fileId ? 'synced' : 'localOnly');
}

/** 曲の一覧 (PC). Presentational: data and callbacks via props. */
export function SongList({
  songs,
  statuses,
  signedIn,
  configured = true,
  accountName,
  onSignIn,
  onSignOut,
  signingIn = false,
  onRefresh,
  refreshing = false,
  connection,
  onNew,
  onOpen,
  onOpenView,
  canRename,
  onRename,
  onDuplicate,
  onDelete,
  busy = false,
  order: orderProp,
  onOrderChange,
  now,
}: SongListProps) {
  const [query, setQuery] = useState('');
  const [orderState, setOrderState] = useState<SortOrder>('modified');
  const order = orderProp ?? orderState;
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLButtonElement | null>());
  const searchId = useId();

  const visible = useMemo(
    () => sortSongs(filterSongs(songs, query), order),
    [songs, query, order],
  );
  const dirtyCount = songs.filter((s) => {
    const st = statusOf(s, statuses);
    return st === 'dirty' || st === 'driveNewer';
  }).length;
  const searching = query.trim() !== '';

  const countLabel =
    songs.length === 0
      ? '0 曲'
      : searching
        ? `${visible.length} 曲が見つかりました（全 ${songs.length} 曲）`
        : `${songs.length} 曲${dirtyCount > 0 ? ` ・ ${dirtyCount} 曲は未保存の変更あり` : ''}`;

  const toggleOrder = () => {
    const next: SortOrder = order === 'modified' ? 'title' : 'modified';
    setOrderState(next);
    onOrderChange?.(next);
  };

  const renaming = songs.find((s) => s.songId === renameId);
  const deleting = songs.find((s) => s.songId === deleteId);
  const deletingLocalOnly =
    deleting !== undefined && statusOf(deleting, statuses) === 'localOnly';

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <h1 className={styles.brand}>band-sheets</h1>
        <p className={styles.folder} data-testid="song-list-location">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          {signedIn ? 'マイドライブ / band-sheets' : 'この端末の曲'}
        </p>
        <div className={styles.spacer} />
        {signedIn && onRefresh ? (
          <Button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? '更新中…' : '最新の状態に更新'}
          </Button>
        ) : null}
        <AccountMenu
          signedIn={signedIn}
          accountName={accountName}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          busy={signingIn}
          configured={configured}
        />
      </header>

      {connection ? <ConnectionBanner {...connection} /> : null}

      <main className={styles.main}>
        <div className={styles.toolbar}>
          <h2 className={styles.heading}>曲の一覧</h2>
          <p className={styles.count} role="status" data-testid="song-count">
            {countLabel}
          </p>
          <div className={styles.spacer} />
          <div className={styles.search}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input
              id={searchId}
              type="search"
              aria-label="曲を検索"
              placeholder="曲名で検索"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            onClick={toggleOrder}
            aria-label={`並び順を切り替える（今は${ORDER_LABEL[order]}）`}
            data-testid="sort-toggle"
          >
            並び順: {ORDER_LABEL[order]}
          </Button>
          <Button variant="primary" onClick={onNew}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            新しい曲
          </Button>
        </div>

        {!signedIn && songs.length > 0 ? (
          <p className={styles.note} data-testid="signed-out-note">
            ログインしていません。曲はこの端末だけに保存されています。ログインすると
            Drive に保存して、ほかの端末でも使えます。
          </p>
        ) : null}

        {songs.length === 0 ? (
          <div className={styles.empty} data-testid="song-list-empty">
            <h3>まだ曲がありません</h3>
            <p>
              {signedIn
                ? '「新しい曲」から作ると、Drive の「band-sheets」フォルダに保存されます。ほかの端末で保存した曲は、「最新の状態に更新」で読み込めます。'
                : '「新しい曲」から作ると、この端末に保存されます。ログインすると Drive にも保存できます。'}
            </p>
            <Button variant="primary" onClick={onNew}>
              新しい曲を作る
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.empty} data-testid="song-list-no-match">
            <h3>「{query.trim()}」に合う曲がありません</h3>
            <p>曲名の一部で探せます。</p>
            <Button onClick={() => setQuery('')}>検索をやめる</Button>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">曲名</th>
                <th scope="col">キー・テンポ・拍子</th>
                <th scope="col">最終更新（端末）</th>
                <th scope="col">状態</th>
                <th scope="col">
                  <span className={styles.srOnly}>操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const st = statusOf(s, statuses);
                const renamable = canRename
                  ? canRename(s.songId)
                  : st === 'synced';
                const modified = s.modifiedTime
                  ? modifiedLabel(s.modifiedTime, now)
                  : '';
                return (
                  <tr
                    key={s.songId}
                    className={st === 'dirty' ? styles.dirtyRow : undefined}
                    data-testid={`song-row-${s.songId}`}
                    data-status={st}
                  >
                    <td>
                      <div className={styles.title}>{s.title}</div>
                      {s.parts ? (
                        <div className={styles.sub}>{s.parts}</div>
                      ) : null}
                    </td>
                    <td className={styles.muted}>{s.summary}</td>
                    <td>
                      <div>{modified}</div>
                      {s.device ? (
                        <div className={styles.sub}>{s.device}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`${styles.chip} ${styles[st]}`}>
                        <span className={styles.dot} aria-hidden="true" />
                        {STATUS_LABEL[st]}
                      </span>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <Button
                          variant="primary"
                          onClick={() => onOpen(s.songId)}
                          aria-label={`${s.title}を開く`}
                        >
                          開く
                        </Button>
                        <Button
                          onClick={() => onOpenView(s.songId)}
                          aria-label={`${s.title}を閲覧で開く`}
                        >
                          閲覧で開く
                        </Button>
                        <PopoverAnchor>
                          <Button
                            ref={(el) => {
                              anchors.current.set(s.songId, el);
                            }}
                            aria-label={`${s.title}のその他の操作`}
                            aria-haspopup="dialog"
                            aria-expanded={menuId === s.songId}
                            onClick={() =>
                              setMenuId(menuId === s.songId ? null : s.songId)
                            }
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <circle cx="5" cy="12" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="19" cy="12" r="2" />
                            </svg>
                          </Button>
                          <Popover
                            open={menuId === s.songId}
                            onClose={() => setMenuId(null)}
                            anchorRef={{
                              get current() {
                                return anchors.current.get(s.songId) ?? null;
                              },
                            }}
                            aria-label={`${s.title}の操作`}
                            align="end"
                            className={styles.menu}
                          >
                            <button
                              type="button"
                              className={styles.menuItem}
                              disabled={!renamable}
                              onClick={() => {
                                setMenuId(null);
                                setRenameId(s.songId);
                              }}
                            >
                              名前を変える
                            </button>
                            {renamable ? null : (
                              <p className={styles.menuHint}>
                                {st === 'localOnly'
                                  ? '未保存の曲は名前を変えられません。保存してから変えられます。'
                                  : '未保存の変更があるときは、編集画面で曲名を変えてください。'}
                              </p>
                            )}
                            <button
                              type="button"
                              className={styles.menuItem}
                              onClick={() => {
                                setMenuId(null);
                                onDuplicate(s.songId);
                              }}
                            >
                              複製する
                            </button>
                            <button
                              type="button"
                              className={`${styles.menuItem} ${styles.menuDanger}`}
                              onClick={() => {
                                setMenuId(null);
                                setDeleteId(s.songId);
                              }}
                            >
                              削除する…
                            </button>
                          </Popover>
                        </PopoverAnchor>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>

      <RenameDialog
        open={renaming !== undefined}
        initialTitle={renaming?.title ?? ''}
        busy={busy}
        onCancel={() => setRenameId(null)}
        onSubmit={(title) => {
          if (renaming && (canRename?.(renaming.songId) ?? true))
            onRename(renaming.songId, title);
          setRenameId(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title={`「${deleting?.title ?? ''}」を削除しますか？`}
        message={
          deletingLocalOnly
            ? 'この端末の曲と下書きを消します。元に戻せません。'
            : 'Drive のゴミ箱に移します（30 日以内なら Drive から戻せます）。この端末の下書きも消えます。'
        }
        confirmLabel="削除する"
        danger
        busy={busy}
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleting) onDelete(deleting.songId);
          setDeleteId(null);
        }}
      />
    </div>
  );
}
