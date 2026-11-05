import { useEffect, useMemo, useRef, useState } from 'react';
import { columnsOf } from '../../../api/index';
import {
  launchState,
  type BlockingReason,
  type Project,
  type Task,
} from '../../../../contract/v1/index';
import { ConfirmDialog, EmptyState } from '../../../shared/ui/index';
import { TaskCard, needsStatusConfirmation, reasonText } from '../../tasks/index';
import { intentFor, isNoop, type MoveIntent } from '../model/dnd';
import { useDrag } from '../model/useDrag';
import { Column } from './Column';

/** One empty list for every task without reasons, so a card is not drawn again for nothing. */
const NONE: readonly BlockingReason[] = [];

export interface BoardProps {
  project: Project;
  tasks: Task[];
  /** The reasons of each task not to start yet, by id. */
  readiness: Record<string, BlockingReason[]>;
  busy: string[];
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: (status: string) => void;
  /** Where the card should go, said the way the API takes it; the server ranks it. */
  onMove: (id: string, intent: MoveIntent) => void;
  /** The tasks are a filter's, not the board's: none of them is not "no tasks yet". */
  filtered?: boolean;
}

/**
 * The board itself: the configured statuses as columns, each card in its own. A card that
 * the board has no column for is not hidden — the page says so above (ADR-0022 in spirit).
 */
export function Board({
  project,
  tasks,
  readiness,
  busy,
  onOpen,
  onEdit,
  onDelete,
  onCreate,
  onMove,
  filtered = false,
}: BoardProps) {
  const { columns, orphans } = useMemo(() => columnsOf(project, tasks), [project, tasks]);
  /** A status change of a blocked task that waits for the answer to "are you sure"; nothing is sent. */
  const [asking, setAsking] = useState<{ id: string; intent: MoveIntent; follow: boolean } | null>(
    null,
  );
  const blocked = tasks.filter((task) => launchState(task, readiness[task.id] ?? NONE).blocked);

  /**
   * Whether a move was sent: a drop that changes nothing is not a change, so nothing is. A
   * different status for a blocked task is asked about first, whichever way it came (a drop, the
   * menu); staying in the column is a reorder and asks nothing (ADR-0032 §8).
   */
  const move = (id: string, status: string, index: number, follow = false): boolean => {
    const column = columns.find((candidate) => candidate.status === status);
    const task = tasks.find((candidate) => candidate.id === id);
    if (!column || !task) return false;
    const intent = intentFor(column.tasks, id, index, status);
    if (isNoop(task, column.tasks, intent)) return false;
    if (needsStatusConfirmation(task, readiness[id] ?? NONE, intent.status)) {
      setAsking({ id, intent, follow });
      return false;
    }
    onMove(id, intent);
    return true;
  };

  const { drag, onPointerDown, registerColumn } = useDrag({ onDrop: move });

  // A card moved from its menu lands somewhere else in the DOM, and the button that was
  // focused goes with the old place. Once the board has settled, the focus follows the card.
  const followedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = followedRef.current;
    if (id === null || busy.includes(id)) return;
    followedRef.current = null;
    document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"] .card__title`)?.focus();
  }, [busy, tasks]);

  const nudge = (id: string, direction: -1 | 1): void => {
    const task = tasks.find((candidate) => candidate.id === id);
    const column = columns.find((candidate) => candidate.status === task?.status);
    if (!task || !column) return;
    const index = column.tasks.findIndex((candidate) => candidate.id === id) + direction;
    if (move(id, task.status, Math.max(0, Math.min(index, column.tasks.length - 1)))) {
      followedRef.current = id;
    }
  };

  const moveTo = (id: string, status: string): void => {
    const column = columns.find((candidate) => candidate.status === status);
    if (move(id, status, column?.tasks.length ?? 0, true)) followedRef.current = id;
  };

  const asked = asking === null ? undefined : tasks.find((task) => task.id === asking.id);

  return (
    <>
      {orphans.length === 0 ? null : (
        <p className="board__orphans">
          {orphans.length === 1
            ? '1 task has a status this board does not have'
            : `${orphans.length} tasks have a status this board does not have`}
          : {orphans.map((task) => `${task.id} (${task.status})`).join(', ')}
        </p>
      )}

      {tasks.length === 0 ? (
        filtered ? (
          <EmptyState title="No tasks match this filter" />
        ) : (
          <EmptyState title="No tasks yet">
            <p>Create one with “New task”, or let an agent create it through the API.</p>
          </EmptyState>
        )
      ) : null}

      {blocked.length === 0 ? null : (
        <p
          className="board__blocked"
          role="status"
          aria-label={`${blocked.length} blocked ${blocked.length === 1 ? 'task' : 'tasks'}`}
        >
          <span aria-hidden="true">🔒 {blocked.length}</span>
        </p>
      )}

      <div className="board">
        {columns.map((column) => (
          <Column
            key={column.status}
            status={column.status}
            count={column.tasks.length}
            dropIndex={drag?.status === column.status ? drag.index : null}
            onAdd={onCreate}
            columnRef={registerColumn(column.status)}
          >
            {column.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                reasons={readiness[task.id] ?? NONE}
                statuses={project.statuses}
                busy={busy.includes(task.id)}
                dragging={drag?.id === task.id}
                onOpen={onOpen}
                onEdit={onEdit}
                onDelete={onDelete}
                onMoveTo={moveTo}
                onNudge={nudge}
                onDragStart={onPointerDown}
              />
            ))}
          </Column>
        ))}
      </div>

      {asking === null || asked === undefined ? null : (
        <ConfirmDialog
          title={`Change the status of ${asked.id}?`}
          message={`${asked.id} is blocked. Change its status from ${asked.status} to ${asking.intent.status} by hand? The board will not stop you.`}
          confirmLabel="Change status"
          confirmVariant="primary"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            if (asking.follow) followedRef.current = asked.id;
            onMove(asked.id, asking.intent);
            setAsking(null);
          }}
        >
          <ul>
            {(readiness[asked.id] ?? NONE).map((reason) => (
              <li key={reasonText(reason)}>{reasonText(reason)}</li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}
