import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Buttons with a glyph for a face still have to say what they do. */
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, type = 'button', className, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={['icon-button', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
