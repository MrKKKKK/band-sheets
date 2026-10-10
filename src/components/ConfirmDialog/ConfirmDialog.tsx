import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message?: string;
  /** Main action (right-most). */
  confirmLabel: string;
  onConfirm: () => void;
  /** Destructive styling for the main action (delete). */
  danger?: boolean;
  /** Optional middle action, e.g. 「保存せずに戻る」. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Cancel button + Esc. Defaults to 「キャンセル」. */
  cancelLabel?: string;
  onCancel: () => void;
  /** Disables the action buttons while a request is running. */
  busy?: boolean;
};

/**
 * Delete (2 buttons) / back-to-list (3 buttons: cancel, secondary, main).
 * Focus starts on 「キャンセル」 (first in DOM) so Enter never destroys.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  danger = false,
  secondaryLabel,
  onSecondary,
  cancelLabel = 'キャンセル',
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          {secondaryLabel ? (
            <Button onClick={onSecondary} disabled={busy}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
