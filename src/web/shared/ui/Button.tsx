import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'plain' | 'quiet' | 'danger';
  size?: 'normal' | 'small';
  children: ReactNode;
}

/** Every button on the board is this one: one place decides what a button looks like. */
export function Button({
  variant = 'plain',
  size = 'normal',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={['button', `button--${variant}`, `button--${size}`, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
