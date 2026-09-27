import { useEffect, useState } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { formatDate } from '../../../shared/lib/format';
import { Text } from '../../../shared/ui/index';

export interface TaskAiRunProps {
  task: Task;
}

/**
 * What the last agent on this task said about its run (T27, the model of T20), with the branch
 * it recorded. It is the agent's own word and the block says so: the board checks none of it.
 * The report is the document `report.md`, listed with the other documents of the task.
 *
 * When the run reports a commit and the task has a branch, the component fetches the branch's
 * commits and flags a mismatch if the SHA is not found there (T20).
 */
export function TaskAiRun({ task }: TaskAiRunProps) {
  const { client } = useBoard();
  const run = task.aiRun;
  // Keeps the checked SHA with its result so stale checks never alter the current display.
  const [commitCheck, setCommitCheck] = useState<{ sha: string; inBranch: boolean } | undefined>(
    undefined,
  );

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

  if (run === undefined) return null;

  const commitDisplay =
    run.commit === undefined
      ? undefined
      : task.branch !== undefined && commitCheck?.sha === run.commit && !commitCheck.inBranch
        ? `${run.commit} ⚠ not found in branch`
        : run.commit;

  const rows: [string, string | undefined][] = [
    ['Agent', run.agent],
    ['State', run.state],
    ['Checks', run.checks],
    ['Commit', commitDisplay],
    ['Branch', task.branch],
    ['Started', run.startedAt === undefined ? undefined : formatDate(run.startedAt)],
    ['Finished', run.finishedAt === undefined ? undefined : formatDate(run.finishedAt)],
  ];

  return (
    <section className="ai" aria-labelledby={`ai-run-${task.id}`}>
      <h3 className="ai__title" id={`ai-run-${task.id}`}>
        AI run
      </h3>
      <Text tone="muted">Reported by the agent; the board does not check it.</Text>
      <dl className="ai__values">
        {rows
          .filter((row): row is [string, string] => row[1] !== undefined)
          .map(([term, value]) => (
            <div key={term} className="ai__value">
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
