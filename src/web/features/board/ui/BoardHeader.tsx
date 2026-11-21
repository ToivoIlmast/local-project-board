import type { GitStatus, Project } from '../../../../contract/v1/index';
import type { ConnectionStatus } from '../../../api/index';
import { LanguageSelect } from '../../../shared/i18n/index';
import { Badge, Button, IconButton } from '../../../shared/ui/index';
import { useBoardT } from '../i18n';

export interface BoardHeaderProps {
  project: Project;
  git: GitStatus | undefined;
  connection: ConnectionStatus;
  onNewTask: () => void;
  onReload: () => void;
  onShowPanel: (panel: 'reports' | 'topics' | 'git' | 'instructions' | 'settings') => void;
  /** Opens the Archive page in the main area (`?view=archive`). */
  onShowArchive: () => void;
  archiveOpen?: boolean;
}

export function BoardHeader({
  project,
  git,
  connection,
  onNewTask,
  onReload,
  onShowPanel,
  onShowArchive,
  archiveOpen = false,
}: BoardHeaderProps) {
  const t = useBoardT();
  const branch = git?.branch ?? project.git.branch ?? null;

  return (
    <header className="header">
      <div className="header__identity">
        <h1 className="header__title">{project.name}</h1>
        {branch === null ? null : (
          <span className="header__git">
            <span aria-hidden="true">⎇</span> <span className="header__branch">{branch}</span>
            {git === undefined ? null : (
              <Badge tone={git.clean ? 'neutral' : 'warning'}>
                {git.clean ? t('header.clean') : t('header.changed', { count: git.files.length })}
              </Badge>
            )}
          </span>
        )}
      </div>

      <div className="header__actions">
        <Button variant="primary" onClick={onNewTask}>
          {t('header.new')}
        </Button>
        <Button aria-current={archiveOpen ? 'page' : undefined} onClick={onShowArchive}>
          {t('header.archive')}
        </Button>
        <Button onClick={() => onShowPanel('reports')}>{t('header.reports')}</Button>
        <Button onClick={() => onShowPanel('topics')}>{t('header.topics')}</Button>
        <Button onClick={() => onShowPanel('git')}>{t('header.git')}</Button>
        <Button onClick={() => onShowPanel('instructions')}>{t('header.instructions')}</Button>
        <Button onClick={() => onShowPanel('settings')}>{t('header.settings')}</Button>
        <IconButton label={t('header.reload')} onClick={onReload}>
          ↻
        </IconButton>
        <LanguageSelect />
      </div>

      {connection === 'offline' ? (
        <p className="header__offline" role="status">
          {t('header.offline')}
        </p>
      ) : null}
    </header>
  );
}
