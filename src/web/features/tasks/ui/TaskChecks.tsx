import type { CheckSummary, Task, VersionList } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, Text } from '../../../shared/ui/index';
import {
  STATE_LABELS,
  VERDICT_LABELS,
  checkId,
  countsText,
  isSuperseded,
  kindLabel,
  staleness,
} from '../model/history';

export interface TaskChecksProps {
  task: Task;
  checks: readonly CheckSummary[] | undefined;
  list: VersionList | undefined;
  onOpen: (number: number) => void;
  onNewResearch: () => void;
}

/**
 * The research and the actuality checks of a task, apart from its versions and tied to them by
 * the number of the version each one read (ADR-0030, R1): newest first, with the kind, the focus,
 * the state, the verdict of a check, how its recommendations stand, and whether the task has moved
 * on or a later report came since. Opening one shows the report as it was stored, not as it would
 * be today.
 */
export function TaskChecks({ task, checks, list, onOpen, onNewResearch }: TaskChecksProps) {
  const sorted = [...(checks ?? [])].sort((a, b) => b.number - a.number);
  return (
    <section className="history" aria-labelledby={`checks-${task.id}`}>
      <div className="history__head">
        <h3 className="ai__title" id={`checks-${task.id}`}>
          AI research
        </h3>
        <Button size="small" onClick={onNewResearch}>
          New research…
        </Button>
      </div>
      {checks === undefined ? null : sorted.length === 0 ? (
        <Text tone="muted">
          No research or checks yet. A research looks into the task with a focus you give; Check
          actuality compares the task with the repository.
        </Text>
      ) : (
        <ol className="history__list">
          {sorted.map((check) => {
            const s = staleness(task, list, check);
            const counts = countsText(check.decisions);
            return (
              <li key={check.number} className="history__item">
                <span className="history__number">{checkId(task.id, check.number)}</span>
                <span className="history__what">
                  {kindLabel(check.kind)} · {STATE_LABELS[check.state]}
                  {check.verdict === undefined ? '' : ` · ${VERDICT_LABELS[check.verdict]}`} · v
                  {check.version}
                  <span className="history__when"> · {formatDate(check.createdAt)}</span>{' '}
                  {s.stale ? <Badge tone="warning">Stale</Badge> : null}{' '}
                  {isSuperseded(sorted, check.number) ? <Badge>Superseded</Badge> : null}
                  {check.comment === undefined ? null : (
                    <span className="history__comment" title="Focus">
                      {check.comment}
                    </span>
                  )}
                  {counts === undefined ? null : (
                    <span className="history__when history__counts">{counts}</span>
                  )}
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
