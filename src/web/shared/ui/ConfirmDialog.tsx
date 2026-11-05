import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  /** `danger` for what cannot be undone; `primary` for a change that can. */
  confirmVariant?: 'danger' | 'primary';
  /** What else the question shows, under the message: reasons, the old and the new. */
  children?: ReactNode;
  pending?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** What cannot be undone here, or should not be done by accident, is asked about first. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmVariant = 'danger',
  children,
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
          <Button variant={confirmVariant} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p>{message}</p>
      {children}
      {error === undefined ? null : (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
