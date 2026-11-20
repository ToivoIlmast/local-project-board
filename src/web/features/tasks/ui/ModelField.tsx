import { CLAUDE_MODEL_ALIASES } from '../../../../contract/v1/index';
import { Field, Input, Select } from '../../../shared/ui/index';
import { chosenModel, type ModelChoice, type ModelDraft } from '../model/claudeLaunch';
import { useTaskT } from '../i18n/details';

/**
 * The model of a start of Claude Code (T38): the default, an alias, or a name typed in. The same
 * control for a run of the task and for a research, so both send a model the same way.
 */
export function ModelField({
  model,
  onChange,
}: {
  model: ModelDraft;
  onChange: (next: ModelDraft) => void;
}) {
  const t = useTaskT();
  const sent = chosenModel(model);
  const options = [
    { value: '', label: t('ai.model.default') },
    // The names of the models are the model's own: they are never translated.
    ...CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias })),
    { value: 'other', label: t('ai.model.other') },
  ];
  return (
    <>
      <Field label={t('ai.model.label')} hint={t('ai.model.hint')}>
        {(id, hintId) => (
          <Select
            id={id}
            aria-describedby={hintId}
            options={options}
            value={model.choice}
            onChange={(event) => onChange({ ...model, choice: event.target.value as ModelChoice })}
          />
        )}
      </Field>
      {model.choice !== 'other' ? null : (
        <Field
          label={t('ai.model.name')}
          hint={sent === null && model.name !== '' ? t('ai.model.invalid') : t('ai.model.nameHint')}
        >
          {(id, hintId) => (
            <Input
              id={id}
              aria-describedby={hintId}
              aria-invalid={sent === null && model.name !== ''}
              autoComplete="off"
              spellCheck={false}
              value={model.name}
              onChange={(event) => onChange({ ...model, name: event.target.value })}
            />
          )}
        </Field>
      )}
    </>
  );
}
