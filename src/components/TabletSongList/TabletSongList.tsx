import { useId, useState } from 'react';
import type { SongEntry, SortOrder } from '../../lib/syncTypes';
import { filterSongs, formatModified, sortSongs } from '../../lib/songIndex';
import { ConnectionBanner } from '../ConnectionBanner/ConnectionBanner';
import { SegmentedControl } from '../SegmentedControl/SegmentedControl';
import styles from './TabletSongList.module.css';

export type TabletSongListProps = {
  songs: readonly SongEntry[];
  /** songIds whose text is cached on this device. */
  cachedIds: ReadonlySet<string>;
  /** The song being fetched / opened now (row shows 「読み込み中…」). */
  openingId?: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  order: SortOrder;
  onOrderChange: (order: SortOrder) => void;
  /** No connection to Drive: uncached songs cannot be opened. */
  offline?: boolean;
  /** When the list was last loaded from Drive (ISO). */
  listedAt?: string;
  /** true while the list is being re-fetched. */
  refreshing?: boolean;
  /** The last refresh attempt failed (shown next to the button). */
  refreshFailed?: boolean;
  onRefresh: () => void;
  onOpenView: (songId: string) => void;
  /** For 「今日 14:32」 formatting; defaults to the current time. */
  now?: Date;
};

const ORDER_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'modified', label: '更新が新しい順' },
  { value: 'title', label: '曲名順' },
];

function hm(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Tablet song picker: tap a row to open the song in the viewer. View only. */
export function TabletSongList({
  songs,
  cachedIds,
  openingId = null,
  query,
  onQueryChange,
  order,
  onOrderChange,
  offline = false,
  listedAt,
  refreshing = false,
  refreshFailed = false,
  onRefresh,
  onOpenView,
  now,
}: TabletSongListProps) {
  const searchId = useId();
  const shown = sortSongs(filterSongs(songs, query), order);
  const busy = openingId !== null;
  const [mountedAt] = useState(() => new Date());
  const clock = now ?? mountedAt;
  const at = hm(listedAt);

  return (
    <div className={styles.root} data-testid="tablet-song-list">
      <header className={styles.top}>
        <h1 className={styles.heading}>曲を選ぶ</h1>
        <div className={styles.spacer} />
        <span
          className={styles.sync}
          data-testid="sync-state"
          data-state={offline ? 'offline' : 'synced'}
          role="status"
        >
          <span
            className={`${styles.dot} ${offline ? styles.dotOff : ''}`}
            aria-hidden="true"
          />
          {offline
            ? 'オフライン'
            : at
              ? `Drive と同期済み（${at}）`
              : 'Drive と同期'}
        </span>
        <button
          type="button"
          className={styles.refresh}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </svg>
          {refreshing ? '更新中…' : '更新'}
        </button>
      </header>

      {offline && (
        <ConnectionBanner
          kind="offline"
          listedAt={listedAt}
          onRetry={onRefresh}
          retrying={refreshing}
        />
      )}
      {refreshFailed && !refreshing && (
        <p role="alert" className={styles.empty} data-testid="refresh-failed">
          更新できませんでした。電波のよいところでもう一度お試しください。
        </p>
      )}

      <div className={styles.tools}>
        <div className={styles.search}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <label htmlFor={searchId} className={styles.srOnly}>
            曲名で探す
          </label>
          <input
            id={searchId}
            type="search"
            className={styles.input}
            placeholder="曲名で探す"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
        <SegmentedControl
          label="並び順"
          options={ORDER_OPTIONS}
          value={order}
          onChange={onOrderChange}
        />
      </div>

      <ul className={styles.list} aria-label="曲">
        {shown.map((s) => {
          const opening = s.songId === openingId;
          const cached = cachedIds.has(s.songId);
          const unavailable = offline && !cached;
          const meta = [s.summary, s.parts].filter(Boolean).join(' ・ ');
          const cache = opening
            ? 'Drive から読み込み中…'
            : cached
              ? 'この iPad に保存済み'
              : unavailable
                ? 'オフラインのため開けません'
                : 'Drive から取得します';
          return (
            <li key={s.songId}>
              <button
                type="button"
                className={`${styles.row} ${opening ? styles.opening : ''}`}
                data-testid={`song-row-${s.songId}`}
                data-cache={opening ? 'fetching' : cached ? 'cached' : 'remote'}
                disabled={busy || unavailable}
                aria-busy={opening || undefined}
                onClick={() => onOpenView(s.songId)}
              >
                <span className={styles.main}>
                  <span className={styles.title}>{s.title}</span>
                  {meta && <span className={styles.meta}>{meta}</span>}
                </span>
                <span className={styles.info}>
                  <span>
                    {s.modifiedTime
                      ? `更新 ${formatModified(s.modifiedTime, clock)}`
                      : ''}
                  </span>
                  <span
                    className={
                      opening
                        ? styles.cacheOpening
                        : cached
                          ? styles.cacheOk
                          : undefined
                    }
                  >
                    {cache}
                  </span>
                </span>
                <span className={styles.action}>
                  {opening ? '開いています' : '閲覧'}
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    aria-hidden="true"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && (
        <p className={styles.empty} data-testid="empty">
          {songs.length === 0
            ? 'まだ曲がありません。PC で曲を作ると、ここに出ます。'
            : '見つかりませんでした。'}
        </p>
      )}

      <footer className={styles.foot}>
        <span>タップすると閲覧画面で開きます。</span>
        <span>曲の編集は PC で行います。</span>
      </footer>
    </div>
  );
}
