import { useId, useState, type ReactNode } from 'react';
import { Button } from '../Button/Button';
import {
  SegmentedControl,
  type SegmentedOption,
} from '../SegmentedControl/SegmentedControl';
import styles from './SectionPartBar.module.css';

export interface SectionPartBarProps {
  /** セクション picker (SegmentedControl options + current value). */
  sectionOptions: SegmentedOption<string>[];
  sectionLabel: string;
  onSectionLabelChange: (label: string) => void;

  /** パート selector, shown only when there's more than one part. */
  partNames: string[];
  partOrdinal: number;
  onPartOrdinalChange: (ordinal: number) => void;

  /**
   * The current part's name, or `undefined` when there is no part yet
   * (shows `noPartHint` instead of the rename row).
   */
  partName: string | undefined;
  /** Shown instead of the rename row when `partName` is `undefined`. */
  noPartHint: ReactNode;
  /**
   * Attempts the rename; return an error message to show inline, or
   * `undefined` on success. On success the caller is expected to update
   * `partName` (the input then shows that new value).
   */
  onRenamePart: (name: string) => string | undefined;
}

/**
 * Section / part picker + part rename row (M4, M5 T10): the editor's top
 * row, shared by MelodyEditor and DrumEditor.
 */
export function SectionPartBar({
  sectionOptions,
  sectionLabel,
  onSectionLabelChange,
  partNames,
  partOrdinal,
  onPartOrdinalChange,
  partName,
  noPartHint,
  onRenamePart,
}: SectionPartBarProps) {
  const nameId = useId();
  const nameErrorId = useId();
  const partSelectId = useId();
  const [nameDraft, setNameDraft] = useState<{ base: string; value: string }>({
    base: '',
    value: '',
  });
  const [nameError, setNameError] = useState('');
  // Keep the typed draft until the committed name actually changes (e.g. a
  // successful save, or switching parts); reset to the committed name
  // otherwise so stale text never lingers after a save or a part switch.
  const draft =
    partName !== undefined && nameDraft.base === partName
      ? nameDraft.value
      : (partName ?? '');

  const saveName = () => {
    setNameError(onRenamePart(draft) ?? '');
  };

  return (
    <div className={styles.topRow}>
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          セクション
        </span>
        <SegmentedControl
          label="セクション"
          options={sectionOptions}
          value={sectionLabel}
          onChange={onSectionLabelChange}
        />
      </div>

      <div className={styles.field}>
        {partNames.length > 1 && (
          <>
            <label htmlFor={partSelectId} className={styles.fieldLabel}>
              パート
            </label>
            <select
              id={partSelectId}
              className={styles.input}
              value={partOrdinal}
              onChange={(e) => onPartOrdinalChange(Number(e.target.value))}
            >
              {partNames.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </>
        )}
        {partName !== undefined ? (
          <div className={styles.nameRow}>
            <label htmlFor={nameId} className={styles.fieldLabel}>
              パート名
            </label>
            <input
              id={nameId}
              className={styles.input}
              value={draft}
              aria-invalid={nameError !== ''}
              aria-describedby={nameError ? nameErrorId : undefined}
              onChange={(e) => {
                setNameDraft({ base: partName, value: e.target.value });
                setNameError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  saveName();
                }
              }}
            />
            <Button onClick={saveName} disabled={draft === partName}>
              保存
            </Button>
          </div>
        ) : (
          <p className={styles.hint}>{noPartHint}</p>
        )}
        {nameError && (
          <p id={nameErrorId} className={styles.error} role="alert">
            {nameError}
          </p>
        )}
      </div>
    </div>
  );
}
