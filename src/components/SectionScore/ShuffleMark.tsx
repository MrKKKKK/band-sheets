import { useMemo } from 'react';
import type { Shuffle } from '../../lib/drum';
import { layoutDrums } from '../../lib/drumLayout';
import { injectBravuraFontFace } from '../PartScore/bravuraFont';
import styles from './SectionScore.module.css';

injectBravuraFontFace();

export interface ShuffleMarkProps {
  shuffle: Shuffle;
  /** px between staff lines of the staff it sits on (sizes the figure). */
  staffSpace: number;
}

/** Room left free around the figure's box (px). */
const PAD = 2;

/**
 * The drum staff's Shuffle marking for the viewer ("Shuffle ♫ = ♩♪" under
 * a triplet 3 — the same figure the M5 drum input staff draws, taken from
 * `layoutDrums`' own `ShuffleMark` layout), or the plain word "Straight"
 * for `'none'` (a section that returns to straight eighths). Sized to its
 * content; the caller positions it (bottom-left = the anchor).
 */
export function ShuffleMark({ shuffle, staffSpace }: ShuffleMarkProps) {
  const m = useMemo(
    () =>
      shuffle === 'none'
        ? undefined
        : layoutDrums(
            [],
            { num: 4, den: 4 },
            { width: 1000, staffSpace, shuffle },
          ).shuffle,
    [shuffle, staffSpace],
  );
  if (!m) {
    return (
      <span
        className={styles.straight}
        style={{ fontSize: 1.5 * staffSpace }}
        data-testid="shuffle-mark"
        data-shuffle="none"
      >
        Straight
      </span>
    );
  }
  const { x1, y1, x2, y2 } = m.box;
  const w = x2 - x1 + 2 * PAD;
  const h = y2 - y1 + 2 * PAD;
  const t = 0.12 * staffSpace; // stem / bracket stroke
  return (
    <svg
      className={styles.shuffleSvg}
      width={w}
      height={h}
      viewBox={`${x1 - PAD} ${y1 - PAD} ${w} ${h}`}
      data-testid="shuffle-mark"
      data-shuffle={m.shuffle}
    >
      <text
        x={m.label.x}
        y={m.label.y}
        fontSize={m.labelFontSize}
        className={styles.label}
      >
        {m.label.text}
      </text>
      <text
        x={m.equals.x}
        y={m.equals.y}
        fontSize={m.labelFontSize}
        textAnchor="middle"
        className={styles.label}
      >
        {m.equals.text}
      </text>
      {m.stems.map((st, i) => (
        <line
          key={`st-${i}`}
          x1={st.x}
          x2={st.x}
          y1={st.y1}
          y2={st.y2}
          strokeWidth={t}
          className={styles.stroke}
        />
      ))}
      {m.beams.map((bm, i) => (
        <line
          key={`bm-${i}`}
          x1={bm.x1}
          x2={bm.x2}
          y1={bm.y}
          y2={bm.y}
          strokeWidth={0.5 * 0.55 * staffSpace}
          className={styles.beam}
        />
      ))}
      {m.tuplet.line.map((seg, i) => (
        <line
          key={`tu-${i}`}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          strokeWidth={t}
          className={styles.stroke}
        />
      ))}
      <g className={styles.music} style={{ fontSize: m.fontSize }}>
        {[...m.heads, ...m.flags].map((g, i) => (
          <text key={`g-${i}`} x={g.x} y={g.y}>
            {g.text}
          </text>
        ))}
        <text x={m.tuplet.number.x} y={m.tuplet.number.y} textAnchor="middle">
          {m.tuplet.number.text}
        </text>
      </g>
    </svg>
  );
}
