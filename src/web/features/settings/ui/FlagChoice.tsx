import type { WorkflowFlag } from '../../../../contract/v1/index';
import { Field, Select, type SelectOption } from '../../../shared/ui/index';
import { WORKFLOW_LABELS } from '../model/labels';

export interface FlagChoiceProps {
  flag: WorkflowFlag;
  /** What this level says about the flag; `undefined` is "says nothing", the level below applies. */
  own: boolean | undefined;
  /** The text of "says nothing", with what that gives now: only the caller knows the level below. */
  inheritLabel: string;
  /** What is in effect and where it comes from, and why it does not matter, if it does not. */
  hint: string;
  muted: boolean;
  onChange: (value: boolean | 'inherit') => void;
}

const INHERIT = 'inherit';

/**
 * One on/off setting of a column or of a task, as the three states it can have there: nothing
 * (inherit), on, or off. The columns and a task use this one control, so a setting reads the
 * same wherever it is overridden.
 */
export function FlagChoice({ flag, own, inheritLabel, hint, muted, onChange }: FlagChoiceProps) {
  const options: SelectOption[] = [
    { value: INHERIT, label: inheritLabel },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  return (
    <Field label={WORKFLOW_LABELS[flag].label} hint={hint} muted={muted}>
      {(id, hintId) => (
        <Select
          id={id}
          aria-describedby={hintId}
          options={options}
          value={own === undefined ? INHERIT : own ? 'on' : 'off'}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange(chosen === INHERIT ? INHERIT : chosen === 'on');
          }}
        />
      )}
    </Field>
  );
}
