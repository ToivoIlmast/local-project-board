import type { ComponentPropsWithRef } from 'react';

/** A ref reaches the element (React 19), as it does for `Textarea`. */
export function Input({ className, ...rest }: ComponentPropsWithRef<'input'>) {
  return <input className={['input', className].filter(Boolean).join(' ')} {...rest} />;
}

/** A field that must take the focus when it appears can be given a ref. */
export function Textarea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea className={['input', 'textarea', className].filter(Boolean).join(' ')} {...rest} />
  );
}
