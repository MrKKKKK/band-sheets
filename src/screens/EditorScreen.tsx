/**
 * One song in the editor (docs/m7-plan.md, T16): `App` + the header's
 * 「‹ 曲の一覧」 and `SaveStatus`, the open dialog (B/C), the conflict
 * dialog, Ctrl+S / ⌘S, the 「保存せずに一覧に戻りますか？」 confirm, the
 * 「前回読み込んだ版です」 notice (m7-review.md R2) and the 「Drive にこの曲の
 * ファイルが見つかりません」 confirm (R14).
 *
 * Viewing (「閲覧モード」) stays inside `App` (the editor tree is kept,
 * hidden); the caller owns the URL and passes `viewing`.
 */

import { useEffect, useRef, useState } from 'react';
import App from '../App';
import { Button } from '../components/Button/Button';
import { ConfirmDialog } from '../components/ConfirmDialog/ConfirmDialog';
import { ConflictDialog } from '../components/ConflictDialog/ConflictDialog';
import { OpenDraftDialog } from '../components/OpenDraftDialog/OpenDraftDialog';
import { SaveStatus } from '../components/SaveStatus/SaveStatus';
import type { DriveSession, FailReason } from '../hooks/useDriveSession';
import { useSongDocument } from '../hooks/useSongDocument';
import { findEntry, textFields, upsertEntry } from '../hooks/useSongLibrary';
import { loadDraftRecord, saveDraftRecord } from '../lib/storage';
import styles from './EditorScreen.module.css';
import { StaleNotice } from './StaleNotice';

export type EditorScreenProps = {
  session: DriveSession;
  songId: string;
  viewing: boolean;
  onEnterView: () => void;
  onExitView: () => void;
  /** Navigate to the list (after the unsaved-changes confirm, if any). */
  onBackToList: () => void;
  /** 'Ctrl+S' or '⌘S'. */
  shortcutLabel: string;
  /** Tests / stories. */
  now?: () => Date;
  newId?: () => string;
};

const OPEN_ERROR: Record<FailReason, string> = {
  network: '通信できませんでした。もう一度お試しください。',
  auth: 'ログインできませんでした。もう一度お試しください。',
  other: '開けませんでした。もう一度お試しください。',
};

/** Ctrl+S (or ⌘S), not during an IME composition. */
function isSaveShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return e.code === 'KeyS' || e.key === 's' || e.key === 'S';
}

