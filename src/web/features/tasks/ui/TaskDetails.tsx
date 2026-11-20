import { useState } from 'react';
import { useBoard } from '../../../api/react';
import { ApiError } from '../../../api/index';
import type { Task } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useStatusLabel, useT } from '../../../shared/i18n/index';
import { formatDate } from '../../../shared/lib/format';
import { Markdown } from '../../../shared/lib/Markdown';
import { Badge, Button, ConfirmDialog, Field, Panel, Select, Text } from '../../../shared/ui/index';
import { TaskDocuments } from '../../documents/index';
import {
  CURRENT,
  currentHash,
  currentVersion,
  normalizeSelection,
  versionOptions,
  type Selected,
} from '../model/history';
import { useTaskT } from '../i18n/details';
import { needsStatusConfirmation } from '../model/placement';
import { reasonText } from '../model/readinessText';
import { useTaskHistory, useVersion } from '../model/useTaskHistory';
import { CheckReportDialog, type ApplyRequest } from './CheckReportDialog';
import { NewResearchDialog } from './NewResearchDialog';
import { TaskAiRun } from './TaskAiRun';
import { TaskLaunch } from './TaskLaunch';
import { TaskAiSettings } from './TaskAiSettings';
import { SeriesPanel } from './SeriesPanel';
import { TaskChecks } from './TaskChecks';
import { TaskDialog } from './TaskDialog';
import { TaskVersions } from './TaskVersions';

