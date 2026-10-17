import {
  applyRecommendations,
  occurrences,
  type Check,
  type FromCheck,
  type Recommendation,
  type Task,
  type TaskContent,
  type VersionList,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, Modal, Text } from '../../../shared/ui/index';
import {
  STATE_LABELS,
  VERDICT_LABELS,
  appliedIn,
  checkId,
  decisionOf,
  describeRepo,
  repoChanged,
  staleness,
  stalenessText,
  taskContent,
  type DecisionState,
} from '../model/history';
import { useCheck } from '../model/useTaskHistory';

/** What the report asks the page to open in the editor: the draft and where it came from. */
export interface ApplyRequest {
  draft: TaskContent;
  fromCheck: FromCheck;
  /** The recommendations the draft could not take, named with the reason. */
  notApplied: { id: string; text: string; reason: string }[];
  recommendations: readonly Recommendation[];
  title: string;
}

export interface CheckReportDialogProps {
  task: Task;
  number: number;
  list: VersionList | undefined;
  onClose: () => void;
  onApply: (request: ApplyRequest) => void;
  /** Asks for a new check of the task; resolves when it was handed to a runner. */
  onCheckAgain: () => void;
}

const NOT_APPLIED_REASON = {
  advice: 'it is advice, with nothing to apply',
  'not-found': 'the text it replaces is no longer in the description',
  ambiguous: 'the text it replaces now occurs more than once',
  'blank-title': 'the title it proposes is blank',
} as const;

/**
 * One check as the board stored it: the report exactly as the agent sent it, the state of each
 * recommendation, and the way to decide on them and to apply them (ADR-0030 §7). Nothing is
 * applied here: a recommendation becomes a change only through the editor, by a person who
 * saves it. A report that no longer matches the task is said to be stale, and is not applied.
 */
