import type { ComponentPropsWithRef } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
};

/** Native <button>; icon-only usage must pass `aria-label`. */
export function Button({
  variant = 'secondary',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const cls = [styles.button, styles[variant], className]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={cls} {...rest} />;
}
