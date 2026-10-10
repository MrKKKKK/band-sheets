import { useRef, useState } from 'react';
import { Button } from '../Button/Button';
import { Popover, PopoverAnchor } from '../Popover/Popover';
import styles from './SectionNotice.module.css';

export type SectionNoticeProps =
  | {
      /** DOM id of the notice's wrapping element (for `aria-describedby`). */
      id: string;
      status: 'readonly';
      /** Shown as 「…（理由: {reason}）」. */
      reason: string;
      /**
       * Shown as a button instead of plain instruction text, for a caller
       * that can switch to テキスト入力. Omit to just show the instruction.
       */
      onRequestTextEdit?: () => void;
    }
  | {
      id: string;
      status: 'barMismatch';
      reason: string;
      /** The time signature to re-flow to, e.g. `"3/4"`. */
      timeSigLabel: string;
      /** Re-flows the section's bars (called after the user confirms). */
      onReflow: () => void;
    };

/**
 * Read-only / bar-mismatch notice shown above an editor's input area (M3,
 * M4 T16), shared by MelodyEditor and DrumEditor (M5 T10). The caller
 * decides which variant applies (from its own section-read result) and
 * owns the `id` so an `aria-describedby` elsewhere can point at it.
 */
export function SectionNotice(props: SectionNoticeProps) {
  // Hooks run unconditionally (rules-of-hooks): the barMismatch popover's
  // open state and anchor ref, unused by the readonly variant.
  const reflowRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);

  if (props.status === 'readonly') {
    const { id, reason, onRequestTextEdit } = props;
    return (
      <p id={id} className={styles.notice}>
        このセクションはアプリでは編集できません（理由: {reason}
        ）。
        {onRequestTextEdit ? (
          <Button
            variant="ghost"
            className={styles.noticeAction}
            onClick={onRequestTextEdit}
          >
            テキスト入力で編集する
          </Button>
        ) : (
          'テキスト入力で編集してください'
        )}
      </p>
    );
  }

  const { id, reason, timeSigLabel, onReflow } = props;
  return (
    <div id={id} className={styles.noticeBlock}>
      <p className={styles.noticeText}>
        拍子が変わったため小節が合いません（{reason}）
      </p>
      <PopoverAnchor>
        <Button
          ref={reflowRef}
          variant="secondary"
          aria-haspopup="dialog"
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          新しい拍子で小節を引き直す
        </Button>
        <Popover
          open={confirming}
          onClose={() => setConfirming(false)}
          anchorRef={reflowRef}
          aria-label="小節の引き直しの確認"
          className={styles.confirmPopover}
        >
          <p className={styles.confirmText}>
            このセクションの小節線を {timeSigLabel}{' '}
            で引き直します。よろしいですか？
          </p>
          <div className={styles.confirmActions}>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                onReflow();
              }}
            >
              引き直す
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              キャンセル
            </Button>
          </div>
        </Popover>
      </PopoverAnchor>
    </div>
  );
}
