import { useId, type ReactElement } from 'react';

export interface FieldProps {
  label: string;
  hint?: string | undefined;
  /** What the board refused in this field; it is read with the field, and says nothing when absent. */
  error?: string | undefined;
  /** Dims the field without disabling it: what it says is still true, it just has no effect now. */
  muted?: boolean;
  /**
   * The control, given the id that the label points at and what describes it: the ids of the
   * hint and of the error, if there are any. A control that is refused should also say `aria-invalid`.
   */
  children: (id: string, describedBy: string | undefined) => ReactElement;
}

/** A labelled control. The label is not decoration: it is how the field is found. */
export function Field({ label, hint, error, muted = false, children }: FieldProps) {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={muted ? 'field field--muted' : 'field'}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, describedBy)}
      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
