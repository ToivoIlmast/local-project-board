import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  applyRecommendations,
  latestDecisions,
  occurrences,
  type Check,
  type CheckSummary,
  type FromCheck,
  type Recommendation,
  type RecommendationTarget,
  type Task,
  type TaskContent,
  type VersionList,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { Markdown } from '../../../shared/lib/Markdown';
import { useT } from '../../../shared/i18n/index';
import { Badge, Button, Field, Modal, Text, Textarea } from '../../../shared/ui/index';
import { taskT, useTaskT } from '../i18n/details';
import {
  axisLabels,
  checkId,
  decisionOf,
  describeRepo,
  documentChanges,
  isSuperseded,
  kindLabel,
  movedOnSince,
  recommendationState,
  repoChanged,
  staleness,
  stalenessText,
  stateLabel,
  taskContent,
  treeChange,
  verdictLabel,
} from '../model/history';
import { useCheck, useReportMarkdown } from '../model/useTaskHistory';

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
  /** Every check of the task, for whether a later report superseded this one. */
  checks: readonly CheckSummary[] | undefined;
  onClose: () => void;
  onApply: (request: ApplyRequest) => void;
  /** Asks for a new check of the task; resolves when it was handed to a runner. */
  onCheckAgain: () => void;
  /** Opens the dialog of a new research, in place of this report. */
  onNewResearch: () => void;
}

/**
 * One check or research as the board stored it: the report exactly as the agent sent it, the
 * state of each recommendation on three axes, and the way to decide on them and to apply them
 * (ADR-0030 §7, R4, R5). Nothing is applied here: a recommendation becomes a change only through
 * the editor, by a person who saves it, and only an edit of the task is ever applied. A report
 * that no longer matches the task is said to be stale, and is not applied.
 */
