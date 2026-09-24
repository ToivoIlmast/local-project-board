export interface SpinnerProps {
  label: string;
}

/** A wait the user can read, not a spinning shape they have to guess at. */
export function Spinner({ label }: SpinnerProps) {
  return (
    <p className="spinner" role="status">
      <span className="spinner__dot" aria-hidden="true" />
      {label}
    </p>
  );
}
