import { Button } from './Button';
import { Modal } from './Modal';

export interface UnsavedChangesDialogProps {
  message: string;
  /** Why the last Save did not work; the dialog stays, so the person can try again or choose. */
  error?: string | undefined;
  /** A note that changes what Save means, said before the choice is made. */
  note?: string | undefined;
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * The one question every form asks before it is left with changes in it: save them, throw them
 * away, or stay. Save is first, and where the focus starts: it is the choice that loses nothing.
 */
export function UnsavedChangesDialog({
  message,
  error,
  note,
  pending,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  return (
    <Modal
      title="Unsaved changes"
      // While a save is on its way the way out is closed: an answer that arrives after the
      // dialog was dismissed would go on without having been asked for.
      onClose={pending ? () => undefined : onCancel}
      footer={
        <>
          <Button variant="primary" onClick={onSave} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          <Button onClick={onDiscard} disabled={pending}>
            Discard
          </Button>
          <Button onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </>
      }
    >
      <p>{message}</p>
      {note === undefined ? null : <p>{note}</p>}
      {error === undefined ? null : (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
