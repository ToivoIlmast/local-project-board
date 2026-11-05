import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Topic } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Button, ConfirmDialog, Field, Input, Menu, Modal, Select } from '../../../shared/ui/index';

type Block = Topic['blocks'][number];
type Dialog = 'rename' | 'add' | 'move' | 'delete';

export interface BlockMenuProps {
  topic: Topic;
  block: Block;
  /** Where the block is in its topic, from 0. */
  position: number;
  onDeleted: () => void;
}

/**
 * What can be done to a block: rename it, add one after the last of its topic, give it another
 * place, delete it. Each is a form or a question and one request; the page shows what the
 * board answered. The dialogs are at the end of the page, not between the headings of the blocks.
 * The menu is a button with a name of its own, so a screen reader can tell them apart.
 */
export function BlockMenu({ topic, block, position, onDeleted }: BlockMenuProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = (): void => setDialog(null);

  return (
    <>
      <Menu
        label={`Block ${block.id} actions`}
        items={[
          { label: 'Rename', onSelect: () => setDialog('rename') },
          { label: 'Add block', onSelect: () => setDialog('add') },
          { label: 'Move to position', onSelect: () => setDialog('move') },
          { label: 'Delete', tone: 'danger', onSelect: () => setDialog('delete') },
        ]}
      />
      {dialog === null
        ? null
        : createPortal(
            <>
              {dialog === 'rename' ? (
                <RenameDialog topic={topic} block={block} onDone={close} />
              ) : null}
              {dialog === 'add' ? <AddDialog topic={topic} onDone={close} /> : null}
              {dialog === 'move' ? (
                <MoveDialog topic={topic} block={block} position={position} onDone={close} />
              ) : null}
              {dialog === 'delete' ? (
                <DeleteDialog
                  topic={topic}
                  block={block}
                  onDone={close}
                  onDeleted={() => {
                    onDeleted();
                    close();
                  }}
                />
              ) : null}
            </>,
            document.body,
          )}
    </>
  );
}

interface TitleDialogProps {
  heading: string;
  initial: string;
  submitLabel: string;
  pendingLabel: string;
  /** Resolves when the board took it, rejects with its own message. */
  onSave: (title: string) => Promise<unknown>;
  onDone: () => void;
}

function TitleDialog({
  heading,
  initial,
  submitLabel,
  pendingLabel,
  onSave,
  onDone,
}: TitleDialogProps) {
  const [title, setTitle] = useState(initial);
  const saving = useAsyncAction(async () => {
    await onSave(title.trim());
  });
  const blank = title.trim() === '';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving.pending || blank) return;
    void saving.run().then((ok) => {
      if (ok) onDone();
    });
  };

  return (
    <Modal title={heading} onClose={onDone}>
      <form className="form" onSubmit={submit}>
        <Field label="Title">
          {(id) => (
            <Input
              id={id}
              value={title}
              required
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        {saving.error === undefined ? null : (
          <p className="form__error" role="alert">
            {saving.error}
          </p>
        )}
        <div className="form__actions">
          <Button onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving.pending || blank}>
            {saving.pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDialog({
  topic,
  block,
  onDone,
}: {
  topic: Topic;
  block: Block;
  onDone: () => void;
}) {
  const { store } = useBoard();
  return (
    <TitleDialog
      heading={`Rename ${block.id}`}
      initial={block.title}
      submitLabel="Save"
      pendingLabel="Saving…"
      onSave={(title) => store.updateBlock(topic.id, block.id, title)}
      onDone={onDone}
    />
  );
}

function AddDialog({ topic, onDone }: { topic: Topic; onDone: () => void }) {
  const { store } = useBoard();
  return (
    <TitleDialog
      heading={`Add a block to ${topic.id}`}
      initial=""
      submitLabel="Add"
      pendingLabel="Adding…"
      onSave={(title) => store.createBlock(topic.id, title)}
      onDone={onDone}
    />
  );
}

function MoveDialog({
  topic,
  block,
  position,
  onDone,
}: {
  topic: Topic;
  block: Block;
  position: number;
  onDone: () => void;
}) {
  const { store } = useBoard();
  const [target, setTarget] = useState(position);
  const moving = useAsyncAction(async () => {
    const others = topic.blocks.filter((other) => other.id !== block.id).map((other) => other.id);
    const order = [...others.slice(0, target), block.id, ...others.slice(target)];
    await store.reorderBlocks(topic.id, order);
  });
  const unchanged = target === position;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (moving.pending || unchanged) return;
    void moving.run().then((ok) => {
      if (ok) onDone();
    });
  };

  return (
    <Modal title={`Move ${block.id}`} onClose={onDone}>
      <form className="form" onSubmit={submit}>
        <Field label="Position" hint={`Of ${topic.blocks.length} blocks in ${topic.id}`}>
          {(id, describedBy) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={String(target + 1)}
              options={topic.blocks.map((_, index) => String(index + 1))}
              onChange={(event) => setTarget(Number(event.target.value) - 1)}
            />
          )}
        </Field>
        {moving.error === undefined ? null : (
          <p className="form__error" role="alert">
            {moving.error}
          </p>
        )}
        <div className="form__actions">
          <Button onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={moving.pending || unchanged}>
            {moving.pending ? 'Moving…' : 'Move'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({
  topic,
  block,
  onDone,
  onDeleted,
}: {
  topic: Topic;
  block: Block;
  onDone: () => void;
  onDeleted: () => void;
}) {
  const { store } = useBoard();
  const remove = useAsyncAction(() => store.deleteBlock(topic.id, block.id));
  return (
    <ConfirmDialog
      title={`Delete ${block.id}?`}
      message={`The block “${block.title}” is removed from ${topic.id}. A block that has tasks cannot be deleted. This cannot be undone.`}
      confirmLabel="Delete"
      pending={remove.pending}
      error={remove.error}
      onCancel={onDone}
      onConfirm={() => {
        void remove.run().then((ok) => {
          if (ok) onDeleted();
        });
      }}
    />
  );
}
