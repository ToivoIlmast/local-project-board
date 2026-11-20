import type { FormEvent } from 'react';
import type { WorkflowOverrides, WorkflowState } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useUnsavedChanges } from '../../../shared/hooks/unsavedChanges';
import { useStatusLabel, useT } from '../../../shared/i18n/index';
import { Button, Text } from '../../../shared/ui/index';
import { useSettingsT } from '../i18n/index';
import { orphanStatuses } from '../model/draft';
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
  const t = useSettingsT();
  const common = useT();
  const statusLabel = useStatusLabel();
  const form = useWorkflowDraft(workflow);
  const saving = useAsyncAction(async () => {
    await form.save(onSave);
  });
  useUnsavedChanges({
    dirty: form.dirty,
    what: t('unsaved.what'),
    note: form.changedElsewhere ? t('elsewhere.note') : undefined,
    save: () => saving.attempt(),
    discard: form.discard,
  });
  const orphans = orphanStatuses(form.draft, statuses);
  const hasOrphans = orphans.columns.length > 0 || orphans.board.length > 0;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (form.dirty && !saving.pending) void saving.run();
  };

  return (
    <form className="form settings" onSubmit={submit}>
      <h3 className="settings__section">{t('form.title')}</h3>
      <Text tone="muted">{t('form.intro')}</Text>

      {form.changedElsewhere ? (
        <div className="notice" role="status">
          <span>{t('elsewhere')}</span>
          <Button size="small" onClick={form.takeElsewhere}>
            {t('elsewhere.load')}
          </Button>
        </div>
      ) : null}

      {hasOrphans ? (
        <div className="read-issues" role="alert">
          <p className="read-issues__title">{t('orphans.title')}</p>
          <ul>
            {orphans.columns.map((status) => (
              <li key={`column-${status}`}>
                {t('orphans.column', { status: statusLabel(status) })}
              </li>
            ))}
            {orphans.board.map(({ key, status }) => (
              <li key={key}>
                {t('orphans.setting', { label: t(`label.${key}`), status: statusLabel(status) })}
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

      <h4 className="settings__subsection">{t('columns')}</h4>
      <Text tone="muted">{t('columns.intro')}</Text>
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

      <Text tone="muted">{t('rules')}</Text>

      {saving.error === undefined ? null : (
        <p className="form__error" role="alert">
          {saving.error}
        </p>
      )}
      <div className="form__actions settings__actions">
        <p className="settings__saved" aria-live="polite">
          {form.saved ? t('saved') : null}
        </p>
        <Button type="submit" variant="primary" disabled={!form.dirty || saving.pending}>
          {saving.pending ? common('ui.saving') : common('ui.save')}
        </Button>
      </div>
    </form>
  );
}
