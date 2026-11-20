import { useEffect, useState } from 'react';
import type { GitCommit } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useT } from '../../../shared/i18n/index';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, EmptyState, Panel, Spinner, Text } from '../../../shared/ui/index';
import { useGitT } from '../i18n';

export interface GitPanelProps {
  onClose: () => void;
}

/** Git as context for the work, not a git client: the branch, what changed, and the diff. */
export function GitPanel({ onClose }: GitPanelProps) {
  const { state, client } = useBoard();
  const t = useGitT();
  const common = useT();
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
    <Panel label={t('title')}>
      <header className="panel__head">
        <h2 className="panel__title">{t('title')}</h2>
        <Button size="small" onClick={onClose}>
          {common('ui.close')}
        </Button>
      </header>

      {git === undefined ? (
        <EmptyState title={t('empty.title')}>
          <p>{t('empty.text')}</p>
        </EmptyState>
      ) : (
        <>
          <p className="git__branch">
            {/* What git gave is written left to right, also on a page that reads right to left. */}
            <span aria-hidden="true">⎇</span>{' '}
            <strong dir={git.branch === null ? undefined : 'ltr'}>
              {git.branch ?? t('detached')}
            </strong>{' '}
            <Badge tone={git.clean ? 'neutral' : 'warning'}>
              {git.clean ? t('clean') : t('dirty')}
            </Badge>
          </p>

          <h3 className="git__section">{t('files')}</h3>
          {git.files.length === 0 ? (
            <Text tone="muted">{t('none')}</Text>
          ) : (
            <ul className="git__files">
              {git.files.map((file) => (
                <li key={`${file.path}-${String(file.staged)}`}>
                  <button
                    type="button"
                    className="git__file"
                    dir="ltr"
                    onClick={() => show(file.path)}
                  >
                    {file.path}
                  </button>
                  <Badge tone={file.staged ? 'accent' : 'neutral'}>
                    {file.staged ? t('staged', { status: file.status }) : file.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {diffError !== undefined ? <p className="form__error">{diffError}</p> : null}
          {diff === null ? null : (
            <section className="git__diff" aria-label={t('diff.label', { path: diff.path })}>
              <h3 className="git__section" dir="ltr">
                {diff.path}
              </h3>
              <pre
                className="git__diff-text"
                dir={diff.text === '' ? undefined : 'ltr'}
                tabIndex={0}
                role="region"
                aria-label={t('diff.text')}
              >
                {diff.text === '' ? t('diff.empty') : diff.text}
              </pre>
              {diff.truncated ? <Text tone="muted">{t('diff.cut')}</Text> : null}
            </section>
          )}

          <h3 className="git__section">{t('commits')}</h3>
          {commits === null ? (
            <Spinner label={t('commits.loading')} />
          ) : commits.length === 0 ? (
            <Text tone="muted">{t('commits.none')}</Text>
          ) : (
            <ul className="git__commits">
              {commits.map((commit) => (
                <li key={commit.sha}>
                  <code className="git__sha" dir="ltr">
                    {commit.sha.slice(0, 7)}
                  </code>{' '}
                  {/* A subject or a name may be in any language: its own direction decides. */}
                  <bdi>{commit.subject}</bdi>
                  <span className="git__author">
                    {' '}
                    — <bdi>{commit.author}</bdi>, {formatDate(commit.date)}
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
