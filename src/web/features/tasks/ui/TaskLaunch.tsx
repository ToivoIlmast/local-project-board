import type { Task } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { useTaskT } from '../i18n/details';
import { launchView } from '../model/launchView';

/**
 * The last request of Claude Code on this task, as the board holds it (ADR-0029 T94, K12): sent
 * and not begun, or reported as not started. Static: no spinner and no "is starting". Only the
 * run itself, `aiRun.working`, says that Claude Code has started; then this says nothing.
 */
export function TaskLaunch({ task }: { task: Task }) {
  const t = useTaskT();
  const view = launchView(task);
  if (view.kind === 'none') return null;
  if (view.kind === 'sent') {
    const time = formatDate(view.at);
    return (
      <p className="notice" role="status">
        {view.reports
          ? t('ai.launchView.sent', { time })
          : t('ai.launchView.sentEarlier', { time })}
      </p>
    );
  }
  const { failure } = view;
  return (
    <div className="notice" role="alert">
      <strong>{t('ai.launchView.failed')}</strong>
      <p>{t(`ai.launchView.why.${failure.kind}`)}</p>
      {/* The runner's words are text, never markup (K10). */}
      {failure.message === undefined ? null : (
        <p>
          {t('ai.launchView.runnerSaid')} {failure.message}
        </p>
      )}
      <p>{t('ai.launchView.reportedAt', { time: formatDate(failure.at) })}</p>
    </div>
  );
}
