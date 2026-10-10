import type { MouseEvent } from 'react';
import { DRUM_KIT, type DrumInstrument } from '../../lib/drumKit';
import styles from './DrumPads.module.css';

export interface DrumPadsProps {
  /** Click (no Shift): input this instrument at the cursor. */
  onInput: (inst: DrumInstrument) => void;
  /** Shift+click: add/remove this instrument on the previous beat. */
  onToggleOnPrevious: (inst: DrumInstrument) => void;
  disabled?: boolean;
}

/** `KeyF` -> 'F', `Semicolon` -> ';' (docs/m5-decisions.md key map). */
function codeToKeyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code === 'Semicolon') return ';';
  return code;
}

/**
 * Nine drum-kit pad buttons (M5 T9), rendered top-of-staff to bottom in
 * `DRUM_KIT` order, each showing its Japanese name and computer-key hint.
 * Click inputs the instrument at the cursor; Shift+click toggles it on the
 * previous beat instead (same-beat multi-hit without moving the cursor).
 * `onMouseDown` is guarded so clicking a pad never steals keyboard focus
 * from the drum staff, same as `PianoKeyboard`.
 */
export function DrumPads({
  onInput,
  onToggleOnPrevious,
  disabled,
}: DrumPadsProps) {
  const handleClick = (inst: DrumInstrument) => (e: MouseEvent) => {
    if (e.shiftKey) {
      onToggleOnPrevious(inst);
    } else {
      onInput(inst);
    }
  };

  return (
    <div className={styles.pads} role="group" aria-label="ドラムパッド">
      {DRUM_KIT.map((entry) => {
        const keyLabel = codeToKeyLabel(entry.code);
        return (
          <button
            key={entry.id}
            type="button"
            className={styles.pad}
            disabled={disabled}
            aria-label={`${entry.name}（${keyLabel}）`}
            title={`${entry.name}（${keyLabel}）。クリックで入力、Shift+クリックで直前の拍に足す／外す。`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClick(entry.id)}
          >
            <span className={styles.name}>{entry.name}</span>
            <span aria-hidden="true" className={styles.hint}>
              {keyLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}
