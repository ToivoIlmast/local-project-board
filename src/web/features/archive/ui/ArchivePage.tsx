import { useMemo } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useStatusLabel } from '../../../shared/i18n/index';
import { formatDate } from '../../../shared/lib/format';
import { Button, EmptyState } from '../../../shared/ui/index';
import { useArchiveT } from '../i18n';
import { archivedNewestFirst } from '../model/archived';

export interface ArchivePageProps {
  onOpen: (id: string) => void;
}

/**
 * The main view when `?view=archive` (T11): the tasks that were taken off the board, the last
 * archived first. Nothing is guessed: a row leaves the list when the board answers the restore.
 */
export function ArchivePage({ onOpen }: ArchivePageProps) {
  const t = useArchiveT();
  const { state } = useBoard();
  const tasks = useMemo(() => archivedNewestFirst(state.tasks), [state.tasks]);

  return (
    <section className="archive" aria-label={t('archive.title')}>
      <h2 className="blocks__title-main">{t('archive.title')}</h2>
      {tasks.length === 0 ? (
        <EmptyState title={t('archive.empty.title')}>
          <p>{t('archive.empty.hint')}</p>
        </EmptyState>
      ) : (
        <ul className="archive__list">
          {tasks.map((task) => (
            <ArchiveRow key={task.id} task={task} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ArchiveRow({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const t = useArchiveT();
  const statusLabel = useStatusLabel();
  const { state, store } = useBoard();
  const restore = useAsyncAction(() => store.restoreTask(task.id));
  const topic = state.topics.find((candidate) => candidate.id === task.topic);

  return (
    <li className="archive__row" data-task-id={task.id}>
      <div className="archive__main">
        <span className="archive__id">{task.id}</span>
        <button type="button" className="archive__title" onClick={() => onOpen(task.id)}>
          {task.title}
        </button>
        <Button
          size="small"
          aria-label={t('archive.restoreTask', { id: task.id })}
          disabled={restore.pending}
          onClick={() => void restore.run()}
        >
          {t('archive.restore')}
        </Button>
      </div>
      <p className="archive__meta">
        <span>{t('archive.was', { status: statusLabel(task.status) })}</span>
        {task.archived === undefined ? null : (
          <span>{t('archive.at', { when: formatDate(task.archived.at) })}</span>
        )}
        {task.topic === undefined ? null : (
          <span>{t('archive.topic', { topic: topic?.title ?? task.topic })}</span>
        )}
      </p>
      {restore.error === undefined ? null : (
        <p className="notice" role="alert">
          {restore.error}
        </p>
      )}
    </li>
  );
}
