import type { Duration } from '../../lib/melody';
import { INPUT_DURATIONS } from '../../lib/melody';
import { injectBravuraFontFace } from '../PartScore/bravuraFont';
import styles from './DurationBar.module.css';

// This component draws SMuFL note glyphs via CSS (`--font-music`), so it
// must register the Bravura @font-face itself when mounted on its own
// (e.g. in its own Storybook story) — see bravuraFont.ts's comment.
injectBravuraFontFace();

export interface DurationBarProps {
  /** Only `INPUT_DURATIONS` ('1' | '2' | '4' | '8' | '16') are valid input. */
  duration: Duration;
  dotted: boolean;
  onDurationChange: (duration: Duration) => void;
  onDottedChange: (dotted: boolean) => void;
  onRest: () => void;
}

// SMuFL "Individual notes" range (U+E1D0+): one glyph per note value,
// stem-up variant. Verified against the SMuFL spec: noteWhole U+E1D2,
// noteHalfUp U+E1D3, noteQuarterUp U+E1D5, note8thUp U+E1D7,
// note16thUp U+E1D9 (the pattern continues .../U+E1DB note32ndUp, unused
// here since '32' is output-only — see melody.ts INPUT_DURATIONS).
const DURATION_GLYPHS: Record<Duration, string> = {
  '1': '',
  '2': '',
  '4': '',
  '8': '',
  '16': '',
  '32': '',
};

const DURATION_LABELS: Record<Duration, string> = {
  '1': '全音符',
  '2': '2分音符',
  '4': '4分音符',
  '8': '8分音符',
  '16': '16分音符',
  '32': '32分音符',
};

// Key hints per docs/m4-decisions.md's key table: 1 2 4 8 6 for whole,
// half, quarter, eighth, 16th (16th's key is "6", not "16").
const DURATION_HINTS: Record<Duration, string> = {
  '1': '1',
  '2': '2',
  '4': '4',
  '8': '8',
  '16': '6',
  '32': '',
};

/**
 * Duration / dotted / rest controls for the melody editor (T12). A
 * SegmentedControl-style group of 5 note-value buttons (SMuFL glyph + key
 * hint, Japanese aria-label), a 付点 toggle and a 休符 button. All controls
 * are `onMouseDown`-guarded so clicking them never steals keyboard focus
 * from the melody staff; they remain reachable by Tab.
 */
export function DurationBar({
  duration,
  dotted,
  onDurationChange,
  onDottedChange,
  onRest,
}: DurationBarProps) {
  return (
    <div className={styles.bar}>
      <div role="group" aria-label="音価" className={styles.group}>
        {INPUT_DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === duration}
            aria-label={DURATION_LABELS[d]}
            aria-keyshortcuts={DURATION_HINTS[d]}
            className={styles.option}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (d !== duration) onDurationChange(d);
            }}
          >
            <span aria-hidden="true" className={styles.glyph}>
              {DURATION_GLYPHS[d]}
            </span>
            <span aria-hidden="true" className={styles.hint}>
              {DURATION_HINTS[d]}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={dotted}
        aria-label="付点"
        aria-keyshortcuts="."
        className={styles.toggle}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onDottedChange(!dotted)}
      >
        付点
        <span aria-hidden="true" className={styles.hint}>
          .
        </span>
      </button>
      <button
        type="button"
        aria-label="休符"
        aria-keyshortcuts="R"
        className={styles.rest}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRest}
      >
        休符
        <span aria-hidden="true" className={styles.hint}>
          R
        </span>
      </button>
    </div>
  );
}
