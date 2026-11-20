import { useRef, useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useT } from '../../../shared/i18n/index';
import { Badge, Button, ConfirmDialog, EmptyState, Panel } from '../../../shared/ui/index';
import { useTopicsT } from '../i18n';
import { TopicForm } from './TopicForm';

export interface TopicsPanelProps {
  onClose: () => void;
  /** A topic was deleted: the page drops a filter on it. */
  onDeleted: (id: string) => void;
}

/** The topics of the board: made, renamed and described here, deleted once nothing is in them. */
export function TopicsPanel({ onClose, onDeleted }: TopicsPanelProps) {
  const { state, store } = useBoard();
  const t = useTopicsT();
  const common = useT();
  // `new`, or the id of the topic being changed.
  const [form, setForm] = useState<'new' | string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useAsyncAction((id: string) => store.deleteTopic(id));
  const panelRef = useRef<HTMLDivElement>(null);
  const editing = state.topics.find((topic) => topic.id === form);

  /** The form is gone with the focus in it: it goes back to the button that opened it. */
  const closeForm = (): void => {
    const opened = form;
    setForm(null);
    queueMicrotask(() => {
      if (document.activeElement !== document.body && document.activeElement !== null) return;
      const selector = opened === 'new' ? '[data-new-topic]' : `[data-edit-topic="${opened}"]`;
      panelRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });
  };

  return (
    <Panel label={t('title')}>
      <div ref={panelRef}>
        <header className="panel__head">
          <h2 className="panel__title">{t('title')}</h2>
          <Button
            size="small"
            data-new-topic=""
            disabled={form !== null}
            onClick={() => setForm('new')}
          >
            {t('new')}
          </Button>
          <Button size="small" onClick={onClose}>
            {common('ui.close')}
          </Button>
        </header>

        {form === 'new' ? (
          <TopicForm key="new" onSave={(values) => store.createTopic(values)} onDone={closeForm} />
        ) : editing === undefined ? null : (
          <TopicForm
            key={editing.id}
            topic={editing}
            onSave={(values) => store.updateTopic(editing.id, values)}
            onDone={closeForm}
          />
        )}

        {state.topics.length === 0 ? (
          <EmptyState title={t('empty.title')}>
            <p>{t('empty.text', { action: t('new') })}</p>
          </EmptyState>
        ) : (
          <ul className="topics__list">
            {state.topics.map((topic) => (
              <li key={topic.id} className="topics__item">
                <Badge>{topic.id}</Badge>
                <span className="topics__title">{topic.title}</span>
                <Button
                  size="small"
                  data-edit-topic={topic.id}
                  aria-label={t('edit.label', { id: topic.id })}
                  disabled={form !== null}
                  onClick={() => setForm(topic.id)}
                >
                  {t('edit')}
                </Button>
                <Button
                  size="small"
                  aria-label={t('delete.label', { id: topic.id })}
                  onClick={() => {
                    remove.clearError();
                    setDeleting(topic.id);
                  }}
                >
                  {common('ui.delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {deleting === null ? null : (
          <ConfirmDialog
            title={t('delete.title', { id: deleting })}
            message={t('delete.message')}
            confirmLabel={common('ui.delete')}
            pending={remove.pending}
            error={remove.error}
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              void remove.run(deleting).then((ok) => {
                if (!ok) return;
                if (form === deleting) setForm(null);
                onDeleted(deleting);
                setDeleting(null);
              });
            }}
          />
        )}
      </div>
    </Panel>
  );
}