export interface TaskDetailsProps {
  task: Task;
  statuses: string[];
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** One task, everything about it, its history, and the documents that belong to it. */
export function TaskDetails({ task, statuses, onEdit, onDelete, onClose }: TaskDetailsProps) {
  const { store, client, state } = useBoard();
  const t = useTaskT();
  const common = useT();
  const statusLabel = useStatusLabel();
  const reasons = state.readiness[task.id] ?? [];
  // A status chosen for a blocked task waits for the answer; until then nothing is sent.
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const setStatus = useAsyncAction((status: string) => store.updateTask(task.id, { status }));
  const { history, error: historyError, retry } = useTaskHistory(task.id);

  const [chosen, setChosen] = useState<Selected>(CURRENT);
  const [restoring, setRestoring] = useState(false);
  const [opened, setOpened] = useState<number | undefined>(undefined);
  const [applying, setApplying] = useState<ApplyRequest | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [researching, setResearching] = useState(false);

  const selected = normalizeSelection(chosen, task, history?.list);
  const viewing = selected === CURRENT ? undefined : selected;
  const snapshot = useVersion(task.id, viewing);
  // What the panel shows: the task, or the content of the version being looked at.
  const shown = viewing === undefined ? task : snapshot.version?.snapshot;

  const restore = useAsyncAction(async () => {
    if (viewing === undefined) return;
    try {
      const result = await store.restoreVersion(task.id, viewing, currentHash(task));
      setDone(
        result.changed
          ? t('details.restored', { version: viewing })
          : t('details.restoredSame', { version: viewing }),
      );
      setChosen(CURRENT);
      setRestoring(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TASK_CONTENT_CHANGED') {
        // Read the task again: the next try is against what is there now.
        const fresh = await client.getTask(task.id).catch(() => undefined);
        if (fresh !== undefined) {
          // The task as the event carries it; its readiness is the store's to read.
          const { readiness: _readiness, ...current } = fresh;
          await store.handleEvent({ type: 'task.updated', task: current });
        }
      }
      throw error;
    }
  });

  const check = useAsyncAction(async () => {
    setDone(undefined);
    await client.runTask(task.id, { agent: 'claude-code', kind: 'check' });
    setDone(t('details.checkHanded', { id: task.id }));
  });

  const options = versionOptions(task, history?.list);

  return (
    <Panel label={t('details.panel', { id: task.id })}>
      <header className="panel__head">
        <h2 className="panel__title">{shown?.title ?? task.title}</h2>
        <Button size="small" onClick={onClose}>
          {common('ui.close')}
        </Button>
      </header>

      <div className="panel__meta">
        <Badge>{task.id}</Badge>
        {(shown?.labels ?? task.labels).map((label) => (
          <Badge key={label} tone="accent">
            {label}
          </Badge>
        ))}
        {task.branch === undefined ? null : (
          <Badge title={t('field.branch')}>⎇ {task.branch}</Badge>
        )}
      </div>

      <Field label={t('field.version')}>
        {(id) => (
          <Select
            id={id}
            options={options}
            value={selected === CURRENT ? CURRENT : String(selected)}
            disabled={options.length < 2}
            onChange={(event) =>
              setChosen(event.target.value === CURRENT ? CURRENT : Number(event.target.value))
            }
          />
        )}
      </Field>
      {viewing === undefined ? null : (
        <p className="notice" role="status">
          {currentVersion(task, history?.list) === null
            ? t('details.viewing', { version: viewing })
            : t('details.viewingAt', {
                version: viewing,
                now: currentVersion(task, history?.list) ?? '',
              })}
        </p>
      )}

      <Field label={t('field.status')}>
        {(id) => (
          <Select
            id={id}
            options={statuses.map((value) => ({ value, label: statusLabel(value) }))}
            value={task.status}
            disabled={setStatus.pending}
            onChange={(event) => {
              const next = event.target.value;
              if (needsStatusConfirmation(task, reasons, next)) setAsking(next);
              else void setStatus.run(next);
            }}
          />
        )}
      </Field>
      {setStatus.error === undefined ? null : (
        <p className="form__error" role="alert">
          {setStatus.error}
        </p>
      )}

      <Text tone="muted">
        {t('details.dates', {
          created: formatDate(task.createdAt),
          changed: formatDate(task.updatedAt),
        })}
      </Text>

      <div className="panel__actions">
        {viewing === undefined ? (
          <Button onClick={onEdit}>{t('details.edit')}</Button>
        ) : (
          <Button
            variant="primary"
            disabled={snapshot.version === undefined}
            onClick={() => {
              restore.clearError();
              setRestoring(true);
            }}
          >
            {t('details.restore')}
          </Button>
        )}
        <Button disabled={check.pending} onClick={() => void check.run()}>
          {check.pending ? t('details.checking') : t('details.check')}
        </Button>
        <Button variant="danger" onClick={onDelete}>
          {common('ui.delete')}
        </Button>
      </div>
      {/* Always there, so that what is put into it is announced; empty, it takes no room. */}
      <p className="send-ai__done" aria-live="polite">
        {check.error === undefined ? done : undefined}
      </p>
      {check.error === undefined ? null : (
        <p className="form__error" role="alert">
          {check.error}
        </p>
      )}

      <TaskAiSettings task={task} />
      <TaskLaunch task={task} />
      <TaskAiRun task={task} />

      <div className="panel__body">
        {viewing !== undefined && snapshot.error !== undefined ? (
          <p className="form__error" role="alert">
            {snapshot.error}
          </p>
        ) : shown === undefined ? (
          <Text tone="muted">{t('details.loadingVersion')}</Text>
        ) : shown.body.trim() === '' ? (
          <Text tone="muted">{t('details.noDescription')}</Text>
        ) : (
          <Markdown>{shown.body}</Markdown>
        )}
      </div>

      <TaskVersions
        task={task}
        list={history?.list}
        error={historyError}
        onRetry={retry}
        onView={(next) => setChosen(next)}
      />
      <SeriesPanel task={task} />
      <TaskChecks
        task={task}
        checks={history?.checks}
        list={history?.list}
        onOpen={setOpened}
        onNewResearch={() => setResearching(true)}
      />

      <TaskDocuments taskId={task.id} />

      {asking === undefined ? null : (
        <ConfirmDialog
          title={t('details.askStatus.title', { id: task.id })}
          message={t('details.askStatus.message', {
            id: task.id,
            from: statusLabel(task.status),
            to: statusLabel(asking),
          })}
          confirmLabel={t('details.askStatus.confirm')}
          confirmVariant="primary"
          pending={setStatus.pending}
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            void setStatus.run(asking).then(() => setAsking(undefined));
          }}
        >
          <ul>
            {reasons.map((reason) => (
              <li key={reasonText(reason)}>{reasonText(reason)}</li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      {!restoring || viewing === undefined ? null : (
        <ConfirmDialog
          title={t('details.restoreAsk.title', { version: viewing })}
          message={t('details.restoreAsk.message', { version: viewing })}
          confirmLabel={t('details.restoreAsk.confirm')}
          pending={restore.pending}
          error={restore.error}
          onCancel={() => setRestoring(false)}
          onConfirm={() => void restore.run()}
        />
      )}

      {opened === undefined ? null : (
        <CheckReportDialog
          task={task}
          number={opened}
          list={history?.list}
          checks={history?.checks}
          onClose={() => setOpened(undefined)}
          onCheckAgain={() => {
            setOpened(undefined);
            void check.run();
          }}
          onNewResearch={() => {
            setOpened(undefined);
            setResearching(true);
          }}
          onApply={(request) => {
            setOpened(undefined);
            setApplying(request);
          }}
        />
      )}

      {!researching ? null : (
        <NewResearchDialog
          taskId={task.id}
          aiRun={task.aiRun}
          onClose={() => setResearching(false)}
          onDone={(message) => {
            setResearching(false);
            check.clearError();
            setDone(message);
          }}
        />
      )}

      {applying === undefined ? null : (
        <TaskDialog
          statuses={statuses}
          task={task}
          title={applying.title}
          draft={{
            title: applying.draft.title,
            body: applying.draft.body,
            labels: applying.draft.labels,
          }}
          fromCheck={applying.fromCheck}
          aside={<ApplyAside request={applying} />}
          onClose={() => setApplying(undefined)}
        />
      )}
    </Panel>
  );
}

/** The recommendations beside the editor: what is being applied, and what could not be. */
function ApplyAside({ request }: { request: ApplyRequest }) {
  const t = useTaskT();
  return (
    <div className="apply-aside">
      <h3 className="check__heading">
        {request.fromCheck.basis === 'report'
          ? t('details.aside.applied')
          : t('details.aside.recommendations')}
      </h3>
      {request.fromCheck.basis === 'manual' ? (
        <Text tone="muted">{t('details.aside.manual')}</Text>
      ) : null}
      <ul className="check__list">
        {request.recommendations.map((recommendation) => (
          <li key={recommendation.id}>
            <Badge>{recommendation.id}</Badge> {recommendation.text}
          </li>
        ))}
      </ul>
      {request.notApplied.length === 0 ? null : (
        <div className="notice" role="status">
          <span>{t('details.aside.notApplied')}</span>
          <ul>
            {request.notApplied.map((item) => (
              <li key={item.id}>
                {item.id}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
