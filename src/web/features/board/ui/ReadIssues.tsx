import type { Project } from '../../../../contract/v1/index';
import { useBoardT } from '../i18n';

export interface ReadIssuesProps {
  issues: Project['readIssues'];
}

/** Files the board could not read. They are not tasks and are never shown as ones (ADR-0022). */
export function ReadIssues({ issues }: ReadIssuesProps) {
  const t = useBoardT();
  if (issues.length === 0) return null;
  return (
    <div className="read-issues" role="alert">
      <p className="read-issues__title">{t('readIssues.title', { count: issues.length })}</p>
      <ul>
        {issues.map((issue) => (
          <li key={issue.file}>
            <code>{issue.file}</code> — {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
