import type { CheckSummary, Task, VersionList } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, Text } from '../../../shared/ui/index';
import { useTaskT } from '../i18n/details';
import {
  checkId,
  countsText,
  isSuperseded,
  kindLabel,
  stateLabel,
  staleness,
  verdictLabel,
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
  const t = useTaskT();
  const sorted = [...(checks ?? [])].sort((a, b) => b.number - a.number);
  return (
    <section className="history" aria-labelledby={`checks-${task.id}`}>
      <div className="history__head">
        <h3 className="ai__title" id={`checks-${task.id}`}>
          {t('check.title')}
        </h3>
        <Button size="small" onClick={onNewResearch}>
          {t('check.new')}
        </Button>
      </div>
      {checks === undefined ? null : sorted.length === 0 ? (
        <Text tone="muted">{t('check.empty')}</Text>
      ) : (
        <ol className="history__list">
          {sorted.map((check) => {
            const s = staleness(task, list, check);
            const counts = countsText(check.decisions);
            return (
              <li key={check.number} className="history__item">
                <span className="history__number">{checkId(task.id, check.number)}</span>
                <span className="history__what">
                  {kindLabel(check.kind)} · {stateLabel(check.state)}
                  {check.verdict === undefined ? '' : ` · ${verdictLabel(check.verdict)}`} · v
                  {check.version}
                  <span className="history__when"> · {formatDate(check.createdAt)}</span>{' '}
                  {s.stale ? <Badge tone="warning">{t('check.stale')}</Badge> : null}{' '}
                  {isSuperseded(sorted, check.number) ? (
                    <Badge>{t('check.superseded')}</Badge>
                  ) : null}
                  {check.comment === undefined ? null : (
                    <span className="history__comment" title={t('check.focus')}>
                      {check.comment}
                    </span>
                  )}
                  {counts === undefined ? null : (
                    <span className="history__when history__counts">{counts}</span>
                  )}
                </span>
                <Button
                  size="small"
                  aria-label={t('check.openId', { id: checkId(task.id, check.number) })}
                  onClick={() => onOpen(check.number)}
                >
                  {t('check.open')}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