export function EditorScreen({
  session,
  songId,
  viewing,
  onEnterView,
  onExitView,
  onBackToList,
  shortcutLabel,
  now,
  newId,
}: EditorScreenProps) {
  const doc = useSongDocument(session, songId, { now, newId });
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { storage } = session;

  const onTextChange = (text: string) => {
    doc.onTextChange(text);
    // A new song is listed (as device-only) from its first edit. Write the
    // draft first: a list re-read drops device-only entries without one
    // (the autosave's own write is debounced).
    if (!findEntry(storage, songId)) {
      const at = (now?.() ?? new Date()).toISOString();
      if (!loadDraftRecord(storage, songId)) {
        saveDraftRecord(storage, songId, {
          v: 1,
          text,
          baseVersion: doc.baseVersion,
          savedAt: at,
        });
      }
      upsertEntry(storage, { songId, ...textFields(text), modifiedTime: at });
    }
  };

  const leave = () => {
    if (session.configured && doc.phase === 'ready' && doc.dirty) {
      setConfirmLeave(true);
      return;
    }
    onBackToList();
  };

  const saveAndLeave = () => {
    // In the click handler: save() may open the GIS popup.
    const p = doc.save();
    setConfirmLeave(false);
    void p.then((r) => {
      if (r === 'saved' || r === 'skipped') onBackToList();
    });
  };

  // Ctrl+S / ⌘S. Capture phase on window so editors that handle keys
  // themselves can't swallow it; save() runs synchronously in the handler
  // (user gesture for the GIS popup).
  const live = useRef({ doc, viewing, confirmLeave });
  useEffect(() => {
    live.current = { doc, viewing, confirmLeave };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return;
      const s = live.current;
      if (s.viewing) return;
      e.preventDefault();
      const dialog =
        s.confirmLeave ||
        s.doc.conflict !== null ||
        s.doc.ask !== null ||
        s.doc.missing;
      if (dialog || s.doc.phase !== 'ready') return;
      void s.doc.save();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const back = (
    <Button variant="ghost" onClick={leave}>
      ‹ 曲の一覧
    </Button>
  );

  if (doc.phase !== 'ready') {
    return (
      <main className={styles.placeholder} data-testid="editor-placeholder">
        {back}
        {doc.phase === 'loading' && (
          <p role="status" className={styles.message}>
            曲を読み込んでいます…
          </p>
        )}
        {doc.phase === 'unavailable' &&
          (doc.unavailable === 'notFound' ? (
            <p role="alert" className={styles.message}>
              Drive にこの曲のファイルが見つかりません。
              削除されたか、アプリの許可が外れた可能性があります。「‹
              曲の一覧」から戻ってください。
            </p>
          ) : doc.unconfirmed ? (
            <StaleNotice
              nothingCached
              onReconnect={() => void doc.reconnect()}
              busy={doc.reconnecting}
              error={doc.reconnectError}
            />
          ) : (
            <p role="alert" className={styles.message}>
              Drive
              につながらないため開けません。通信を確認して、もう一度開いてください。
            </p>
          ))}
        {doc.phase === 'ask' && doc.openError && (
          <p role="alert" className={styles.error}>
            {OPEN_ERROR[doc.openError]}
          </p>
        )}
        {doc.ask && (
          <OpenDraftDialog
            open
            kind={doc.ask.kind}
            songTitle={doc.ask.songTitle}
            draft={doc.ask.draft}
            drive={doc.ask.drive}
            busy={doc.opening}
            now={now?.()}
            onChoose={(c) => void doc.answerOpen(c)}
            onCancel={onBackToList}
          />
        )}
      </main>
    );
  }

  const saveUi = session.configured ? (
    <SaveStatus
      state={doc.saveState}
      signedIn={session.connected}
      onSave={() => void doc.save()}
      shortcutLabel={shortcutLabel}
    />
  ) : (
    <span className={styles.localOnly} data-testid="save-status-unconfigured">
      この端末だけに保存（Drive 未設定）
    </span>
  );

  return (
    <>
      {session.configured && doc.unconfirmed && !viewing && (
        <StaleNotice
          onReconnect={() => void doc.reconnect()}
          busy={doc.reconnecting}
          error={doc.reconnectError}
        />
      )}
      <App
        key={doc.editorKey}
        storage={storage}
        songId={songId}
        initialText={doc.initialText}
        baseVersion={doc.baseVersion}
        onTextChange={onTextChange}
        viewing={viewing}
        onEnterView={onEnterView}
        onExitView={onExitView}
        headerStart={back}
        headerEnd={saveUi}
      />
      {doc.conflict && (
        <ConflictDialog
          open
          songTitle={doc.conflict.songTitle}
          drive={doc.conflict.drive}
          local={doc.conflict.local}
          changedLines={doc.conflict.changedLines}
          busy={doc.resolving}
          now={now?.()}
          onChoose={(c) => void doc.resolveConflict(c)}
          onCancel={doc.cancelConflict}
        />
      )}
      <ConfirmDialog
        open={doc.missing}
        title="Drive にこの曲のファイルが見つかりません"
        message="削除されたか、アプリの許可が外れた可能性があります。新しく保存しますか？（下書きはこの端末に残ります）"
        confirmLabel="新しく保存する"
        onConfirm={() => void doc.recreate()}
        onCancel={doc.cancelMissing}
      />
      <ConfirmDialog
        open={confirmLeave}
        title="保存せずに一覧に戻りますか？"
        message="下書きはこの端末に残ります。"
        confirmLabel="保存して戻る"
        onConfirm={saveAndLeave}
        secondaryLabel="保存せずに戻る"
        onSecondary={() => {
          setConfirmLeave(false);
          onBackToList();
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </>
  );
}
