import { useEffect, useRef } from 'react';
import { MEASURE_CLICKS } from '../../lib/mic/latency';
import {
  MEASURE_FAILED_TEXT,
  MEASURE_FAILED_TIPS,
  MEASURE_FAILED_TITLE,
  MEASURE_INSTRUCTION,
  MEASURE_TITLE,
  MEASURED_TITLE,
  measuredNote,
  measuredText,
  measureProgressText,
} from '../../lib/mic/micTexts';
import type { RecorderState } from '../../lib/mic/recorderState';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import styles from './LatencyDialog.module.css';

export type LatencyDialogProps = {
  /** Open in the phases measuring / measured / measureFailed (M4 A / B / C); closed otherwise. */
  state: RecorderState;
  /** 中止 / 閉じる. */
  onClose: () => void;
  /** もう一度測る (call the recorder's `measure`: it resumes the context inside the click). */
  onMeasure: () => void;
};

/**
 * M4: the latency measurement's small dialog. Creates no live region (the screen's one announces the result);
 * the progress is a labelled `progressbar`, the failure box is not `role="alert"`.
 */
export function LatencyDialog({
  state,
  onClose,
  onMeasure,
}: LatencyDialogProps) {
  const phase = state.phase;
  const open =
    phase === 'measuring' || phase === 'measured' || phase === 'measureFailed';
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The dialog stays open across A → B / C, and the focused button vanishes: move focus to the new primary one.
  useEffect(() => {
    if (phase === 'measured' || phase === 'measureFailed')
      primaryRef.current?.focus();
  }, [phase]);

  if (state.phase === 'measuring') {
    const total = MEASURE_CLICKS;
    const heard = Math.min(total, Math.max(0, state.heard));
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title={MEASURE_TITLE}
        initialFocusRef={cancelRef}
        footer={
          <Button ref={cancelRef} onClick={onClose}>
            中止
          </Button>
        }
      >
        <div className={styles.body}>
          <div className={styles.pict} aria-hidden="true">
            <svg
              width="56"
              height="44"
              viewBox="0 0 56 44"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 28v-4a14 14 0 0 1 28 0v4" />
              <rect x="4" y="26" width="7" height="12" rx="2" />
              <rect x="29" y="26" width="7" height="12" rx="2" />
              <rect x="42" y="8" width="8" height="14" rx="4" />
              <path d="M40 22a6 6 0 0 0 12 0" />
            </svg>
            <span>ヘッドホン ⇄ マイク</span>
          </div>
          <p className={styles.text}>{MEASURE_INSTRUCTION}</p>
          <div className={styles.dots} aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
              <b key={i} className={i < heard ? styles.on : undefined} />
            ))}
          </div>
          <div
            className={styles.prog}
            role="progressbar"
            aria-label="測定の進み具合"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={heard}
            aria-valuetext={`${total} 回中 ${heard} 回`}
          >
            <i style={{ width: `${(heard / total) * 100}%` }} />
          </div>
          <p className={styles.muted}>{measureProgressText(heard, total)}</p>
        </div>
      </Dialog>
    );
  }

  if (state.phase === 'measured') {
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title={MEASURED_TITLE}
        initialFocusRef={primaryRef}
        footer={
          <>
            <Button onClick={onMeasure}>もう一度測る</Button>
            <Button ref={primaryRef} variant="primary" onClick={onClose}>
              閉じる
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <div className={styles.ok} data-testid="measure-result">
            <span className={styles.res}>
              {Math.round(state.remainderMs ?? 0)} ms
            </span>
            <br />
            {state.remainderMs === null ? '' : measuredText(state.remainderMs)}
          </div>
          <p className={styles.muted}>{measuredNote(state.spreadMs)}</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={MEASURE_FAILED_TITLE}
      initialFocusRef={primaryRef}
      footer={
        <>
          <Button onClick={onClose}>閉じる</Button>
          <Button ref={primaryRef} variant="primary" onClick={onMeasure}>
            もう一度測る
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.err} data-testid="measure-failed">
          <strong>{MEASURE_FAILED_TEXT}</strong>
        </div>
        <p className={styles.muted}>次を試してください。</p>
        <ul className={styles.tips}>
          {MEASURE_FAILED_TIPS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