export function CheckReportDialog({
  task,
  number,
  list,
  checks,
  onClose,
  onApply,
  onCheckAgain,
  onNewResearch,
}: CheckReportDialogProps) {
  const t = useTaskT();
  const common = useT();
  const { state, store, client } = useBoard();
  const { check, error, retry } = useCheck(task.id, number);
  const [head, setHead] = useState<string | null | undefined>(undefined);
  const decide = useAsyncAction(
    (recommendation: string, decision: 'accepted' | 'rejected', note?: string) =>
      store.decide(task.id, number, {
        recommendation,
        decision,
        ...(note === undefined ? {} : { note }),
      }),
  );

  const research = check?.begin.kind === 'research';
  const report = check?.report;
  const markdown = useReportMarkdown(task.id, number, research && report !== undefined);
  const stale =
    check === undefined ? undefined : staleness(task, list, { version: check.begin.version });
  const staleText = stale === undefined ? undefined : stalenessText(stale);
  const superseded = isSuperseded(checks ?? [], number);

  // The evidence of read-only (R6): facts about the tree, the documents and HEAD, never blame.
  const tree = check === undefined ? undefined : treeChange(check);
  const documents = state.documents[task.id];
  const begunDocuments = research ? check?.begin.documents : undefined;
  const changedDocuments = documentChanges(begunDocuments, documents);
  const reportHead = report?.repo?.head ?? null;
  const movedOn = report !== undefined && movedOnSince(report.repo, head);

  useEffect(() => {
    if (begunDocuments === undefined || documents !== undefined) return;
    store.loadDocuments(task.id).catch(() => undefined);
  }, [store, task.id, begunDocuments, documents]);

  useEffect(() => {
    if (reportHead === null) return;
    let alive = true;
    // HEAD as it is now; a repository that cannot be read says nothing.
    client.gitCommits(1).then(
      (commits) => alive && setHead(commits[0]?.sha ?? null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, reportHead]);

  const axes = (recommendation: Recommendation) =>
    recommendationState(task, list, checks ?? [], check!, recommendation);
  const accepted = (report?.recommendations ?? []).filter(
    (recommendation) => check !== undefined && decisionOf(check, recommendation.id) === 'accepted',
  );
  // An edit aimed at a document or a file is applied by nobody (R4): it is said, not drafted.
  const elsewhere = (recommendation: Recommendation) =>
    recommendation.edit !== undefined &&
    axes(recommendation).application.state === 'not-applicable';
  const applicable = accepted.filter((r) => r.edit !== undefined && !elsewhere(r));

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
        title: t('check.reconcileTitle', { task: task.id, check: checkId(task.id, number) }),
      });
      return;
    }
    const result = applyRecommendations(
      content,
      accepted.filter((r) => !elsewhere(r)),
    );
    onApply({
      draft: result.content,
      fromCheck: { check: number, recommendations: result.applied, basis },
      notApplied: [
        ...result.notApplied.map(({ id, reason }) => ({
          id,
          text: accepted.find((r) => r.id === id)?.text ?? id,
          reason: t(`check.na.${reason}`),
        })),
        ...accepted
          .filter(elsewhere)
          .map(({ id, text }) => ({ id, text, reason: t('check.na.elsewhere') })),
      ],
      recommendations: accepted,
      title: t('check.applyTitle', { check: checkId(task.id, number), task: task.id }),
    });
  };

  return (
    <Modal
      title={t(research ? 'check.dialog.research' : 'check.dialog.check', {
        id: checkId(task.id, number),
      })}
      onClose={onClose}
      width="wide"
      footer={
        <>
          {report === undefined || stale === undefined ? null : stale.stale ? (
            <>
              {research ? (
                <Button onClick={onNewResearch}>{t('check.new')}</Button>
              ) : (
                <Button onClick={onCheckAgain}>{t('check.checkAgain')}</Button>
              )}
              <Button disabled={accepted.length === 0} onClick={() => apply('manual')}>
                {t('check.reconcile')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={applicable.length === 0}
              onClick={() => apply('report')}
            >
              {t('check.applyAccepted')}
            </Button>
          )}
          <Button onClick={onClose}>{common('ui.close')}</Button>
        </>
      }
    >
      {error === undefined ? null : (
        <div className="notice" role="alert">
          <span>{error}</span>
          <Button size="small" onClick={retry}>
            {common('ui.tryAgain')}
          </Button>
        </div>
      )}
      {check === undefined ? (
        error === undefined ? (
          <Text tone="muted">{t('check.loading')}</Text>
        ) : null
      ) : (
        <div className="check">
          <p className="check__meta">
            <Badge>{kindLabel(check.begin.kind)}</Badge> <Badge>{stateLabel(check.state)}</Badge>{' '}
            {report?.verdict === undefined ? null : (
              <Badge tone={report.verdict === 'current' ? 'accent' : 'warning'}>
                {verdictLabel(report.verdict)}
              </Badge>
            )}{' '}
            {superseded ? <Badge>{t('check.superseded')}</Badge> : null}{' '}
            <span>
              {t(research ? 'check.researched' : 'check.checked', {
                version: check.begin.version,
                date: formatDate(check.begin.createdAt),
                agent: check.begin.agent,
              })}
              {check.begin.model === undefined ? '' : ` (${check.begin.model})`}
            </span>
          </p>

          {staleText === undefined ? null : (
            <p className="notice" role="status">
              {staleText} {t('check.reportNotApplied')}
            </p>
          )}
          {!superseded ? null : (
            <p className="notice" role="note">
              {t('check.supersededNote')}
            </p>
          )}

          {tree === undefined ? null : (
            <p className="notice" role="status">
              {t(
                tree.files.length === 0
                  ? research
                    ? 'check.tree.research'
                    : 'check.tree.check'
                  : research
                    ? 'check.tree.researchFiles'
                    : 'check.tree.checkFiles',
                { files: tree.files.join(', ') },
              )}
              {tree.dirtyAtStart ? ` ${t('check.tree.dirtyStart')}` : ''} {t('check.tree.blame')}
            </p>
          )}
          {changedDocuments.length === 0 ? null : (
            <p className="notice" role="status">
              {t('check.docsChanged', {
                list: changedDocuments
                  .map(({ name, change }) => `${name} (${t(`check.doc.${change}`)})`)
                  .join(', '),
              })}
            </p>
          )}
          {!movedOn ? null : (
            <p className="notice" role="note">
              {t('check.movedOn', {
                made: reportHead?.slice(0, 7) ?? '',
                now: head?.slice(0, 7) ?? '',
              })}
            </p>
          )}

          {check.begin.comment === undefined ? null : (
            <section aria-label={t('check.focus')}>
              <h3 className="check__heading">{t('check.focus')}</h3>
              <p className="check__focus">{check.begin.comment}</p>
            </section>
          )}

          {report === undefined ? (
            <Text tone="muted">
              {check.state === 'failed'
                ? check.end?.exitCode === undefined || check.end.exitCode === 0
                  ? t(research ? 'check.ended.research' : 'check.ended.check')
                  : t(research ? 'check.endedCode.research' : 'check.endedCode.check', {
                      code: check.end.exitCode,
                    })
                : t(research ? 'check.pending.research' : 'check.pending.check')}
            </Text>
          ) : (
            <>
              {!repoChanged(check) ? null : (
                <p className="notice" role="status">
                  {t(research ? 'check.repoChanged.research' : 'check.repoChanged.check', {
                    before: describeRepo(check.begin.repo),
                    after: describeRepo(report.repo),
                  })}
                </p>
              )}
              <section aria-label={t('check.summary')}>
                <h3 className="check__heading">{t('check.summary')}</h3>
                <p>{report.summary}</p>
                {report.uncertainty === undefined ? null : (
                  <p>
                    <strong>{t('check.uncertainty')}</strong> {report.uncertainty}
                  </p>
                )}
                <Text tone="muted">
                  {t('check.repoLine', {
                    before: describeRepo(check.begin.repo),
                    after: describeRepo(report.repo),
                  })}
                </Text>
              </section>

              <section aria-label={t('check.recommendations')}>
                <h3 className="check__heading">{t('check.recommendations')}</h3>
                {decide.error === undefined ? null : (
                  <p className="form__error" role="alert">
                    {decide.error}
                  </p>
                )}
                {report.recommendations.length === 0 ? (
                  <Text tone="muted">{t('check.none')}</Text>
                ) : (
                  <ul className="check__list">
                    {report.recommendations.map((recommendation) => (
                      <RecommendationItem
                        key={recommendation.id}
                        check={check}
                        task={task}
                        recommendation={recommendation}
                        labels={axisLabels(axes(recommendation))}
                        pending={decide.pending}
                        onDecide={(decision, note) => decide.run(recommendation.id, decision, note)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {!research ? null : (
                <section aria-label={t('check.report')}>
                  <details className="check__report">
                    <summary className="check__heading">{t('check.report')}</summary>
                    {markdown.error !== undefined ? (
                      <p className="form__error" role="alert">
                        {markdown.error}
                      </p>
                    ) : markdown.markdown === undefined ? (
                      <Text tone="muted">{t('check.loading')}</Text>
                    ) : (
                      <Markdown headingLevel={4}>{markdown.markdown}</Markdown>
                    )}
                  </details>
                </section>
              )}

              <section aria-label={t('check.findings')}>
                <h3 className="check__heading">{t('check.findings')}</h3>
                {report.findings.length === 0 ? (
                  <Text tone="muted">{t('check.none')}</Text>
                ) : (
                  <ul className="check__list">
                    {report.findings.map((finding) => (
                      <li key={finding.id}>
                        <strong>{finding.title}</strong>{' '}
                        <Badge title={t('check.findingId')}>{finding.id}</Badge>
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
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function targetText(target: RecommendationTarget): string {
  return target.kind === 'task'
    ? taskT('check.target.task')
    : target.kind === 'document'
      ? taskT('check.target.document', { name: target.name })
      : taskT('check.target.file', { ref: target.ref });
}

function RecommendationItem({
  check,
  task,
  recommendation,
  labels,
  pending,
  onDecide,
}: {
  check: Check;
  task: Task;
  recommendation: Recommendation;
  labels: ReturnType<typeof axisLabels>;
  pending: boolean;
  onDecide: (decision: 'accepted' | 'rejected', note?: string) => Promise<boolean>;
}) {
  const t = useTaskT();
  const common = useT();
  const latest = latestDecisions(check.decisions).get(recommendation.id);
  const state = latest?.decision ?? 'undecided';
  const edit = recommendation.edit;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);

  const reject = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // A blank reason is no reason: none is sent (ADR-0030 §2, `note`).
    if (await onDecide('rejected', /\S/.test(reason) ? reason : undefined)) {
      setRejecting(false);
      setReason('');
    }
  };

  return (
    <li className="check__recommendation">
      <p>
        <Badge title={t('check.recId')}>{recommendation.id}</Badge> {recommendation.text}
      </p>
      {recommendation.targets === undefined ? null : (
        <p className="check__edit">
          {t('check.aimedAt', { targets: recommendation.targets.map(targetText).join(', ') })}
        </p>
      )}
      {edit === undefined ? (
        <Text tone="muted">{t('check.advice')}</Text>
      ) : (
        <p className="check__edit">
          {edit.field === 'title' ? (
            <>
              {t('check.edit.title')} <q>{edit.value}</q>
            </>
          ) : edit.field === 'labels' ? (
            <>
              {t('check.edit.labels')} {edit.add.map((label) => `+${label}`).join(' ')}{' '}
              {edit.remove.map((label) => `−${label}`).join(' ')}
            </>
          ) : (
            <>
              {t('check.edit.replace')} <q>{edit.find}</q> {t('check.edit.with')}{' '}
              <q>{edit.replace}</q>
              {occurrences(task.body, edit.find) === 1 ? null : (
                <span> {t('check.edit.notOnce')}</span>
              )}
            </>
          )}
        </p>
      )}
      {/* Three values, each derived on its own (ADR-0030 R5): none is read from another. */}
      <p className="check__decision">
        <span title={t('check.decision')}>{labels.decision}</span> ·{' '}
        <span title={t('check.application')}>{labels.application}</span> ·{' '}
        <span title={t('check.currency')}>{labels.currency}</span>
        {latest?.note === undefined ? null : <span> — {latest.note}</span>}
      </p>
      <div className="check__actions">
        <Button
          size="small"
          aria-label={t('check.acceptId', { id: recommendation.id })}
          aria-pressed={state === 'accepted'}
          disabled={pending || state === 'accepted'}
          onClick={() => void onDecide('accepted')}
        >
          {t('check.accept')}
        </Button>
        <Button
          size="small"
          aria-label={t('check.rejectId', { id: recommendation.id })}
          aria-pressed={state === 'rejected'}
          aria-expanded={rejecting}
          disabled={pending || state === 'rejected'}
          onClick={() => setRejecting(true)}
        >
          {t('check.reject')}
        </Button>
      </div>
      {!rejecting ? null : (
        <form className="check__reject" onSubmit={(event) => void reject(event)}>
          <Field label={t('check.why', { id: recommendation.id })}>
            {(id) => (
              <Textarea
                id={id}
                ref={reasonRef}
                rows={2}
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          <div className="check__actions">
            <Button
              size="small"
              type="submit"
              aria-label={t('check.confirmReject', { id: recommendation.id })}
              disabled={pending}
            >
              {t('check.reject')}
            </Button>
            <Button size="small" onClick={() => setRejecting(false)}>
              {common('ui.cancel')}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
