import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  pending?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Deleting is not undoable here, so it is always asked about first. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p>{message}</p>
      {error === undefined ? null : (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
