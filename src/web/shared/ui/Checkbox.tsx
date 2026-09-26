import { useId, type InputHTMLAttributes } from 'react';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'id' | 'children'
> {
  label: string;
  hint?: string;
  /** Dims the checkbox without disabling it (see `Field`). */
  muted?: boolean;
}

/** A labelled checkbox; its hint is what a screen reader reads after the label. */
export function Checkbox({ label, hint, muted = false, className, ...rest }: CheckboxProps) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div
      className={['check', muted ? 'check--muted' : undefined, className].filter(Boolean).join(' ')}
    >
      <input type="checkbox" id={id} aria-describedby={hintId} {...rest} />
      <label htmlFor={id}>{label}</label>
      {hint === undefined ? null : (
        <p className="check__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
