import { useEffect, useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useT } from '../../../shared/i18n/index';
import { formatSize } from '../../../shared/lib/format';
import { Button, ConfirmDialog, EmptyState, Modal, Spinner } from '../../../shared/ui/index';
import { useDocumentT } from '../i18n';
import { DocumentEditor } from './DocumentEditor';
import { DocumentView } from './DocumentView';

export interface TaskDocumentsProps {
  taskId: string;
}

/** The files that belong to one task: notes, plans, whatever an agent left there (§10). */
export function TaskDocuments({ taskId }: TaskDocumentsProps) {
  const { state, store, client } = useBoard();
  const t = useDocumentT();
  const common = useT();
  const documents = state.documents[taskId];
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name?: string; content: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [listFailure, setListFailure] = useState<string | undefined>(undefined);

  const write = useAsyncAction((name: string, content: string) =>
    store.writeDocument(taskId, name, content),
  );
  const remove = useAsyncAction((name: string) => store.deleteDocument(taskId, name));

  // Mounted per task (the panel is keyed by it), so this reads them once, for this task.
  useEffect(() => {
    store.loadDocuments(taskId).catch((error: Error) => setListFailure(error.message));
  }, [store, taskId]);

  const edit = async (name: string): Promise<void> => {
    try {
      setEditing({ name, content: await client.readDocument(taskId, name) });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('docs.readFailed'));
    }
  };

  return (
    <section className="documents" aria-label={t('docs.title')}>
      <header className="documents__head">
        <h3 className="documents__title">{t('docs.title')}</h3>
        <Button size="small" onClick={() => setEditing({ content: '' })}>
          {t('docs.new')}
        </Button>
      </header>

      {failure !== undefined ? <p className="form__error">{failure}</p> : null}
      {/* Only while there is no list: the store reads it again when the board comes back. */}
      {listFailure !== undefined && documents === undefined ? (
        <p className="form__error">{listFailure}</p>
      ) : null}

      {documents === undefined ? (
        <Spinner label={t('docs.loading')} />
      ) : documents.length === 0 ? (
        <EmptyState title={t('docs.empty')} />
      ) : (
        <ul className="documents__list">
          {documents.map((document) => (
            <li key={document.name} className="documents__item">
              <button
                type="button"
                className="documents__open"
                onClick={() => setOpen(open === document.name ? null : document.name)}
              >
                {document.name}
              </button>
              <span className="documents__size">{formatSize(document.size)}</span>
              <Button
                size="small"
                aria-label={t('docs.editName', { name: document.name })}
                onClick={() => void edit(document.name)}
              >
                {t('docs.edit')}
              </Button>
              <Button
                size="small"
                aria-label={t('docs.deleteName', { name: document.name })}
                onClick={() => setDeleting(document.name)}
              >
                {common('ui.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open === null ? null : (
        // Keyed by the document: opening another one starts from nothing, not from this one.
        <DocumentView key={open} taskId={taskId} name={open} onClose={() => setOpen(null)} />
      )}

      {editing === null ? null : (
        <Modal
          title={
            editing.name === undefined ? t('docs.new') : t('docs.editName', { name: editing.name })
          }
          onClose={() => setEditing(null)}
          width="wide"
        >
          <DocumentEditor
            name={editing.name}
            initialContent={editing.content}
            pending={write.pending}
            error={write.error}
            onCancel={() => setEditing(null)}
            onSubmit={(name, content) => {
              void write.run(name, content).then((ok) => ok && setEditing(null));
            }}
          />
        </Modal>
      )}

      {deleting === null ? null : (
        <ConfirmDialog
          title={t('docs.deleteTitle', { name: deleting })}
          message={t('docs.deleteMessage')}
          confirmLabel={common('ui.delete')}
          pending={remove.pending}
          error={remove.error}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void remove.run(deleting).then((ok) => {
              if (!ok) return;
              if (open === deleting) setOpen(null);
              setDeleting(null);
            });
          }}
        />
      )}
    </section>
  );
}
