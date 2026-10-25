import type { ComponentPropsWithRef, InputHTMLAttributes } from 'react';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={['input', className].filter(Boolean).join(' ')} {...rest} />;
}

/** A ref reaches the element (React 19), for a field that must take the focus when it appears. */
export function Textarea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea className={['input', 'textarea', className].filter(Boolean).join(' ')} {...rest} />
  );
}
