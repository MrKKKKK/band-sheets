import { useRef } from 'react';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import { formatWhen } from '../Dialog/formatWhen';

/**
 * 'draftNewer' = case B (unsaved draft left behind),
 * 'driveNewer' = case C (another device saved a newer version).
 */
export type OpenDraftKind = 'draftNewer' | 'driveNewer';
/**
 * resumeDraft (B): continue from the draft.
 * openDrive (B, C): open the Drive version, discarding the draft.
 * keepDraftCopy (C, the default — nothing is lost): keep the draft as a
 *   separate song, then open Drive.
 */
export type OpenDraftChoice = 'resumeDraft' | 'openDrive' | 'keepDraftCopy';

export type OpenDraftDialogProps = {
  open: boolean;
  kind: OpenDraftKind;
  songTitle: string;
  draft: { savedAt: string; device?: string };
  drive: { modifiedTime: string; device?: string };
  onChoose: (choice: OpenDraftChoice) => void;
  /** Optional: shows a 「キャンセル」 button (and Esc) to back out (not while busy). */
  onCancel?: () => void;
  busy?: boolean;
  now?: Date;
};

export function OpenDraftDialog({
  open,
  kind,
  songTitle,
  draft,
  drive,
  onChoose,
  onCancel,
  busy = false,
  now,
}: OpenDraftDialogProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const draftWhen = `${formatWhen(draft.savedAt, now)}${draft.device ? `・${draft.device}` : ''}`;
  const driveWhen = `${formatWhen(drive.modifiedTime, now)}${drive.device ? `・${drive.device}` : ''}`;
  const isB = kind === 'draftNewer';
  return (
    <Dialog
      open={open}
      onClose={busy || !onCancel ? () => undefined : onCancel}
      size="sm"
      initialFocusRef={primaryRef}
      title={
        isB
          ? '保存していない下書きが残っています'
          : 'Drive の版が新しくなっています'
      }
      description={
        isB
          ? `「${songTitle}」の下書き（${draftWhen}）は、Drive の版（${driveWhen}）より新しいです。`
          : `「${songTitle}」は、下書き（${draftWhen}）のあとに別の端末で保存されました（Drive の版: ${driveWhen}）。Drive の版だけを開くと、この端末の下書きは消えます。`
      }
      footer={
        <>
          {onCancel ? (
            <Button disabled={busy} onClick={onCancel}>
              キャンセル
            </Button>
          ) : null}
          {isB ? (
            <>
              <Button disabled={busy} onClick={() => onChoose('openDrive')}>
                Drive の版を開く（下書きは破棄）
              </Button>
              <Button
                ref={primaryRef}
                variant="primary"
                disabled={busy}
                onClick={() => onChoose('resumeDraft')}
              >
                下書きから続ける
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onChoose('openDrive')}>
                Drive の版を開く（下書きは破棄）
              </Button>
              <Button
                ref={primaryRef}
                variant="primary"
                disabled={busy}
                onClick={() => onChoose('keepDraftCopy')}
              >
                下書きも別の曲として残す
              </Button>
            </>
          )}
        </>
      }
    />
  );
}
