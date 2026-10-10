import type { ComponentPropsWithRef } from 'react';
import styles from './Chip.module.css';

export type ChipProps = Omit<
  ComponentPropsWithRef<'button'>,
  'aria-pressed'
> & {
  /** Toggle state; omit for a plain (non-toggle) chip. */
  selected?: boolean;
};

/** Pill button for chord names (monospace). */
export function Chip({
  selected,
  type = 'button',
  className,
  ...rest
}: ChipProps) {
  const cls = [styles.chip, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} aria-pressed={selected} {...rest} />
  );
}
