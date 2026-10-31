import { useMemo } from 'react';
import { barLineTimes, waveformColumns } from './waveform';
import styles from './TakeWaveform.module.css';

export type TakeWaveformProps = {
  /** The largest |sample| (0–1) of every `bucketSec`. */
  peaks: ArrayLike<number>;
  bucketSec?: number;
  durationSec: number;
  /** Where bar 1 starts (s) = one bar; 0 s .. bar1Sec is the count-in. */
  bar1Sec: number;
  /** The playing position (s), or null. */
  playheadSec?: number | null;
  /** Accessible name. */
  label: string;
};

const W = 800;
const H = 70;
const COLUMNS = 400;

/** A take's waveform with its bar lines (the count-in is shaded). Display only. */
export function TakeWaveform({
  peaks,
  durationSec,
  bar1Sec,
  playheadSec = null,
  label,
}: TakeWaveformProps) {
  const path = useMemo(() => {
    const cols = waveformColumns(peaks, COLUMNS);
    return cols
      .map((v, i) => {
        const x = ((i + 0.5) / cols.length) * W;
        const half = Math.max(1, v * (H / 2 - 4));
        return `M${x.toFixed(1)} ${(H / 2 - half).toFixed(1)}V${(H / 2 + half).toFixed(1)}`;
      })
      .join('');
  }, [peaks]);
  const x = (sec: number) => (sec / durationSec) * W;
  const lines = barLineTimes(durationSec, bar1Sec);
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {durationSec > 0 && bar1Sec > 0 ? (
        <rect
          className={styles.countIn}
          x={0}
          y={0}
          width={x(Math.min(bar1Sec, durationSec))}
          height={H}
        />
      ) : null}
      <line className={styles.axis} x1={0} y1={H / 2} x2={W} y2={H / 2} />
      {lines.map((t, i) => (
        <line
          key={i}
          className={i === 1 ? styles.barOne : styles.bar}
          x1={x(t)}
          y1={0}
          x2={x(t)}
          y2={H}
        />
      ))}
      <path className={styles.wave} d={path} />
      {playheadSec !== null && durationSec > 0 ? (
        <line
          data-testid="waveform-playhead"
          className={styles.playhead}
          x1={x(playheadSec)}
          y1={0}
          x2={x(playheadSec)}
          y2={H}
        />
      ) : null}
    </svg>
  );
}
