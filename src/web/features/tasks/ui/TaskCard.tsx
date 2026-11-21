import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import { launchState, type BlockingReason, type Task } from '../../../../contract/v1/index';
import { useStatusLabel, useT } from '../../../shared/i18n/index';
import { Badge, Menu, type MenuItem } from '../../../shared/ui/index';
import { useCardT } from '../i18n/card';
import { useReasonText } from '../model/useReasonText';
import { hasOwnSettings } from '../model/taskWorkflow';
import { useSendToAi } from '../model/useSendToAi';

export interface TaskCardProps {
  task: Task;
  /** Why the task may not start yet, as the board computed it; none means it may. */
  reasons: readonly BlockingReason[];
  statuses: string[];
  /** A change of this task is on its way to the board. */
  busy: boolean;
  dragging: boolean;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Takes the task off the board; it can be restored from its details. */
  onArchive: (id: string) => void;
  onMoveTo: (id: string, status: string) => void;
  onNudge: (id: string, direction: -1 | 1) => void;
  onDragStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
}

/** A run state in the language shown; one this page does not know is shown as the board sent it. */
function runStateLabel(t: ReturnType<typeof useCardT>, state: string): string {
  switch (state) {
    case 'working':
      return t('card.state.working');
    case 'finished':
      return t('card.state.finished');
    case 'failed':
      return t('card.state.failed');
    case 'needs-review':
      return t('card.state.needs-review');
    default:
      return state;
  }
}

/**
 * One task on the board. Dragging is one way to move it; the menu is the other, because a
 * board that can only be used with a mouse cannot be used with a keyboard.
 */
export const TaskCard = memo(function TaskCard({
  task,
  reasons,
  statuses,
  busy,
  dragging,
  onOpen,
  onEdit,
  onDelete,
  onArchive,
  onMoveTo,
  onNudge,
  onDragStart,
}: TaskCardProps) {
  const t = useCardT();
  const common = useT();
  const statusLabel = useStatusLabel();
  const reasonText = useReasonText();
  const sendToAi = useSendToAi(task, undefined, reasons);
  // ● and 🔒 can be shown together: a run that has started is not stopped (ADR-0032 §7).
  const launch = launchState(task, reasons);
  const blockedWhy = t('card.blocked', { reasons: reasons.map(reasonText).join('; ') });
  const aiState = task.aiRun === undefined ? '' : runStateLabel(t, task.aiRun.state);
  const items: (MenuItem | 'separator')[] = [
    { label: t('card.open'), onSelect: () => onOpen(task.id) },
    { label: t('card.edit'), onSelect: () => onEdit(task.id) },
    'separator',
    ...sendToAi.items.map((item) => ({
      ...item,
      label: t('card.sendToAi', { action: item.label }),
    })),
    'separator',
    { label: t('card.up'), onSelect: () => onNudge(task.id, -1) },
    { label: t('card.down'), onSelect: () => onNudge(task.id, 1) },
    ...statuses
      .filter((status) => status !== task.status)
      .map((status) => ({
        label: t('card.moveTo', { status: statusLabel(status) }),
        onSelect: () => onMoveTo(task.id, status),
      })),
    { label: t('card.archive'), onSelect: () => onArchive(task.id) },
    'separator',
    { label: common('ui.delete'), tone: 'danger' as const, onSelect: () => onDelete(task.id) },
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
        <Menu label={t('card.actions', { id: task.id })} items={items} />
      </div>
      <div className="card__meta">
        <Badge>{task.id}</Badge>
        {task.labels.map((label) => (
          <Badge key={label} tone="accent">
            {label}
          </Badge>
        ))}
        {task.branch === undefined ? null : (
          <Badge tone="neutral" title={t('card.branch')}>
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
            title={t('card.aiRun', { state: aiState })}
          >
            {t('card.aiBadge', { state: aiState })}
            {task.aiRun.runId !== undefined &&
            (task.aiRun.state === 'failed' || task.aiRun.state === 'needs-review')
              ? ` #${task.aiRun.runId}`
              : ''}
          </Badge>
        )}
        {launch.running ? (
          <Badge tone="accent" title={t('card.running')}>
            ●
          </Badge>
        ) : null}
        {launch.blocked ? (
          // Only the count is drawn; the reasons are the tooltip and the text for a reader.
          <Badge tone="warning" title={blockedWhy}>
            <span aria-hidden="true">🔒 {reasons.length}</span>
            <span className="visually-hidden">{blockedWhy}</span>
          </Badge>
        ) : null}
        {hasOwnSettings(task.workflow) ? (
          <Badge tone="warning" title={t('card.ownSettings')}>
            ⚙ {t('card.aiSettings')}
          </Badge>
        ) : null}
        {busy ? <span className="card__busy">{t('card.saving')}</span> : null}
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
