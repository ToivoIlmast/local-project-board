import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { Badge, Menu, type MenuItem } from '../../../shared/ui/index';
import { hasOwnSettings } from '../model/taskWorkflow';
import { useSendToAi } from '../model/useSendToAi';

export interface TaskCardProps {
  task: Task;
  statuses: string[];
  /** A change of this task is on its way to the board. */
  busy: boolean;
  dragging: boolean;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveTo: (id: string, status: string) => void;
  onNudge: (id: string, direction: -1 | 1) => void;
  onDragStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * One task on the board. Dragging is one way to move it; the menu is the other, because a
 * board that can only be used with a mouse cannot be used with a keyboard.
 */
export const TaskCard = memo(function TaskCard({
  task,
  statuses,
  busy,
  dragging,
  onOpen,
  onEdit,
  onDelete,
  onMoveTo,
  onNudge,
  onDragStart,
}: TaskCardProps) {
  const sendToAi = useSendToAi(task);
  const items: (MenuItem | 'separator')[] = [
    { label: 'Open', onSelect: () => onOpen(task.id) },
    { label: 'Edit', onSelect: () => onEdit(task.id) },
    'separator',
    ...sendToAi.items.map((item) => ({ ...item, label: `Send to AI: ${item.label}` })),
    'separator',
    { label: 'Move up', onSelect: () => onNudge(task.id, -1) },
    { label: 'Move down', onSelect: () => onNudge(task.id, 1) },
    ...statuses
      .filter((status) => status !== task.status)
      .map((status) => ({ label: `Move to ${status}`, onSelect: () => onMoveTo(task.id, status) })),
    'separator',
    { label: 'Delete', tone: 'danger' as const, onSelect: () => onDelete(task.id) },
  ];

  return (
    <li
      className={['card', dragging ? 'card--dragging' : '', busy ? 'card--busy' : '']
        .filter(Boolean)
        .join(' ')}
      data-task-id={task.id}
      onPointerDown={(event) => onDragStart(task.id, event)}
    >
      <div className="card__head">
        <button type="button" className="card__title" onClick={() => onOpen(task.id)}>
          {task.title}
        </button>
        <Menu label={`Actions for ${task.id}`} items={items} />
      </div>
      <div className="card__meta">
        <Badge>{task.id}</Badge>
        {task.labels.map((label) => (
          <Badge key={label} tone="accent">
            {label}
          </Badge>
        ))}
        {task.branch === undefined ? null : (
          <Badge tone="neutral" title="Branch">
            ⎇ {task.branch}
          </Badge>
        )}
        {task.aiRun === undefined ? null : (
          <Badge
            tone={
              task.aiRun.state === 'working'
                ? 'accent'
                : task.aiRun.state === 'finished'
                  ? 'neutral'
                  : 'warning'
            }
            title={`AI run: ${task.aiRun.state}`}
          >
            AI: {task.aiRun.state}
          </Badge>
        )}
        {hasOwnSettings(task.workflow) ? (
          <Badge tone="warning" title="This task has AI settings of its own">
            ⚙ AI settings
          </Badge>
        ) : null}
        {busy ? <span className="card__busy">saving…</span> : null}
      </div>
      {sendToAi.dialog === null ? null : (
        // A press inside the dialog is not the start of a drag of the card it is drawn in.
        <div onPointerDown={(event) => event.stopPropagation()}>{sendToAi.dialog}</div>
      )}
      {/* Always there, so that what is put into it is announced; empty, it takes no room. */}
      <p className="card__note" aria-live="polite">
        {sendToAi.done}
      </p>
      {sendToAi.error === undefined ? null : (
        <p className="card__note card__note--error" role="alert">
          {sendToAi.error}
        </p>
      )}
    </li>
  );
});
