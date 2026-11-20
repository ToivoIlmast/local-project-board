import { useMemo, useState } from 'react';
import type { CheckSummary, ScopeBasis, Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { useT } from '../../../shared/i18n/index';
import { Badge, Button, ConfirmDialog, Text } from '../../../shared/ui/index';
import { taskT, useTaskT } from '../i18n/details';
import { explainError } from '../model/explainError';
import { nextUnchecked, triggerOf, workingChecks, type SeriesRow } from '../model/series';
import { useSeries } from '../model/useSeries';

function basisText(basis: ScopeBasis, source: string): string {
  return basis === 'dependent'
    ? taskT('series.basis.dependent', { source })
    : taskT(`series.basis.${basis}`);
}

interface Question {
  target: string;
  working: CheckSummary;
}

export interface SeriesPanelProps {
  task: Task;
}

/**
 * What the completion of a task asks to check again (T100, M1 §2.5): the tasks of its scope with
 * the ground they are in it for and where each stands, and a way to start the check of each, with
 * the exact trigger. The panel reads and asks; it starts nothing by itself, and when a check of the
 * series is still marked as working it asks first (Q9c), because the new one may run in parallel.
 */
export function SeriesPanel({ task }: SeriesPanelProps) {
  const t = useTaskT();
  const common = useT();
  const { client, state } = useBoard();
  const tasks = useMemo(() => [task], [task]);
  const { views, retry } = useSeries(tasks);
  const view = views.get(task.id);
  const [asking, setAsking] = useState<Question | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);

  const start = useAsyncAction(async (target: string) => {
    setDone(undefined);
    const trigger = triggerOf(task);
    if (trigger === undefined) return;
    try {
      await client.runTask(target, { agent: 'claude-code', kind: 'check', trigger });
    } catch (error) {
      throw explainError(error);
    }
    setDone(t('series.started', { task: target }));
  });

  if (view === undefined) return null;

  /** The check still working that the person should hear of: the task's own first. */
  const workingFor = (target: string): CheckSummary | undefined => {
    const all = view.rows
      .filter((row) => row.excluded === undefined)
      .flatMap((row) => workingChecks(state.history[row.task]?.checks ?? [], view.series));
    const latest = (list: CheckSummary[]) => list[list.length - 1];
    return latest(all.filter((check) => check.taskId === target)) ?? latest(all);
  };

  const request = (target: string) => {
    const working = workingFor(target);
    if (working === undefined) void start.run(target);
    else setAsking({ target, working });
  };

  const next = nextUnchecked(view.rows);
  const titleOf = (id: string) => state.tasks.find((candidate) => candidate.id === id)?.title;
  const busy = start.pending || !view.loaded;

  return (
    <section className="history" aria-labelledby={`series-${task.id}`}>
      <div className="history__head">
        <h3 className="ai__title" id={`series-${task.id}`}>
          {t('series.title')}
        </h3>
        {view.loaded ? (
          <Button
            size="small"
            disabled={next === undefined || busy}
            onClick={() => next !== undefined && request(next.task)}
          >
            {t('series.next')}
          </Button>
        ) : null}
      </div>
      <Text tone="muted">
        {t('series.completed', {
          task: task.id,
          date: task.doneAt === undefined ? '' : formatDate(task.doneAt),
        })}
      </Text>

      {view.error !== undefined ? (
        <p className="form__error" role="alert">
          {t('series.readFailed', { error: view.error })}{' '}
          <Button size="small" onClick={retry}>
            {common('ui.tryAgain')}
          </Button>
        </p>
      ) : !view.loaded ? (
        <Text tone="muted">{t('series.loading')}</Text>
      ) : (
        <p aria-live="polite">
          {t('series.progress', { checked: view.checked, total: view.total })}
        </p>
      )}

      <ul className="history__list">
        {view.rows.map((row) => (
          <li key={row.task} className="history__item" data-task-id={row.task}>
            <span className="history__number">{row.task}</span>
            <span className="history__what">
              {titleOf(row.task) ?? row.task}
              <span className="history__when"> · {basisText(row.basis, task.id)} · </span>
              {row.excluded !== undefined ? (
                <Badge>{t(`series.excluded.${row.excluded}`)}</Badge>
              ) : view.loaded ? (
                <Badge tone={tone(row)}>{t(`series.state.${row.state}`)}</Badge>
              ) : null}
            </span>
            {row.excluded !== undefined || !view.loaded ? null : (
              <Button
                size="small"
                disabled={start.pending}
                aria-label={t(row.state === 'failed' ? 'series.retryId' : 'series.checkId', {
                  task: row.task,
                })}
                onClick={() => request(row.task)}
              >
                {t(row.state === 'failed' ? 'series.retry' : 'series.check')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <p className="send-ai__done" aria-live="polite">
        {start.error === undefined ? done : undefined}
      </p>
      {start.error === undefined ? null : (
        <p className="form__error" role="alert">
          {start.error}
        </p>
      )}

      {asking === undefined ? null : (
        <ConfirmDialog
          title={t('series.ask.title')}
          message={t('series.ask.message', {
            number: asking.working.number,
            task: asking.working.taskId,
            time: formatDate(asking.working.createdAt),
          })}
          confirmLabel={t('series.ask.confirm')}
          confirmVariant="primary"
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const target = asking.target;
            setAsking(undefined);
            void start.run(target);
          }}
        />
      )}
    </section>
  );
}

function tone(row: SeriesRow): 'accent' | 'warning' | 'neutral' {
  if (row.state === 'checked') return 'accent';
  return row.state === 'unchecked' ? 'neutral' : 'warning';
}
