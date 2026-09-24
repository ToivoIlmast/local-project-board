import { useBoard } from '../../../api/react';
import type { Task } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Modal } from '../../../shared/ui/index';
import { TaskForm, type TaskValues } from './TaskForm';

export interface TaskDialogProps {
  statuses: string[];
  /** Absent when a task is being created. */
  task?: Task | undefined;
  defaultStatus?: string | undefined;
  onClose: () => void;
  onCreated?: ((id: string) => void) | undefined;
}

/** Creating and editing are the same form; only where it is sent differs. */
export function TaskDialog({ statuses, task, defaultStatus, onClose, onCreated }: TaskDialogProps) {
  const { store } = useBoard();

  const save = useAsyncAction(async (values: TaskValues) => {
    if (task === undefined) {
      const created = await store.createTask({
        title: values.title,
        status: values.status,
        body: values.body,
        labels: values.labels,
        ...(values.branch === undefined ? {} : { branch: values.branch }),
      });
      onCreated?.(created.id);
      return;
    }
    await store.updateTask(task.id, {
      title: values.title,
      status: values.status,
      body: values.body,
      labels: values.labels,
      branch: values.branch ?? null,
    });
  });

  return (
    <Modal
      title={task === undefined ? 'New task' : `Edit ${task.id}`}
      onClose={onClose}
      width="wide"
    >
      <TaskForm
        statuses={statuses}
        task={task}
        defaultStatus={defaultStatus}
        submitLabel={task === undefined ? 'Create' : 'Save'}
        pending={save.pending}
        error={save.error}
        onCancel={onClose}
        onSubmit={(values) => {
          void save.run(values).then((ok) => ok && onClose());
        }}
      />
    </Modal>
  );
}
