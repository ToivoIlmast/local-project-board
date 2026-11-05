import { useRef, useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Badge, Button, ConfirmDialog, EmptyState, Panel } from '../../../shared/ui/index';
import { TopicForm } from './TopicForm';

export interface TopicsPanelProps {
  onClose: () => void;
  /** A topic was deleted: the page drops a filter on it. */
  onDeleted: (id: string) => void;
}

/** The topics of the board: made, renamed and described here, deleted once nothing is in them. */
export function TopicsPanel({ onClose, onDeleted }: TopicsPanelProps) {
  const { state, store } = useBoard();
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
    <Panel label="Topics">
      <div ref={panelRef}>
        <header className="panel__head">
          <h2 className="panel__title">Topics</h2>
          <Button
            size="small"
            data-new-topic=""
            disabled={form !== null}
            onClick={() => setForm('new')}
          >
            New topic
          </Button>
          <Button size="small" onClick={onClose}>
            Close
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
          <EmptyState title="No topics">
            <p>A topic groups the tasks of one piece of work. Create one with “New topic”.</p>
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
                  aria-label={`Edit ${topic.id}`}
                  disabled={form !== null}
                  onClick={() => setForm(topic.id)}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  aria-label={`Delete ${topic.id}`}
                  onClick={() => {
                    remove.clearError();
                    setDeleting(topic.id);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}

        {deleting === null ? null : (
          <ConfirmDialog
            title={`Delete ${deleting}?`}
            message="The topic is removed from the board. It can only be deleted when it has no tasks and no blocks. This cannot be undone."
            confirmLabel="Delete"
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
