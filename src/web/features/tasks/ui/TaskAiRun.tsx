import { useEffect, useState } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useCopyToClipboard } from '../../../shared/hooks/useCopyToClipboard';
import { formatDate } from '../../../shared/lib/format';
import { Button, ConfirmDialog, Text } from '../../../shared/ui/index';
import { useTaskT } from '../i18n/details';
import {
  canResume,
  exitWarning,
  failureText,
  isRecoverable,
  resumeCommand,
} from '../model/aiRunView';
import { chosenModel, initialModel, runRequest } from '../model/claudeLaunch';
import { ClaudeCodeLaunch } from './ClaudeCodeLaunch';

export interface TaskAiRunProps {
  task: Task;
}

interface Row {
  term: string;
  value: string | undefined;
  /** What the agent wrote is its word: the board checks none of it, and the row says so. */
  byAgent?: true;
}

/**
 * The run of an agent on this task, as the lifecycle of a session (T39): the attempt, the state,
 * the model and the mode the runner wrote, what the agent reported about its work, and — when
 * the run stopped without being done — why, and the way back: Resume and Restart, and nothing
 * more. The report is the document `report.md`, listed with the other documents of the task.
 *
 * When the run reports a commit and the task has a branch, the component fetches the branch's
 * commits and flags a mismatch if the SHA is not found there (T20).
 */
export function TaskAiRun({ task }: TaskAiRunProps) {
  const t = useTaskT();
  const { client } = useBoard();
  const { copy } = useCopyToClipboard();
  const run = task.aiRun;
  // Keeps the checked SHA with its result so stale checks never alter the current display.
  const [commitCheck, setCommitCheck] = useState<{ sha: string; inBranch: boolean } | undefined>(
    undefined,
  );
  const [resuming, setResuming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    const commit = run?.commit;
    const branch = task.branch;
    if (commit === undefined || branch === undefined) return;
    let alive = true;
    client.gitCommits(50, branch).then(
      (commits) => {
        if (!alive) return;
        const inBranch = commits.some((c) => c.sha.startsWith(commit) || commit.startsWith(c.sha));
        setCommitCheck({ sha: commit, inBranch });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, run?.commit, task.branch]);

  const restart = useAsyncAction(async () => {
    const model = chosenModel(initialModel(run));
    await client.runTask(task.id, runRequest(model ?? undefined, 'restart'));
    setRestarting(false);
    setNote(t('ai.launch.sent', { task: task.id }));
  });

  if (run === undefined) return null;

  const commitDisplay =
    run.commit === undefined
      ? undefined
      : task.branch !== undefined && commitCheck?.sha === run.commit && !commitCheck.inBranch
        ? t('ai.run.notInBranch', { commit: run.commit })
        : run.commit;

  // What the board and the agent wrote stays as it is, except the words that name a state.
  const stateWords: Record<string, string> = {
    working: t('ai.run.state.working'),
    finished: t('ai.run.state.finished'),
    failed: t('ai.run.state.failed'),
    'needs-review': t('ai.run.state.needs-review'),
  };
  const modeWords: Record<string, string> = {
    new: t('ai.run.mode.new'),
    resume: t('ai.run.mode.resume'),
    restart: t('ai.run.mode.restart'),
  };
  const checkWords: Record<string, string> = {
    passed: t('ai.run.checks.passed'),
    failed: t('ai.run.checks.failed'),
    skipped: t('ai.run.checks.skipped'),
  };
  const said = (words: Record<string, string>, value: string | undefined) =>
    value === undefined ? undefined : (words[value] ?? value);

  const rows: Row[] = [
    { term: t('ai.run.attempt'), value: run.runId === undefined ? undefined : `#${run.runId}` },
    {
      term: t('ai.run.state'),
      value: said(stateWords, run.state),
    },
    { term: t('ai.run.model'), value: run.model },
    { term: t('ai.run.mode'), value: said(modeWords, run.mode) },
    { term: t('ai.run.agent'), value: run.agent, byAgent: true },
    {
      term: t('ai.run.checks'),
      value: said(checkWords, run.checks),
      byAgent: true,
    },
    { term: t('ai.run.commit'), value: commitDisplay, byAgent: true },
    { term: t('ai.run.branch'), value: task.branch },
    {
      term: t('ai.run.started'),
      value: run.startedAt === undefined ? undefined : formatDate(run.startedAt),
    },
    {
      term: t('ai.run.finished'),
      value: run.finishedAt === undefined ? undefined : formatDate(run.finishedAt),
    },
  ];
  const failure = failureText(run);
  const warning = exitWarning(run);
  const recoverable = isRecoverable(run);

  const copyCommand = async (sessionId: string): Promise<void> => {
    setCopyError(false);
    if (await copy(resumeCommand(sessionId))) setNote(t('ai.run.copied'));
    else setCopyError(true);
  };

  return (
    <section className="ai" aria-labelledby={`ai-run-${task.id}`}>
      <h3 className="ai__title" id={`ai-run-${task.id}`}>
        {t('ai.run.title')}
      </h3>
      <dl className="ai__values">
        {rows
          .filter((row): row is Row & { value: string } => row.value !== undefined)
          .map(({ term, value, byAgent }) => (
            <div key={term} className="ai__value">
              <dt>
                {term}
                {byAgent === true ? (
                  <small className="ai__source">{t('ai.run.byAgent')}</small>
                ) : null}
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        {run.sessionId === undefined ? null : (
          <div className="ai__value">
            <dt>{t('ai.run.session')}</dt>
            <dd>{run.sessionId}</dd>
          </div>
        )}
      </dl>
      {run.sessionId === undefined ? null : (
        <Button size="small" onClick={() => void copyCommand(run.sessionId as string)}>
          {t('ai.run.copyCommand')}
        </Button>
      )}
      {failure === undefined ? null : (
        <p className="notice" role="alert">
          {failure}
        </p>
      )}
      {warning === undefined ? null : <Text tone="muted">⚠ {warning}</Text>}
      {copyError ? (
        <p className="form__error" role="alert">
          {t('ai.clipboardRefused')}
        </p>
      ) : null}
      {recoverable ? (
        <div className="ai__actions">
          {canResume(run) ? (
            <Button onClick={() => setResuming(true)}>{t('ai.run.resume')}</Button>
          ) : null}
          <Button
            onClick={() => {
              restart.clearError();
              setRestarting(true);
            }}
          >
            {t('ai.run.restart')}
          </Button>
        </div>
      ) : null}
      {/* Always there, so that what is put into it is announced; empty, it takes no room. */}
      <p className="send-ai__done" aria-live="polite">
        {note}
      </p>
      {resuming ? (
        <ClaudeCodeLaunch
          task={task}
          initialSession="resume"
          onClose={() => setResuming(false)}
          onDone={(text) => {
            setResuming(false);
            setNote(text);
          }}
        />
      ) : null}
      {restarting ? (
        <ConfirmDialog
          title={t('ai.run.restartTitle', { task: task.id })}
          message={
            task.branch === undefined
              ? t('ai.run.restartNoBranch', { attempt: run.runId ?? 0 })
              : t('ai.run.restartWithBranch', { branch: task.branch, attempt: run.runId ?? 0 })
          }
          confirmLabel={t('ai.run.restart')}
          pending={restart.pending}
          error={restart.error}
          onConfirm={() => void restart.run()}
          onCancel={() => setRestarting(false)}
        />
      ) : null}
    </section>
  );
}
