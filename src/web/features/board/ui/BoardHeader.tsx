import type { GitStatus, Project } from '../../../../contract/v1/index';
import type { ConnectionStatus } from '../../../api/index';
import { Badge, Button, IconButton } from '../../../shared/ui/index';

export interface BoardHeaderProps {
  project: Project;
  git: GitStatus | undefined;
  connection: ConnectionStatus;
  onNewTask: () => void;
  onReload: () => void;
  onShowPanel: (panel: 'reports' | 'git' | 'instructions' | 'settings') => void;
}

export function BoardHeader({
  project,
  git,
  connection,
  onNewTask,
  onReload,
  onShowPanel,
}: BoardHeaderProps) {
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
                {git.clean ? 'clean' : `${git.files.length} changed`}
              </Badge>
            )}
          </span>
        )}
      </div>

      <div className="header__actions">
        <Button variant="primary" onClick={onNewTask}>
          New task
        </Button>
        <Button onClick={() => onShowPanel('reports')}>Reports</Button>
        <Button onClick={() => onShowPanel('git')}>Git</Button>
        <Button onClick={() => onShowPanel('instructions')}>AI instructions</Button>
        <Button onClick={() => onShowPanel('settings')}>Settings</Button>
        <IconButton label="Reload" onClick={onReload}>
          ↻
        </IconButton>
      </div>

      {connection === 'offline' ? (
        <p className="header__offline" role="status">
          The board is not answering. Live updates are off until it comes back.
        </p>
      ) : null}
    </header>
  );
}
