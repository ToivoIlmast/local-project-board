import { useRef, useState, type ReactNode } from 'react';
import { useBoard } from '../../../api/react';
import type { FromCheck, Task } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Modal } from '../../../shared/ui/index';
import type { TaskDraft } from '../model/history';
import { placementRefusal, type FieldErrors, type PlacementField } from '../model/placement';
import { EditReview } from './EditReview';
import { TaskForm, type TaskValues } from './TaskForm';

export interface TaskDialogProps {
  statuses: string[];
  /** Absent when a task is being created. */
  task?: Task | undefined;
  defaultStatus?: string | undefined;
  onClose: () => void;
  onCreated?: ((id: string) => void) | undefined;
  /** What the form starts with instead of the task's own, e.g. the recommendations applied. */
  draft?: Partial<TaskValues> | undefined;
  /** Recorded on the version this save makes, when it came from a check (ADR-0030 §7). */
  fromCheck?: FromCheck | undefined;
  /** What is shown beside the form: the recommendations being applied or reconciled. */
  aside?: ReactNode;
  title?: string | undefined;
}

/**
 * Creating and editing are the same form; only where it is sent differs. A new task is created
 * at once. An existing one is saved in two steps (T46): the form, then a review of the draft as
 * a diff against the task's current content, with Save and Cancel.
 */
export function TaskDialog({
  statuses,
  task,
  defaultStatus,
  onClose,
  onCreated,
  draft,
  fromCheck,
  aside,
  title,
}: TaskDialogProps) {
  const { store } = useBoard();
  const createdRef = useRef<string | undefined>(undefined);
  // The task the person started from, kept: their changes are measured against it, even when
  // the task moves under them.
  const [original] = useState(task);
  const [reviewing, setReviewing] = useState<TaskValues | undefined>(undefined);
  const [kept, setKept] = useState<TaskValues | undefined>(undefined);
  // What the board refused in the topic, the block or the dependencies, said at that field.
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const create = useAsyncAction(async (values: TaskValues) => {
    setFieldErrors({});
    try {
      const created = await store.createTask({
        title: values.title,
        status: values.status,
        body: values.body,
        labels: values.labels,
        ...(values.branch === undefined ? {} : { branch: values.branch }),
        ...(values.topic === undefined ? {} : { topic: values.topic }),
        ...(values.block === undefined ? {} : { block: values.block }),
        ...(values.dependsOn === undefined || values.dependsOn.length === 0
          ? {}
          : { dependsOn: values.dependsOn }),
      });
      createdRef.current = created.id;
    } catch (error) {
      const refusal = placementRefusal(error);
      if (refusal !== undefined) setFieldErrors(refusal);
      throw error;
    }
  });

  const forget = (field: PlacementField): void => {
    setFieldErrors(({ [field]: _gone, ...rest }) => rest);
    // What the board said was about the entry that has just been changed.
    create.clearError();
  };
  const refused = Object.keys(fieldErrors).length > 0;

  const dialogTitle = title ?? (task === undefined ? 'New task' : `Edit ${task.id}`);

  return (
    <Modal title={dialogTitle} onClose={onClose} width="wide">
      <div className={aside === undefined ? undefined : 'with-aside'}>
        <div className="with-aside__main">
          {task !== undefined && original !== undefined && reviewing !== undefined ? (
            <EditReview
              task={task}
              original={original}
              draft={toDraft(reviewing)}
              placement={{
                topic: reviewing.topic,
                block: reviewing.block,
                dependsOn: reviewing.dependsOn ?? [],
              }}
              onRefused={(errors) => {
                // Back to the form with everything entered, and the refusal at its field.
                setKept(reviewing);
                setReviewing(undefined);
                setFieldErrors(errors);
              }}
              fromCheck={fromCheck}
              onBack={() => {
                setKept(reviewing);
                setReviewing(undefined);
              }}
              onCancel={onClose}
              onSaved={onClose}
            />
          ) : (
            <TaskForm
              statuses={statuses}
              task={task}
              initial={kept ?? draft}
              defaultStatus={defaultStatus}
              submitLabel={task === undefined ? 'Create' : 'Review changes'}
              pending={create.pending}
              error={refused ? undefined : create.error}
              fieldErrors={fieldErrors}
              onFieldEdited={forget}
              onCancel={onClose}
              onSubmit={(values) => {
                if (task !== undefined) {
                  setFieldErrors({});
                  setReviewing(values);
                  return;
                }
                void create.run(values).then((ok) => {
                  if (!ok) return;
                  // Closed first: the focus is back on what opened the dialog by the time the
                  // new task's panel asks for it.
                  onClose();
                  if (createdRef.current !== undefined) onCreated?.(createdRef.current);
                });
              }}
            />
          )}
        </div>
        {aside === undefined ? null : <aside className="with-aside__side">{aside}</aside>}
      </div>
    </Modal>
  );
}

function toDraft(values: TaskValues): TaskDraft {
  return {
    title: values.title,
    status: values.status,
    labels: values.labels,
    branch: values.branch,
    body: values.body,
  };
}