export function CheckReportDialog({
  task,
  number,
  list,
  onClose,
  onApply,
  onCheckAgain,
}: CheckReportDialogProps) {
  const { store } = useBoard();
  const { check, error, retry } = useCheck(task.id, number);
  const decide = useAsyncAction((recommendation: string, decision: 'accepted' | 'rejected') =>
    store.decide(task.id, number, { recommendation, decision }),
  );

  const stale =
    check === undefined ? undefined : staleness(task, list, { version: check.begin.version });
  const staleText = stale === undefined ? undefined : stalenessText(stale);
  const report = check?.report;

  const accepted = (report?.recommendations ?? []).filter(
    (recommendation) => check !== undefined && decisionOf(check, recommendation.id) === 'accepted',
  );

  const apply = (basis: 'report' | 'manual'): void => {
    if (report === undefined || accepted.length === 0) return;
    const content = taskContent(task);
    if (basis === 'manual') {
      onApply({
        draft: content,
        fromCheck: { check: number, recommendations: accepted.map((r) => r.id), basis },
        notApplied: [],
        // By hand, the person weighs all of them against the content as it is now.
        recommendations: report.recommendations,
        title: `Reconcile ${task.id} with ${checkId(task.id, number)}`,
      });
      return;
    }
    const result = applyRecommendations(content, accepted);
    onApply({
      draft: result.content,
      fromCheck: { check: number, recommendations: result.applied, basis },
      notApplied: result.notApplied.map(({ id, reason }) => ({
        id,
        text: accepted.find((r) => r.id === id)?.text ?? id,
        reason: NOT_APPLIED_REASON[reason],
      })),
      recommendations: accepted,
      title: `Apply ${checkId(task.id, number)} to ${task.id}`,
    });
  };

  const applicable = accepted.filter((r) => r.edit !== undefined);

  return (
    <Modal
      title={`Check ${checkId(task.id, number)}`}
      onClose={onClose}
      width="wide"
      footer={
        <>
          {report === undefined || stale === undefined ? null : stale.stale ? (
            <>
              <Button onClick={onCheckAgain}>Check again</Button>
              <Button disabled={accepted.length === 0} onClick={() => apply('manual')}>
                Reconcile by hand
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={applicable.length === 0}
              onClick={() => apply('report')}
            >
              Apply accepted
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error === undefined ? null : (
        <div className="notice" role="alert">
          <span>{error}</span>
          <Button size="small" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {check === undefined ? (
        error === undefined ? (
          <Text tone="muted">Loading…</Text>
        ) : null
      ) : (
        <div className="check">
          <p className="check__meta">
            <Badge>{STATE_LABELS[check.state]}</Badge>{' '}
            {report === undefined ? null : (
              <Badge tone={report.verdict === 'current' ? 'accent' : 'warning'}>
                {VERDICT_LABELS[report.verdict]}
              </Badge>
            )}{' '}
            <span>
              Checked v{check.begin.version} · {formatDate(check.begin.createdAt)} ·{' '}
              {check.begin.agent}
              {check.begin.model === undefined ? '' : ` (${check.begin.model})`}
            </span>
          </p>

          {staleText === undefined ? null : (
            <p className="notice" role="status">
              {staleText} Its recommendations are not applied to the current content.
            </p>
          )}

          {report === undefined ? (
            <Text tone="muted">
              {check.state === 'failed'
                ? `The check ended without a report${
                    check.end?.exitCode === undefined || check.end.exitCode === 0
                      ? '.'
                      : ` (exit code ${check.end.exitCode}).`
                  }`
                : 'The check has no report yet. It may still be working, or its process may have ended without one.'}
            </Text>
          ) : (
            <>
              {!repoChanged(check) ? null : (
                <p className="notice" role="status">
                  The repository changed while the check ran: {describeRepo(check.begin.repo)} at
                  the start, {describeRepo(report.repo)} when the report came.
                </p>
              )}
              <section aria-label="Summary">
                <h3 className="check__heading">Summary</h3>
                <p>{report.summary}</p>
                {report.uncertainty === undefined ? null : (
                  <p>
                    <strong>Uncertainty:</strong> {report.uncertainty}
                  </p>
                )}
                <Text tone="muted">
                  Repository at the start: {describeRepo(check.begin.repo)}. When the report came:{' '}
                  {describeRepo(report.repo)}.
                </Text>
              </section>

              <section aria-label="Findings">
                <h3 className="check__heading">Findings</h3>
                {report.findings.length === 0 ? (
                  <Text tone="muted">None.</Text>
                ) : (
                  <ul className="check__list">
                    {report.findings.map((finding) => (
                      <li key={finding.id}>
                        <strong>{finding.title}</strong>{' '}
                        <Badge title="Finding id">{finding.id}</Badge>
                        <p>{finding.explanation}</p>
                        {finding.evidence.length === 0 ? null : (
                          <ul className="check__evidence">
                            {finding.evidence.map((evidence, index) => (
                              // Evidence is a fixed list, in the order the agent sent it.
                              // eslint-disable-next-line @eslint-react/no-array-index-key
                              <li key={index}>
                                <code>{evidence.kind}</code> <code>{evidence.ref}</code>
                                {evidence.note === undefined ? '' : ` — ${evidence.note}`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-label="Recommendations">
                <h3 className="check__heading">Recommendations</h3>
                {decide.error === undefined ? null : (
                  <p className="form__error" role="alert">
                    {decide.error}
                  </p>
                )}
                {report.recommendations.length === 0 ? (
                  <Text tone="muted">None.</Text>
                ) : (
                  <ul className="check__list">
                    {report.recommendations.map((recommendation) => (
                      <RecommendationItem
                        key={recommendation.id}
                        check={check}
                        task={task}
                        list={list}
                        recommendation={recommendation}
                        pending={decide.pending}
                        onDecide={(decision) => void decide.run(recommendation.id, decision)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function RecommendationItem({
  check,
  task,
  list,
  recommendation,
  pending,
  onDecide,
}: {
  check: Check;
  task: Task;
  list: VersionList | undefined;
  recommendation: Recommendation;
  pending: boolean;
  onDecide: (decision: 'accepted' | 'rejected') => void;
}) {
  const state: DecisionState = decisionOf(check, recommendation.id);
  const applied = appliedIn(list, check.begin.number, recommendation.id);
  const edit = recommendation.edit;
  return (
    <li className="check__recommendation">
      <p>
        <Badge title="Recommendation id">{recommendation.id}</Badge> {recommendation.text}
      </p>
      {edit === undefined ? (
        <Text tone="muted">Advice: there is nothing to apply.</Text>
      ) : (
        <p className="check__edit">
          {edit.field === 'title' ? (
            <>
              Title → <q>{edit.value}</q>
            </>
          ) : edit.field === 'labels' ? (
            <>
              Labels: {edit.add.map((label) => `+${label}`).join(' ')}{' '}
              {edit.remove.map((label) => `−${label}`).join(' ')}
            </>
          ) : (
            <>
              Description: replace <q>{edit.find}</q> with <q>{edit.replace}</q>
              {occurrences(task.body, edit.find) === 1 ? null : (
                <span> (no longer exactly once in the current description)</span>
              )}
            </>
          )}
        </p>
      )}
      <p className="check__decision">
        <span>
          {state === 'undecided' ? 'Undecided' : state === 'accepted' ? 'Accepted' : 'Rejected'}
        </span>
        {applied.length === 0 ? null : (
          <span> · Applied in {applied.map((n) => `v${n}`).join(', ')}</span>
        )}
      </p>
      <div className="check__actions">
        <Button
          size="small"
          aria-label={`Accept ${recommendation.id}`}
          aria-pressed={state === 'accepted'}
          disabled={pending || state === 'accepted'}
          onClick={() => onDecide('accepted')}
        >
          Accept
        </Button>
        <Button
          size="small"
          aria-label={`Reject ${recommendation.id}`}
          aria-pressed={state === 'rejected'}
          disabled={pending || state === 'rejected'}
          onClick={() => onDecide('rejected')}
        >
          Reject
        </Button>
      </div>
    </li>
  );
}
