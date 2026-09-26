import type { FormEvent } from 'react';
import type { WorkflowOverrides, WorkflowState } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Button, Text } from '../../../shared/ui/index';
import { orphanStatuses } from '../model/draft';
import { WORKFLOW_LABELS } from '../model/labels';
import { useWorkflowDraft } from '../model/useWorkflowDraft';
import { BoardSettings } from './BoardSettings';
import { ColumnSettings, StaleColumn } from './ColumnSettings';

export interface WorkflowFormProps {
  workflow: WorkflowState;
  statuses: readonly string[];
  /** Replaces the overrides of the board and its columns; rejects with the board's own message. */
  onSave: (overrides: WorkflowOverrides) => Promise<unknown>;
}

/**
 * The AI workflow settings of the board and of its columns, edited as the overrides they are
 * stored as. One button saves both sections whole (`PUT /workflow`, last write wins).
 */
export function WorkflowForm({ workflow, statuses, onSave }: WorkflowFormProps) {
  const form = useWorkflowDraft(workflow);
  const saving = useAsyncAction(async () => {
    await form.save(onSave);
  });
  const orphans = orphanStatuses(form.draft, statuses);
  const hasOrphans = orphans.columns.length > 0 || orphans.board.length > 0;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (form.dirty && !saving.pending) void saving.run();
  };

  return (
    <form className="form settings" onSubmit={submit}>
      <h3 className="settings__section">AI workflow</h3>
      <Text tone="muted">
        How an agent works on a task. Only what you change here is stored; everything else stays at
        its default, and a column that says “same as the board” follows it.
      </Text>

      {form.changedElsewhere ? (
        <div className="notice" role="status">
          <span>
            These settings were changed elsewhere — in the file or by another window. Your unsaved
            changes are kept; saving replaces the other change.
          </span>
          <Button size="small" onClick={form.takeElsewhere}>
            Load the new settings
          </Button>
        </div>
      ) : null}

      {hasOrphans ? (
        <div className="read-issues" role="alert">
          <p className="read-issues__title">
            These settings name a status this board does not have. The board refuses to save them:
            remove them or choose another status.
          </p>
          <ul>
            {orphans.columns.map((status) => (
              <li key={`column-${status}`}>Column “{status}”</li>
            ))}
            {orphans.board.map(({ key, status }) => (
              <li key={key}>
                {WORKFLOW_LABELS[key].label}: “{status}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <BoardSettings
        overrides={form.draft}
        defaults={workflow.defaults}
        statuses={statuses}
        onChange={form.edit}
      />

      <h4 className="settings__subsection">Columns</h4>
      <Text tone="muted">
        A column can differ from the board. “Same as the board” stores nothing for it.
      </Text>
      {statuses.map((status) => (
        <ColumnSettings
          key={status}
          status={status}
          overrides={form.draft}
          defaults={workflow.defaults}
          onChange={form.edit}
        />
      ))}
      {orphans.columns.map((status) => (
        <StaleColumn key={status} status={status} overrides={form.draft} onChange={form.edit} />
      ))}

      <Text tone="muted">
        Project rules (ai.rules) are not settings; they are kept in board.config.yaml.
      </Text>

      {saving.error === undefined ? null : (
        <p className="form__error" role="alert">
          {saving.error}
        </p>
      )}
      <div className="form__actions settings__actions">
        <p className="settings__saved" aria-live="polite">
          {form.saved ? 'Saved.' : null}
        </p>
        <Button type="submit" variant="primary" disabled={!form.dirty || saving.pending}>
          {saving.pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
