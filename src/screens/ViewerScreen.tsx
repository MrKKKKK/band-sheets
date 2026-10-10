/**
 * The viewer opened from the list or a `#/view/<id>` URL (docs/m7-plan.md,
 * T16). The editor is never mounted here, so no draft is ever written.
 * `useSongView` shows the cached text at once and checks Drive once on
 * open; a newer version replaces it with a one-line notice. Without a
 * check (sign-in expired / offline) it says 「前回読み込んだ版です」 with
 * 「Drive に再接続」 (m7-review.md R2).
 */

import { useEffect, useMemo } from 'react';
import { Button } from '../components/Button/Button';
import { EditorErrorBoundary } from '../components/EditorErrorBoundary/EditorErrorBoundary';
import { Viewer } from '../components/Viewer/Viewer';
import type { ViewerClock } from '../components/Viewer/viewerClock';
import type { DriveSession } from '../hooks/useDriveSession';
import { useSongView } from '../hooks/useSongDocument';
import { parseSong } from '../lib/parseSong';
import { UNTITLED } from '../lib/serializeSong';
import styles from './ViewerScreen.module.css';
import { StaleNotice } from './StaleNotice';

export type ViewerScreenProps = {
  session: DriveSession;
  songId: string;
  onBack: () => void;
  clock?: ViewerClock;
};

const BACK = '‹ 曲の一覧';

const NOTICE = {
  draft: '未保存の変更を含む表示です（この端末の下書き）。',
  updated: 'Drive の新しい版を表示しています。',
} as const;

export function ViewerScreen({
  session,
  songId,
  onBack,
  clock,
}: ViewerScreenProps) {
  const view = useSongView(session, songId);
  const song = useMemo(() => parseSong(view.text), [view.text]);
  const title = song.meta.title.trim() || UNTITLED;
  const ready = view.phase === 'ready';

  useEffect(() => {
    document.title = ready
      ? `${title} - 閲覧 - band-sheets`
      : '閲覧 - band-sheets';
  }, [title, ready]);

  if (!ready) {
    return (
      <main className={styles.placeholder} data-testid="viewer-placeholder">
        <Button variant="ghost" onClick={onBack}>
          {BACK}
        </Button>
        {view.phase === 'loading' ? (
          <p role="status" className={styles.message}>
            曲を読み込んでいます…
          </p>
        ) : view.unconfirmed ? (
          <StaleNotice
            nothingCached
            onReconnect={() => void view.reconnect()}
            busy={view.reconnecting}
          />
        ) : (
          <p role="alert" className={styles.message}>
            Drive
            につながらないため開けません。通信を確認して、もう一度開いてください。
          </p>
        )}
      </main>
    );
  }

  return (
    <div className={styles.screen}>
      {view.unconfirmed && (
        <StaleNotice
          onReconnect={() => void view.reconnect()}
          busy={view.reconnecting}
        />
      )}
      {view.notice && (
        <p className={styles.notice} role="status" data-testid="view-notice">
          {NOTICE[view.notice]}
        </p>
      )}
      <div className={styles.viewer}>
        <EditorErrorBoundary resetKey={view.text}>
          <Viewer
            key={`${songId}:${view.textKey}`}
            song={song}
            songId={songId}
            storage={session.storage}
            onExit={onBack}
            backLabel={BACK}
            clock={clock}
          />
        </EditorErrorBoundary>
      </div>
    </div>
  );
}
