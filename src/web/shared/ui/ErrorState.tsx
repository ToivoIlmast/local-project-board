import { Button } from './Button';

export interface ErrorStateProps {
  title: string;
  message: string;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}

/** A failure is a screen of its own: never an empty page, never a blank panel. */
export function ErrorState({ title, message, onRetry, retryLabel = 'Try again' }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <p className="error-state__title">{title}</p>
      <p className="error-state__message">{message}</p>
      {onRetry === undefined ? null : (
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
