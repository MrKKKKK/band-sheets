import styles from './SegmentedControl.module.css';

export type SegmentedOption<T extends string> = { value: T; label: string };

export type SegmentedControlProps<T extends string> = {
  /** Accessible name of the group. */
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  'aria-describedby'?: string;
};

/** Mutually exclusive toggle buttons (aria-pressed) in a labelled group. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  'aria-describedby': describedBy,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className={styles.group}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={styles.option}
          disabled={disabled}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
