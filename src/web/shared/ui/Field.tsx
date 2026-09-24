import { useId, type ReactElement } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  /** The control, given the id that the label points at. */
  children: (id: string) => ReactElement;
}

/** A labelled control. The label is not decoration: it is how the field is found. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint === undefined ? null : <p className="field__hint">{hint}</p>}
    </div>
  );
}
