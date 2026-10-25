import { CLAUDE_MODEL_ALIASES } from '../../../../contract/v1/index';
import { Field, Input, Select, type SelectOption } from '../../../shared/ui/index';
import { chosenModel, type ModelChoice, type ModelDraft } from '../model/claudeLaunch';
import { LAUNCH_LABELS as L } from '../model/launchLabels';

const MODEL_OPTIONS: SelectOption[] = [
  { value: '', label: L.model.default },
  ...CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias })),
  { value: 'other', label: L.model.other },
];

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
  const sent = chosenModel(model);
  return (
    <>
      <Field label={L.model.label} hint={L.model.hint}>
        {(id, hintId) => (
          <Select
            id={id}
            aria-describedby={hintId}
            options={MODEL_OPTIONS}
            value={model.choice}
            onChange={(event) => onChange({ ...model, choice: event.target.value as ModelChoice })}
          />
        )}
      </Field>
      {model.choice !== 'other' ? null : (
        <Field
          label={L.model.name}
          hint={sent === null && model.name !== '' ? L.model.invalid : L.model.nameHint}
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
