import styles from './AutoScrollBar.module.css';

export const SPEED_MIN = 50;
export const SPEED_MAX = 150;
export const SPEED_STEP = 5;

export interface AutoScrollBarProps {
  /** Scrolling (or counting in) right now: shows ⏸ and fades the panel. */
  playing: boolean;
  /** Reached the end of the song: the main button becomes ⟲ (restart). */
  ended?: boolean;
  /** The sheet is not laid out yet: ▶ waits. */
  playDisabled?: boolean;
  /** Song tempo in quarter notes per minute (before the speed factor). */
  tempo: number;
  /** 50..150, steps of 5. */
  speedPct: number;
  countIn: boolean;
  onPlay: () => void;
  onPause: () => void;
  /** Called from the ⟲ state. */
  onRestart: () => void;
  onSpeedChange: (pct: number) => void;
  onCountInChange: (on: boolean) => void;
}

/** Floating auto-scroll control panel (M6). Translucent while playing. */
export function AutoScrollBar({
  playing,
  ended = false,
  playDisabled = false,
  tempo,
  speedPct,
  countIn,
  onPlay,
  onPause,
  onRestart,
  onSpeedChange,
  onCountInChange,
}: AutoScrollBarProps) {
  const effective = Math.round((tempo * speedPct) / 100);
  const label = ended ? '最初から' : playing ? '一時停止' : '再生';
  const onMain = ended ? onRestart : playing ? onPause : onPlay;
  const cls = [styles.bar, playing && !ended ? styles.playing : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      role="group"
      aria-label="自動スクロール"
      data-testid="auto-scroll-bar"
      data-playing={playing && !ended ? 'true' : 'false'}
    >
      <button
        type="button"
        className={styles.main}
        aria-label={label}
        disabled={playDisabled && !playing && !ended}
        onClick={onMain}
      >
        {ended ? (
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : playing ? (
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="6"
              y="5"
              width="4"
              height="14"
              rx="1"
              fill="currentColor"
            />
            <rect
              x="14"
              y="5"
              width="4"
              height="14"
              rx="1"
              fill="currentColor"
            />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        )}
      </button>

      <span className={styles.divider} aria-hidden="true" />

      <div className={styles.stat}>
        <span className={styles.statLabel}>テンポ</span>
        <span className={styles.statValue} data-testid="auto-scroll-tempo">
          ♩={effective}
        </span>
      </div>

      <div className={styles.speed}>
        <button
          type="button"
          className={styles.step}
          aria-label="速度を下げる"
          disabled={speedPct <= SPEED_MIN}
          onClick={() =>
            onSpeedChange(Math.max(SPEED_MIN, speedPct - SPEED_STEP))
          }
        >
          −
        </button>
        <div className={styles.stat}>
          <span className={styles.statLabel}>速度</span>
          <span className={styles.statValue} data-testid="auto-scroll-speed">
            {speedPct}%
          </span>
        </div>
        <button
          type="button"
          className={styles.step}
          aria-label="速度を上げる"
          disabled={speedPct >= SPEED_MAX}
          onClick={() =>
            onSpeedChange(Math.min(SPEED_MAX, speedPct + SPEED_STEP))
          }
        >
          ＋
        </button>
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <button
        type="button"
        role="switch"
        aria-checked={countIn}
        className={styles.countIn}
        onClick={() => onCountInChange(!countIn)}
      >
        <span>
          カウントイン<span className={styles.muted}> (1小節)</span>
        </span>
        <span className={styles.track} aria-hidden="true">
          <span className={styles.knob} />
        </span>
      </button>
    </div>
  );
}
