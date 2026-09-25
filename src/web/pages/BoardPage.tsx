import { useState } from 'react';
import { useBoard } from '../api/react';
import { Board, BoardHeader, ReadIssues, type MoveIntent } from '../features/board/index';
import { GitPanel } from '../features/git/index';
import { InstructionsPanel } from '../features/instructions';
import { ReportsPanel } from '../features/reports/index';
import { TaskDetails, TaskDialog } from '../features/tasks/index';
import { useAsyncAction } from '../shared/hooks/useAsyncAction';
import { useSearchParam } from '../shared/hooks/useSearchParam';
import { Button, ConfirmDialog, ErrorState, Panel, Spinner } from '../shared/ui/index';

type Panel = 'reports' | 'git' | 'instructions';

/**
 * The whole board in one screen: columns on the left, whatever is being looked at on the
 * right. What is open lives in the address bar, so a reload lands where you were.
 */
export function BoardPage() {
  const { state, store } = useBoard();
  const [openTaskId, setOpenTaskId] = useSearchParam('task');
  const [panel, setPanel] = useSearchParam('panel');
  const [creating, setCreating] = useState<{ status?: string | undefined } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const remove = useAsyncAction((id: string) => store.deleteTask(id));

  if (state.phase === 'loading') return <Spinner label="Loading the board…" />;

  const project = state.project;
  if (state.phase === 'failed' || project === undefined) {
    return (
      <ErrorState
        title="The board could not be read"
        message={state.error?.message ?? 'The board did not answer.'}
        onRetry={() => void store.load()}
      />
    );
  }

  const task = state.tasks.find((candidate) => candidate.id === openTaskId);
  const editing = state.tasks.find((candidate) => candidate.id === editingId);
  const show = (next: Panel): void => {
    setOpenTaskId(null);
    setPanel(next);
  };
  const open = (id: string): void => {
    setPanel(null);
    setOpenTaskId(id);
  };
  const move = (id: string, intent: MoveIntent): void => {
    store.moveTask(id, intent).catch((error: Error) => setNotice(error.message));
  };

  return (
    <div className="page">
      <BoardHeader
        project={project}
        git={state.git}
        connection={state.connection}
        onNewTask={() => setCreating({})}
        onReload={() => void store.load()}
        onShowPanel={show}
      />

      <ReadIssues issues={project.readIssues} />

      {state.error === undefined ? null : (
        <p className="notice" role="alert">
          {state.error.message}
          <Button size="small" onClick={() => void store.load()}>
            Try again
          </Button>
        </p>
      )}

      {notice === undefined ? null : (
        <p className="notice" role="alert">
          {notice}
          <Button size="small" onClick={() => setNotice(undefined)}>
            Dismiss
          </Button>
        </p>
      )}

      <div className="page__body">
        <main className="page__board">
          <Board
            project={project}
            tasks={state.tasks}
            busy={state.busy}
            onOpen={open}
            onEdit={setEditingId}
            onDelete={setDeletingId}
            onCreate={(status) => setCreating({ status })}
            onMove={move}
          />
        </main>

        {task !== undefined ? (
          <TaskDetails
            key={task.id}
            task={task}
            statuses={project.statuses}
            onEdit={() => setEditingId(task.id)}
            onDelete={() => setDeletingId(task.id)}
            onClose={() => setOpenTaskId(null)}
          />
        ) : openTaskId !== null ? (
          <Panel label="Task">
            <ErrorState
              title="This task is not on the board"
              message="It may have been deleted while this page was open."
              onRetry={() => setOpenTaskId(null)}
              retryLabel="Close"
            />
          </Panel>
        ) : panel === 'reports' ? (
          <ReportsPanel onClose={() => setPanel(null)} />
        ) : panel === 'git' ? (
          <GitPanel onClose={() => setPanel(null)} />
        ) : panel === 'instructions' ? (
          <InstructionsPanel onClose={() => setPanel(null)} />
        ) : null}
      </div>

      {creating === null ? null : (
        <TaskDialog
          statuses={project.statuses}
          defaultStatus={creating.status}
          onClose={() => setCreating(null)}
          onCreated={open}
        />
      )}

      {editing === undefined ? null : (
        <TaskDialog statuses={project.statuses} task={editing} onClose={() => setEditingId(null)} />
      )}

      {deletingId === null ? null : (
        <ConfirmDialog
          title={`Delete ${deletingId}?`}
          message="The task and its documents are removed from the board. This cannot be undone."
          confirmLabel="Delete"
          pending={remove.pending}
          error={remove.error}
          onCancel={() => setDeletingId(null)}
          onConfirm={() => {
            void remove.run(deletingId).then((ok) => {
              if (!ok) return;
              if (openTaskId === deletingId) setOpenTaskId(null);
              setDeletingId(null);
            });
          }}
        />
      )}
    </div>
  );
}
