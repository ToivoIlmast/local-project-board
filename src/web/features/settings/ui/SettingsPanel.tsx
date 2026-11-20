import { useBoard } from '../../../api/react';
import { useT } from '../../../shared/i18n/index';
import { Button, Panel, Spinner } from '../../../shared/ui/index';
import { useSettingsT } from '../i18n/index';
import { WorkflowForm } from './WorkflowForm';

export interface SettingsPanelProps {
  onClose: () => void;
}

/**
 * The settings of the board. For now they are the AI workflow ones; the panel is where the rest
 * would go. What it shows is the board's own answer — the form keeps only what is being typed.
 */
export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { state, store } = useBoard();
  const t = useSettingsT();
  const common = useT();
  const { project, workflow } = state;

  return (
    <Panel label={t('title')}>
      <header className="panel__head">
        <h2 className="panel__title">{t('title')}</h2>
        <Button size="small" onClick={onClose}>
          {common('ui.close')}
        </Button>
      </header>

      {project === undefined || workflow === undefined ? (
        <Spinner label={t('panel.loading')} />
      ) : (
        <WorkflowForm
          workflow={workflow}
          statuses={project.statuses}
          onSave={(overrides) => store.updateWorkflow(overrides)}
        />
      )}
    </Panel>
  );
}
