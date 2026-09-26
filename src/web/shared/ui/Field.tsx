import { useId, type ReactElement } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  /** Dims the field without disabling it: what it says is still true, it just has no effect now. */
  muted?: boolean;
  /** The control, given the id that the label points at and the id of the hint, if there is one. */
  children: (id: string, hintId: string | undefined) => ReactElement;
}

/** A labelled control. The label is not decoration: it is how the field is found. */
export function Field({ label, hint, muted = false, children }: FieldProps) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className={muted ? 'field field--muted' : 'field'}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, hintId)}
      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
