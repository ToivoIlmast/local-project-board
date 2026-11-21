import { useEffect, useState } from 'react';
import { useBoard } from '../api/react';
import {
  Board,
  BoardHeader,
  NO_TOPIC,
  ReadIssues,
  TopicFilter,
  ViewSwitch,
  filterByTopic,
  type MoveIntent,
  type View,
  useBoardT,
} from '../features/board/index';
import { ArchivePage } from '../features/archive/index';
import { BlocksView } from '../features/blocks/index';
import { GitPanel } from '../features/git/index';
import { InstructionsPanel } from '../features/instructions';
import { ReportsPanel } from '../features/reports/index';
import { SettingsPanel } from '../features/settings/index';
import { TaskDetails, TaskDialog } from '../features/tasks/index';
import { TopicsPanel } from '../features/topics/index';
import { useAsyncAction } from '../shared/hooks/useAsyncAction';
import { useT } from '../shared/i18n/index';
import { UnsavedChangesProvider, useLeaveGuard } from '../shared/hooks/unsavedChanges';
import { replaceSearchParams, useSearchParam } from '../shared/hooks/useSearchParam';
import { Button, ConfirmDialog, ErrorState, Panel, Spinner } from '../shared/ui/index';

type Panel = 'reports' | 'topics' | 'git' | 'instructions' | 'settings';

/**
 * The whole board in one screen: columns on the left, whatever is being looked at on the
 * right. What is open lives in the address bar, so a reload lands where you were. A form in the
 * panel that holds changes is asked about before the panel is left (`UnsavedChangesProvider`).
 */
export function BoardPage() {
  return (
    <UnsavedChangesProvider>
      <BoardScreen />
    </UnsavedChangesProvider>
  );
}

function BoardScreen() {
  const t = useBoardT();
  const common = useT();
  const { state, store } = useBoard();
  const leave = useLeaveGuard();
  const [openTaskId, setOpenTaskId] = useSearchParam('task');
  const [panel, setPanel] = useSearchParam('panel');
  const [topicFilter, setTopicFilter] = useSearchParam('topic');
  const [viewParam, setViewParam] = useSearchParam('view');
  // `?panel=blocks` was the Blocks of T91, before they had the main area: it is the view now.
  const legacyBlocks = panel === 'blocks';
  const view: View =
    viewParam === 'archive'
      ? 'archive'
      : viewParam === 'blocks' || legacyBlocks
        ? 'blocks'
        : 'board';
  const [creating, setCreating] = useState<{ status?: string | undefined } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const remove = useAsyncAction((id: string) => store.deleteTask(id));

  useEffect(() => {
    if (legacyBlocks) replaceSearchParams({ panel: null, view: 'blocks' });
  }, [legacyBlocks]);

  if (state.phase === 'loading') return <Spinner label={t('page.loading')} />;

  const project = state.project;
  if (state.phase === 'failed' || project === undefined) {
    return (
      <ErrorState
        title={t('page.failed.title')}
        message={state.error?.message ?? t('page.failed.silent')}
        onRetry={() => void store.load()}
      />
    );
  }

  const task = state.tasks.find((candidate) => candidate.id === openTaskId);
  // A topic in the address that the board does not have is said, not shown as an empty board.
  const missingTopic =
    topicFilter !== null &&
    topicFilter !== NO_TOPIC &&
    !state.topics.some((topic) => topic.id === topicFilter);
  const editing = state.tasks.find((candidate) => candidate.id === editingId);
  // Every way out of the panel goes through `leave`: it asks if a form in the panel holds
  // changes, and goes straight on if not. Looking at what is already open is not a way out.
  const show = (next: Panel): void => {
    if (openTaskId === null && panel === next) return;
    leave(() => {
      setOpenTaskId(null);
      setPanel(next);
    });
  };
  const open = (id: string): void => {
    const go = (): void => {
      setPanel(null);
      setOpenTaskId(id);
    };
    if (id === openTaskId) go();
    else leave(go);
  };
  const closePanel = (): void => leave(() => setPanel(null));
  // The task leaves the board when the answer arrives; a refusal (409) is said, not swallowed.
  const archive = (id: string): void => {
    store.archiveTask(id).catch((error: Error) => setNotice(error.message));
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
        onShowArchive={() => {
          if (view !== 'archive') setViewParam('archive');
        }}
        archiveOpen={view === 'archive'}
      />

      <ReadIssues issues={project.readIssues} />

      {state.error === undefined ? null : (
        <p className="notice" role="alert">
          {state.error.message}
          <Button size="small" onClick={() => void store.load()}>
            {common('ui.tryAgain')}
          </Button>
        </p>
      )}

      {missingTopic ? (
        <p className="notice" role="alert">
          {t('page.topicMissing', { topic: topicFilter })}
          <Button size="small" onClick={() => setTopicFilter(null)}>
            {t('page.showAll')}
          </Button>
        </p>
      ) : null}

      {notice === undefined ? null : (
        <p className="notice" role="alert">
          {notice}
          <Button size="small" onClick={() => setNotice(undefined)}>
            {common('ui.dismiss')}
          </Button>
        </p>
      )}

      <div className="page__controls">
        <ViewSwitch
          value={view}
          onChange={(next) => setViewParam(next === 'blocks' ? 'blocks' : null)}
        />
        {view === 'archive' ? null : (
          <TopicFilter topics={state.topics} value={topicFilter} onChange={setTopicFilter} />
        )}
      </div>

      <div className="page__body">
        <main className="page__board">
          {view === 'archive' ? (
            <ArchivePage onOpen={open} />
          ) : view === 'blocks' ? (
            <BlocksView topicFilter={topicFilter} onOpen={open} />
          ) : (
            <Board
              project={project}
              tasks={filterByTopic(state.tasks, topicFilter)}
              filtered={topicFilter !== null}
              readiness={state.readiness}
              busy={state.busy}
              onOpen={open}
              onEdit={setEditingId}
              onDelete={setDeletingId}
              onArchive={archive}
              onCreate={(status) => setCreating({ status })}
              onMove={move}
            />
          )}
        </main>

        {task !== undefined ? (
          <TaskDetails
            key={task.id}
            task={task}
            statuses={project.statuses}
            onEdit={() => setEditingId(task.id)}
            onDelete={() => setDeletingId(task.id)}
            onClose={() => leave(() => setOpenTaskId(null))}
          />
        ) : openTaskId !== null ? (
          <Panel label={t('page.task')}>
            <ErrorState
              title={t('page.taskMissing.title')}
              message={t('page.taskMissing.message')}
              onRetry={() => setOpenTaskId(null)}
              retryLabel={common('ui.close')}
            />
          </Panel>
        ) : panel === 'reports' ? (
          <ReportsPanel onClose={closePanel} />
        ) : panel === 'topics' ? (
          <TopicsPanel
            onClose={closePanel}
            onDeleted={(id) => {
              if (topicFilter === id) setTopicFilter(null);
            }}
          />
        ) : panel === 'git' ? (
          <GitPanel onClose={closePanel} />
        ) : panel === 'instructions' ? (
          <InstructionsPanel onClose={closePanel} />
        ) : panel === 'settings' ? (
          <SettingsPanel onClose={closePanel} />
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
          title={t('page.delete.title', { id: deletingId })}
          message={t('page.delete.message')}
          confirmLabel={common('ui.delete')}
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
