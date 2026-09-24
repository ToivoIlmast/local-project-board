import type { Project } from '../../../../contract/v1/index';

export interface ReadIssuesProps {
  issues: Project['readIssues'];
}

/** Files the board could not read. They are not tasks and are never shown as ones (ADR-0022). */
export function ReadIssues({ issues }: ReadIssuesProps) {
  if (issues.length === 0) return null;
  return (
    <div className="read-issues" role="alert">
      <p className="read-issues__title">
        {issues.length === 1
          ? '1 file in this board could not be read:'
          : `${issues.length} files in this board could not be read:`}
      </p>
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
