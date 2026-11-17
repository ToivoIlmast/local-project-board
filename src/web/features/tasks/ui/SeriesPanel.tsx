import { useMemo, useState } from 'react';
import type { CheckSummary, ScopeBasis, ScopeExclusion, Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, ConfirmDialog, Text } from '../../../shared/ui/index';
import { explainError } from '../model/explainError';
import {
  nextUnchecked,
  triggerOf,
  workingChecks,
  type ItemState,
  type SeriesRow,
} from '../model/series';
import { useSeries } from '../model/useSeries';

const STATE_TEXT: Record<ItemState, string> = {
  checked: 'Checked',
  failed: 'Failed',
  working: 'Working',
  unchecked: 'Not checked',
};

const EXCLUDED_TEXT: Record<ScopeExclusion, string> = {
  done: 'Done, not checked',
  'ai-running': 'AI run working, not checked',
};

function basisText(basis: ScopeBasis, source: string): string {
  if (basis === 'dependent') return `depends on ${source}`;
  return basis === 'block' ? 'same block' : 'next block';
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
    setDone(`A check of ${target} was handed to Claude Code.`);
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
          Series of checks
        </h3>
        {view.loaded ? (
          <Button
            size="small"
            disabled={next === undefined || busy}
            onClick={() => next !== undefined && request(next.task)}
          >
            Check next
          </Button>
        ) : null}
      </div>
      <Text tone="muted">
        {task.id} was completed {task.doneAt === undefined ? '' : formatDate(task.doneAt)}. These
        tasks may need to be checked again.
      </Text>

      {view.error !== undefined ? (
        <p className="form__error" role="alert">
          The checks could not be read: {view.error}{' '}
          <Button size="small" onClick={retry}>
            Try again
          </Button>
        </p>
      ) : !view.loaded ? (
        <Text tone="muted">Loading checks…</Text>
      ) : (
        <p aria-live="polite">
          {view.checked} of {view.total} checked
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
                <Badge>{EXCLUDED_TEXT[row.excluded]}</Badge>
              ) : view.loaded ? (
                <Badge tone={tone(row)}>{STATE_TEXT[row.state]}</Badge>
              ) : null}
            </span>
            {row.excluded !== undefined || !view.loaded ? null : (
              <Button
                size="small"
                disabled={start.pending}
                aria-label={`${row.state === 'failed' ? 'Retry' : 'Check'} ${row.task}`}
                onClick={() => request(row.task)}
              >
                {row.state === 'failed' ? 'Retry' : 'Check'}
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
          title="Start another check?"
          message={
            `Check #${asking.working.number} for task ${asking.working.taskId} is still marked as working ` +
            `since ${formatDate(asking.working.createdAt)}. If its session is still running, the new check ` +
            'will run in parallel and repeat the cost. Start anyway?'
          }
          confirmLabel="Start anyway"
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
