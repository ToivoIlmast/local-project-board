import { useBoard } from '../../../api/react';
import type { Task } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { Markdown } from '../../../shared/lib/Markdown';
import { Badge, Button, Field, Select, Text } from '../../../shared/ui/index';
import { TaskDocuments } from '../../documents/index';

export interface TaskDetailsProps {
  task: Task;
  statuses: string[];
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** One task, everything about it, and the documents that belong to it. */
export function TaskDetails({ task, statuses, onEdit, onDelete, onClose }: TaskDetailsProps) {
  const { store } = useBoard();
  const setStatus = useAsyncAction((status: string) => store.updateTask(task.id, { status }));

  return (
    <aside className="panel" aria-label={`Task ${task.id}`}>
      <header className="panel__head">
        <h2 className="panel__title">{task.title}</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="panel__meta">
        <Badge>{task.id}</Badge>
        {task.labels.map((label) => (
          <Badge key={label} tone="accent">
            {label}
          </Badge>
        ))}
        {task.branch === undefined ? null : <Badge title="Branch">⎇ {task.branch}</Badge>}
      </div>

      <Field label="Status">
        {(id) => (
          <Select
            id={id}
            options={statuses}
            value={task.status}
            disabled={setStatus.pending}
            onChange={(event) => void setStatus.run(event.target.value)}
          />
        )}
      </Field>
      {setStatus.error === undefined ? null : (
        <p className="form__error" role="alert">
          {setStatus.error}
        </p>
      )}

      <Text tone="muted">
        Created {formatDate(task.createdAt)} · changed {formatDate(task.updatedAt)}
      </Text>

      <div className="panel__actions">
        <Button onClick={onEdit}>Edit</Button>
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>

      <div className="panel__body">
        {task.body.trim() === '' ? (
          <Text tone="muted">No description</Text>
        ) : (
          <Markdown>{task.body}</Markdown>
        )}
      </div>

      <TaskDocuments taskId={task.id} />
    </aside>
  );
}
