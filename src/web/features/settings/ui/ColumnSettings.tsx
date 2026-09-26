import {
  WORKFLOW_FLAGS,
  type WorkflowOverrides,
  type WorkflowSettings,
} from '../../../../contract/v1/index';
import { Button, Field, Select, type SelectOption } from '../../../shared/ui/index';
import {
  effectiveFlag,
  inactiveFlags,
  removeColumn,
  setColumnFlag,
  type Effective,
} from '../model/draft';
import { INACTIVE_NOTE, SOURCE_LABELS, WORKFLOW_LABELS, onOff } from '../model/labels';

export interface ColumnSettingsProps {
  status: string;
  overrides: WorkflowOverrides;
  defaults: WorkflowSettings;
  onChange: (change: (current: WorkflowOverrides) => WorkflowOverrides) => void;
}

const INHERIT = 'inherit';

/**
 * One column: each of the six flags is "as the board" (and what that is now), on, or off. What
 * is in effect and where it comes from is said under every control, so nobody has to add up
 * the levels in their head.
 */
export function ColumnSettings({ status, overrides, defaults, onChange }: ColumnSettingsProps) {
  const inactive = inactiveFlags(overrides, defaults, status);

  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">{`Column ${status}`}</legend>
      {WORKFLOW_FLAGS.map((key) => {
        const own = overrides.statuses[status]?.[key];
        const board = effectiveFlag(overrides, defaults, key);
        const { value, source }: Effective = effectiveFlag(overrides, defaults, key, status);
        const muted = inactive.includes(key);
        const options: SelectOption[] = [
          { value: INHERIT, label: `Same as the board (now ${onOff(board.value)})` },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ];
        const hint = [
          `In effect: ${onOff(value)}, from ${SOURCE_LABELS[source]}.`,
          muted ? INACTIVE_NOTE : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <Field key={key} label={WORKFLOW_LABELS[key].label} hint={hint} muted={muted}>
            {(id, hintId) => (
              <Select
                id={id}
                aria-describedby={hintId}
                options={options}
                value={own === undefined ? INHERIT : own ? 'on' : 'off'}
                onChange={(event) => {
                  const chosen = event.target.value;
                  onChange((current) =>
                    setColumnFlag(
                      current,
                      status,
                      key,
                      chosen === INHERIT ? INHERIT : chosen === 'on',
                    ),
                  );
                }}
              />
            )}
          </Field>
        );
      })}
    </fieldset>
  );
}

export interface StaleColumnProps {
  status: string;
  overrides: WorkflowOverrides;
  onChange: ColumnSettingsProps['onChange'];
}

/** A column of the file that the board no longer has: shown, never silently dropped. */
export function StaleColumn({ status, overrides, onChange }: StaleColumnProps) {
  const flags = overrides.statuses[status] ?? {};
  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">{`Column ${status} (not a status of this board)`}</legend>
      <ul className="settings__stale">
        {WORKFLOW_FLAGS.flatMap((key) => {
          const value = flags[key];
          return value === undefined
            ? []
            : [
                <li key={key}>
                  {WORKFLOW_LABELS[key].label}: {onOff(value)}
                </li>,
              ];
        })}
      </ul>
      <Button size="small" onClick={() => onChange((current) => removeColumn(current, status))}>
        {`Remove the settings of ${status}`}
      </Button>
    </fieldset>
  );
}
