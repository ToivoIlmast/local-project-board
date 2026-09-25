import { useEffect, useState } from 'react';
import type { GitCommit } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, EmptyState, Panel, Spinner, Text } from '../../../shared/ui/index';

export interface GitPanelProps {
  onClose: () => void;
}

/** Git as context for the work, not a git client: the branch, what changed, and the diff. */
export function GitPanel({ onClose }: GitPanelProps) {
  const { state, client } = useBoard();
  const git = state.git;
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    client.gitCommits(10).then(
      (recent) => alive && setCommits(recent),
      () => alive && setCommits([]),
    );
    return () => {
      alive = false;
    };
  }, [client]);

  const show = (path: string): void => {
    setDiff(null);
    setDiffError(undefined);
    client.gitDiff({ path }).then(
      (result) => setDiff({ path, ...result }),
      (error: Error) => setDiffError(error.message),
    );
  };

  return (
    <Panel label="Git">
      <header className="panel__head">
        <h2 className="panel__title">Git</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      {git === undefined ? (
        <EmptyState title="No git information">
          <p>This board is not inside a repository, or git could not be read.</p>
        </EmptyState>
      ) : (
        <>
          <p className="git__branch">
            <span aria-hidden="true">⎇</span> <strong>{git.branch ?? 'detached HEAD'}</strong>{' '}
            <Badge tone={git.clean ? 'neutral' : 'warning'}>
              {git.clean ? 'clean' : 'uncommitted changes'}
            </Badge>
          </p>

          <h3 className="git__section">Changed files</h3>
          {git.files.length === 0 ? (
            <Text tone="muted">Nothing changed.</Text>
          ) : (
            <ul className="git__files">
              {git.files.map((file) => (
                <li key={`${file.path}-${String(file.staged)}`}>
                  <button type="button" className="git__file" onClick={() => show(file.path)}>
                    {file.path}
                  </button>
                  <Badge tone={file.staged ? 'accent' : 'neutral'}>
                    {file.staged ? `staged ${file.status}` : file.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {diffError !== undefined ? <p className="form__error">{diffError}</p> : null}
          {diff === null ? null : (
            <section className="git__diff" aria-label={`Diff of ${diff.path}`}>
              <h3 className="git__section">{diff.path}</h3>
              <pre className="git__diff-text" tabIndex={0} role="region" aria-label="Diff text">
                {diff.text === '' ? 'No changes.' : diff.text}
              </pre>
              {diff.truncated ? <Text tone="muted">The diff was cut off.</Text> : null}
            </section>
          )}

          <h3 className="git__section">Recent commits</h3>
          {commits === null ? (
            <Spinner label="Loading commits…" />
          ) : commits.length === 0 ? (
            <Text tone="muted">No commits.</Text>
          ) : (
            <ul className="git__commits">
              {commits.map((commit) => (
                <li key={commit.sha}>
                  <code className="git__sha">{commit.sha.slice(0, 7)}</code> {commit.subject}
                  <span className="git__author">
                    {' '}
                    — {commit.author}, {formatDate(commit.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
