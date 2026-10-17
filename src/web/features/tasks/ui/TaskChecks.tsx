import type { CheckSummary, Task, VersionList } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, Text } from '../../../shared/ui/index';
import { STATE_LABELS, VERDICT_LABELS, checkId, staleness } from '../model/history';

export interface TaskChecksProps {
  task: Task;
  checks: readonly CheckSummary[] | undefined;
  list: VersionList | undefined;
  onOpen: (number: number) => void;
}

/**
 * The checks of a task, apart from its versions and tied to them by the number of the version
 * each one read (ADR-0030): newest first, with the state, the verdict and whether the task has
 * moved on since. Opening one shows the report as it was stored, not as it would be today.
 */
export function TaskChecks({ task, checks, list, onOpen }: TaskChecksProps) {
  const sorted = [...(checks ?? [])].sort((a, b) => b.number - a.number);
  return (
    <section className="history" aria-labelledby={`checks-${task.id}`}>
      <h3 className="ai__title" id={`checks-${task.id}`}>
        Checks
      </h3>
      {checks === undefined ? null : sorted.length === 0 ? (
        <Text tone="muted">
          No checks yet. Check actuality asks an agent to compare the task with the repository.
        </Text>
      ) : (
        <ol className="history__list">
          {sorted.map((check) => {
            const s = staleness(task, list, check);
            return (
              <li key={check.number} className="history__item">
                <span className="history__number">{checkId(task.id, check.number)}</span>
                <span className="history__what">
                  {STATE_LABELS[check.state]}
                  {check.verdict === undefined ? '' : ` · ${VERDICT_LABELS[check.verdict]}`} · v
                  {check.version}
                  <span className="history__when"> · {formatDate(check.createdAt)}</span>{' '}
                  {s.stale ? <Badge tone="warning">Stale</Badge> : null}
                </span>
                <Button
                  size="small"
                  aria-label={`Open ${checkId(task.id, check.number)}`}
                  onClick={() => onOpen(check.number)}
                >
                  Open
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
