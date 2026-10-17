import { useState } from 'react';
import { useBoard } from '../../../api/react';
import { ApiError } from '../../../api/index';
import type { Task } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
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
import { useTaskHistory, useVersion } from '../model/useTaskHistory';
import { CheckReportDialog, type ApplyRequest } from './CheckReportDialog';
import { TaskAiRun } from './TaskAiRun';
import { TaskAiSettings } from './TaskAiSettings';
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
  const { store, client } = useBoard();
  const setStatus = useAsyncAction((status: string) => store.updateTask(task.id, { status }));
  const { history, error: historyError, retry } = useTaskHistory(task.id);

  const [chosen, setChosen] = useState<Selected>(CURRENT);
  const [restoring, setRestoring] = useState(false);
  const [opened, setOpened] = useState<number | undefined>(undefined);
  const [applying, setApplying] = useState<ApplyRequest | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);

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
          ? `Restored v${viewing} as a new version.`
          : `The task already has the content of v${viewing}.`,
      );
      setChosen(CURRENT);
      setRestoring(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TASK_CONTENT_CHANGED') {
        // Read the task again: the next try is against what is there now.
        const fresh = await client.getTask(task.id).catch(() => undefined);
        if (fresh !== undefined) await store.handleEvent({ type: 'task.updated', task: fresh });
      }
      throw error;
    }
  });

  const check = useAsyncAction(async () => {
    setDone(undefined);
    await client.runTask(task.id, { agent: 'claude-code', kind: 'check' });
    setDone(`A check of ${task.id} was handed to Claude Code.`);
  });

  const options = versionOptions(task, history?.list);

  return (
    <Panel label={`Task ${task.id}`}>
      <header className="panel__head">
        <h2 className="panel__title">{shown?.title ?? task.title}</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="panel__meta">
        <Badge>{task.id}</Badge>
        {(shown?.labels ?? task.labels).map((label) => (
          <Badge key={label} tone="accent">
            {label}
          </Badge>
        ))}
        {task.branch === undefined ? null : <Badge title="Branch">⎇ {task.branch}</Badge>}
      </div>

      <Field label="Version">
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
          You are looking at v{viewing}, a historical version. The task itself has not changed
          {currentVersion(task, history?.list) === null
            ? ''
            : `: it is at v${currentVersion(task, history?.list)}`}
          .
        </p>
      )}

      <Field label="Status">
        {(id) => (
          <Select
            id={id}
            options={statuses}
            value={task.status}
            disabled={setStatus.pending}
            onChange={(event) => void setStatus.run(event.target.value)}
          />
        )}
      </Field>
      {setStatus.error === undefined ? null : (
        <p className="form__error" role="alert">
          {setStatus.error}
        </p>
      )}

      <Text tone="muted">
        Created {formatDate(task.createdAt)} · changed {formatDate(task.updatedAt)}
      </Text>

      <div className="panel__actions">
        {viewing === undefined ? (
          <Button onClick={onEdit}>Edit</Button>
        ) : (
          <Button
            variant="primary"
            disabled={snapshot.version === undefined}
            onClick={() => {
              restore.clearError();
              setRestoring(true);
            }}
          >
            Restore this version
          </Button>
        )}
        <Button disabled={check.pending} onClick={() => void check.run()}>
          {check.pending ? 'Asking…' : 'Check actuality'}
        </Button>
        <Button variant="danger" onClick={onDelete}>
          Delete
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
      <TaskAiRun task={task} />

      <div className="panel__body">
        {viewing !== undefined && snapshot.error !== undefined ? (
          <p className="form__error" role="alert">
            {snapshot.error}
          </p>
        ) : shown === undefined ? (
          <Text tone="muted">Loading the version…</Text>
        ) : shown.body.trim() === '' ? (
          <Text tone="muted">No description</Text>
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
      <TaskChecks task={task} checks={history?.checks} list={history?.list} onOpen={setOpened} />

      <TaskDocuments taskId={task.id} />

      {!restoring || viewing === undefined ? null : (
        <ConfirmDialog
          title={`Restore v${viewing}?`}
          message={
            `A new version is made with the title, the labels and the description of v${viewing}. ` +
            'The versions before it stay, and the status of the task does not change.'
          }
          confirmLabel="Restore"
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
          onClose={() => setOpened(undefined)}
          onCheckAgain={() => {
            setOpened(undefined);
            void check.run();
          }}
          onApply={(request) => {
            setOpened(undefined);
            setApplying(request);
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
  return (
    <div className="apply-aside">
      <h3 className="check__heading">
        {request.fromCheck.basis === 'report' ? 'Recommendations applied' : 'Recommendations'}
      </h3>
      {request.fromCheck.basis === 'manual' ? (
        <Text tone="muted">
          The report is for another version than the task has now, so nothing is applied for you.
          Make the changes by hand, using the recommendations below.
        </Text>
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
          <span>Not applied:</span>
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
