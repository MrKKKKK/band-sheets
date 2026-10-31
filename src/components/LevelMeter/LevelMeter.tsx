import styles from './LevelMeter.module.css';

export type LevelMeterProps = {
  /** The input's peak, 0–1 (linear amplitude). */
  level: number;
  /** Accessible name. */
  label: string;
};

/** Linear amplitude is mostly tiny for a voice, so the bar shows its square root (0–100). */
function levelPercent(level: number): number {
  const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return Math.round(Math.sqrt(v) * 100);
}

/** The mic's level bar. `role="meter"`, not a live region (it changes ~23 times a second). */
export function LevelMeter({ level, label }: LevelMeterProps) {
  const pct = levelPercent(level);
  return (
    <div
      className={styles.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <i className={styles.fill} style={{ width: `${pct}%` }} />
    </div>
  );
}
