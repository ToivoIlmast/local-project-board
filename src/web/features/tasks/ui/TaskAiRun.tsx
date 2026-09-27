import type { Task } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { Text } from '../../../shared/ui/index';

export interface TaskAiRunProps {
  task: Task;
}

/**
 * What the last agent on this task said about its run (T27, the model of T20), with the branch
 * it recorded. It is the agent's own word and the block says so: the board checks none of it.
 * The report is the document `report.md`, listed with the other documents of the task.
 */
export function TaskAiRun({ task }: TaskAiRunProps) {
  const run = task.aiRun;
  if (run === undefined) return null;

  const rows: [string, string | undefined][] = [
    ['Agent', run.agent],
    ['State', run.state],
    ['Checks', run.checks],
    ['Commit', run.commit],
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
