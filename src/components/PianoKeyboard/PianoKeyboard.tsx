import {
  formatPitch,
  parsePitch,
  pitchToMidi,
  semitoneToPitch,
} from '../../lib/pitch';
import styles from './PianoKeyboard.module.css';

export interface PianoKeyboardProps {
  /** C of this octave is the keyboard's leftmost key (3–5). */
  baseOctave: number;
  onKey: (pitch: string) => void;
  /** Spells black keys per this key signature (default: sharps). */
  keySignature?: string;
  /**
   * Pitches (e.g. 'C4') to render in the selected/preview color, compared
   * by MIDI number: 'Db4' lights the key spelled C#4 (M13).
   */
  highlight?: string[];
}

const LETTER_KANA: Record<string, string> = {
  C: 'ド',
  D: 'レ',
  E: 'ミ',
  F: 'ファ',
  G: 'ソ',
  A: 'ラ',
  B: 'シ',
};

const ACCIDENTAL_SYMBOL: Record<string, string> = { '': '', '#': '♯', b: '♭' };

// White-key semitones within one octave, C..B (relative to that octave's C).
const WHITE_SEMITONES_IN_OCTAVE = [0, 2, 4, 5, 7, 9, 11];

// Black-key x offsets within one octave, in units of one white-key width
// (approximate standard piano geometry: each black key sits off-center
// between its two white neighbors, not exactly on the boundary).
const BLACK_OFFSETS: Record<number, number> = {
  1: 0.7, // C#/Db
  3: 1.75, // D#/Eb
  6: 3.7, // F#/Gb
  8: 4.75, // G#/Ab
  10: 5.8, // A#/Bb
};

// Computer-key hints (docs/m4-decisions.md key table), shown on the first
// octave only (semitones 0-12 inclusive: C through the next C). These
// duplicate pitch.ts's `codeToSemitone` table (not exported in reverse) —
// UI display labels only, not re-derived logic.
const WHITE_KEY_HINTS = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K'];
const BLACK_KEY_HINTS: Record<number, string> = {
  1: 'W',
  3: 'E',
  6: 'T',
  8: 'Y',
  10: 'U',
};

interface KeyInfo {
  semitone: number;
  pitch: string;
  midi: number;
  ariaLabel: string;
  hint?: string;
}

function makeKey(
  semitone: number,
  baseOctave: number,
  keySignature: string | undefined,
  hint: string | undefined,
): KeyInfo {
  const p = semitoneToPitch(baseOctave, semitone, keySignature);
  const pitch = formatPitch(p);
  const ariaLabel = `${LETTER_KANA[p.letter]}${ACCIDENTAL_SYMBOL[p.accidental]}${p.octave}`;
  return { semitone, pitch, midi: pitchToMidi(p), ariaLabel, hint };
}

// 15 white keys: C of baseOctave .. B of baseOctave+1, plus the top C.
const WHITE_SEMITONES: number[] = [
  ...[0, 1].flatMap((oct) =>
    WHITE_SEMITONES_IN_OCTAVE.map((s) => oct * 12 + s),
  ),
  24,
];

function buildWhiteKeys(
  baseOctave: number,
  keySignature: string | undefined,
): KeyInfo[] {
  return WHITE_SEMITONES.map((s, i) =>
    makeKey(
      s,
      baseOctave,
      keySignature,
      i < 8 ? WHITE_KEY_HINTS[i] : undefined,
    ),
  );
}

// 10 black keys: 5 per octave, within the two octaves only (none above the
// top C).
function buildBlackKeys(
  baseOctave: number,
  keySignature: string | undefined,
): (KeyInfo & { x: number })[] {
  const out: (KeyInfo & { x: number })[] = [];
  for (const oct of [0, 1]) {
    for (const [semiStr, offset] of Object.entries(BLACK_OFFSETS)) {
      const semiInOct = Number(semiStr);
      const s = oct * 12 + semiInOct;
      out.push({
        ...makeKey(s, baseOctave, keySignature, BLACK_KEY_HINTS[s]),
        x: oct * 7 + offset,
      });
    }
  }
  return out;
}

const WHITE_KEY_WIDTH = 40;
const WHITE_KEY_HEIGHT = 160;
const BLACK_KEY_WIDTH = 26;
const BLACK_KEY_HEIGHT = 100;

/**
 * Two-octave (+ top C) piano for the melody editor (T12): real `<button>`s
 * positioned like a piano (white keys in a row, black keys absolutely
 * positioned over the boundaries), aria-labelled in Japanese solfège
 * ("ド4", "ド♯4"), spelled per `keySignature`. The first octave's keys show
 * their computer-key hint. `onMouseDown` is guarded so clicking a key never
 * steals keyboard focus from the melody staff; keys remain reachable by Tab.
 */
export function PianoKeyboard({
  baseOctave,
  onKey,
  keySignature,
  highlight,
}: PianoKeyboardProps) {
  const whiteKeys = buildWhiteKeys(baseOctave, keySignature);
  const blackKeys = buildBlackKeys(baseOctave, keySignature);
  const highlighted = new Set(
    (highlight ?? []).flatMap((h) => {
      const p = parsePitch(h);
      return p ? [pitchToMidi(p)] : [];
    }),
  );
  const isLit = (k: KeyInfo) => highlighted.has(k.midi);

  return (
    <div
      className={styles.keyboard}
      style={{ width: WHITE_SEMITONES.length * WHITE_KEY_WIDTH }}
    >
      <div className={styles.whiteRow}>
        {whiteKeys.map((k) => (
          <button
            key={k.semitone}
            type="button"
            className={
              isLit(k) ? `${styles.white} ${styles.highlighted}` : styles.white
            }
            data-highlighted={isLit(k) || undefined}
            style={{ width: WHITE_KEY_WIDTH, height: WHITE_KEY_HEIGHT }}
            aria-label={k.ariaLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onKey(k.pitch)}
          >
            {k.hint && (
              <span aria-hidden="true" className={styles.hint}>
                {k.hint}
              </span>
            )}
          </button>
        ))}
      </div>
      {blackKeys.map((k) => (
        <button
          key={k.semitone}
          type="button"
          className={
            isLit(k) ? `${styles.black} ${styles.highlighted}` : styles.black
          }
          data-highlighted={isLit(k) || undefined}
          style={{
            width: BLACK_KEY_WIDTH,
            height: BLACK_KEY_HEIGHT,
            left: k.x * WHITE_KEY_WIDTH - BLACK_KEY_WIDTH / 2,
          }}
          aria-label={k.ariaLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onKey(k.pitch)}
        >
          {k.hint && (
            <span aria-hidden="true" className={styles.hint}>
              {k.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
