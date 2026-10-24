import { Button } from '../Button/Button';
import styles from './MelodyPlayerBar.module.css';

export interface MelodyPlayerBarProps {
  playing: boolean;
  /** 再生 / 最初から can't be used (read-only section, no notes). */
  disabled: boolean;
  /** Id of the text that explains why it is disabled (the read-only notice). */
  describedBy?: string;
  /** While stopped: where 再生 starts, or why it can't. */
  hint: string;
  /** While playing: 「3 小節目の 2 拍目」 and the bar of the section. */
  position?: { label: string; bar: number; bars: number } | null;
  tempo: number;
  /** False: the song has no {tempo} (shown as 「未設定」). */
  tempoSet: boolean;
  onPlay: () => void;
  onPlayFromHead: () => void;
  onStop: () => void;
}

/**
 * The melody editor's player bar (sketch P1–P3): sticky above the note-length row, the current section only.
 * Display only; `MelodyEditor` owns the playback and the live region.
 */
export function MelodyPlayerBar({
  playing,
  disabled,
  describedBy,
  hint,
  position,
  tempo,
  tempoSet,
  onPlay,
  onPlayFromHead,
  onStop,
}: MelodyPlayerBarProps) {
  return (
    <div
      className={styles.bar}
      role="group"
      aria-label="再生"
      data-testid="melody-player"
      data-state={playing ? 'playing' : 'stopped'}
    >
      <Button
        variant="primary"
        className={styles.play}
        disabled={disabled && !playing}
        aria-describedby={disabled ? describedBy : undefined}
        onClick={playing ? onStop : onPlay}
      >
        {playing ? <StopIcon /> : <PlayIcon />}
        {playing ? '停止' : '再生'}
      </Button>
      <Button
        disabled={disabled || playing}
        aria-label="セクションの最初から再生"
        onClick={onPlayFromHead}
      >
        最初から
      </Button>
      {playing && position ? (
        <span className={styles.status}>
          <span className={styles.position}>{position.label}</span>
          <span className={styles.mono}>
            {position.bar} / {position.bars} 小節
          </span>
          <span className={styles.track} aria-hidden="true">
            <span
              className={styles.fill}
              style={{ width: `${(position.bar / position.bars) * 100}%` }}
            />
          </span>
        </span>
      ) : (
        <span className={styles.hint}>{hint}</span>
      )}
      <span className={styles.tempo}>
        <span className={styles.mono}>
          <span className={styles.tempoWord}>テンポ </span>♩＝{tempo}
        </span>
        {tempoSet ? '（曲の設定）' : '（未設定）'}
      </span>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4l13 8-13 8z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}
