import { useId, type Ref } from 'react';
import type { AnalysisProgress } from '../../analysis/types';
import { formatClock } from '../../lib/import/format';
import {
  importProgressView,
  type ImportStep,
} from '../../lib/import/importProgress';
import { Button } from '../Button/Button';
import styles from './ImportProgress.module.css';

export type ImportProgressProps = {
  fileName: string;
  /** Seconds, when known. */
  duration: number | null;
  /** The last progress event (null = nothing finished yet). */
  progress: Pick<AnalysisProgress, 'done' | 'total'> | null;
  onCancel: () => void;
  /** The heading (the screen moves focus here when the analysis starts). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** The steps shown. */
  steps: readonly ImportStep[];
  /** Muted text next to 「中止」. */
  footnote?: string;
};

/**
 * S1-c: the analysis is running — steps, an overall bar and 「中止」. Not a live
 * region itself: the screen announces step changes in its one live region.
 */
export function ImportProgress({
  fileName,
  duration,
  progress,
  onCancel,
  headingRef,
  steps,
  footnote = 'このタブは開いたままにしてください。中止すると、ここまでの結果は消えます。',
}: ImportProgressProps) {
  const titleId = useId();
  const view = importProgressView(progress, steps);
  const pct = Math.round(view.fraction * 100);
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className={styles.title}
        >
          解析しています
        </h2>
        <p className={styles.muted}>
          {fileName}
          {duration !== null ? ` ・ ${formatClock(duration)}` : ''}
        </p>
      </div>

      <div className={styles.barBox}>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="解析の進み具合"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <p className={styles.muted} data-testid="import-step-count">
          {view.current} / {view.steps.length} 段階
        </p>
      </div>

      <ol className={styles.steps}>
        {view.steps.map((s, i) => (
          <li
            key={s.label}
            className={`${styles.step} ${styles[s.state]}`}
            data-state={s.state}
            aria-current={s.state === 'now' ? 'step' : undefined}
          >
            <span className={styles.dot} aria-hidden="true">
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            <span className={styles.stepLabel}>{s.label}</span>
            <span className={styles.srOnly}>
              {s.state === 'done'
                ? '（済み）'
                : s.state === 'now'
                  ? '（実行中）'
                  : ''}
            </span>
          </li>
        ))}
      </ol>

      <div className={styles.footer}>
        <Button variant="danger" className={styles.cancel} onClick={onCancel}>
          中止
        </Button>
        <p className={styles.muted}>{footnote}</p>
      </div>
    </section>
  );
}
