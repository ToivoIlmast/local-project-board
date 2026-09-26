import {
  WORKFLOW_FLAGS,
  type BoardWorkflowKey,
  type WorkflowOverrides,
  type WorkflowSettings,
} from '../../../../contract/v1/index';
import { Checkbox, Field, Input, Select, type SelectOption } from '../../../shared/ui/index';
import { effectiveFlag, inactiveFlags, setBoardFlag, setBoardValue } from '../model/draft';
import { INACTIVE_NOTE, SOURCE_LABELS, WORKFLOW_LABELS, onOff } from '../model/labels';

export interface BoardSettingsProps {
  overrides: WorkflowOverrides;
  defaults: WorkflowSettings;
  statuses: readonly string[];
  onChange: (change: (current: WorkflowOverrides) => WorkflowOverrides) => void;
}

/** The settings of the whole board: six on/off flags, two statuses and two texts. */
export function BoardSettings({ overrides, defaults, statuses, onChange }: BoardSettingsProps) {
  const inactive = inactiveFlags(overrides, defaults);

  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">Board</legend>

      {WORKFLOW_FLAGS.map((key) => {
        const { value, source } = effectiveFlag(overrides, defaults, key);
        const muted = inactive.includes(key);
        const hint = [
          WORKFLOW_LABELS[key].description,
          `In effect: ${onOff(value)}, from ${SOURCE_LABELS[source]}.`,
          muted ? INACTIVE_NOTE : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <Checkbox
            key={key}
            label={WORKFLOW_LABELS[key].label}
            hint={hint}
            muted={muted}
            checked={value}
            onChange={(event) =>
              onChange((current) => setBoardFlag(current, key, event.target.checked, defaults))
            }
          />
        );
      })}

      <StatusSelect
        settingKey="startStatus"
        overrides={overrides}
        defaults={defaults}
        statuses={statuses}
        onChange={onChange}
      />
      <StatusSelect
        settingKey="finishStatus"
        overrides={overrides}
        defaults={defaults}
        statuses={statuses}
        onChange={onChange}
      />

      <TextSetting settingKey="baseBranch" overrides={overrides} onChange={onChange} />
      <TextSetting settingKey="checkCommand" overrides={overrides} onChange={onChange} />
    </fieldset>
  );
}

const DEFAULT = 'default';
const NONE = 'none';
const STATUS = 'status:';

interface StatusSelectProps extends BoardSettingsProps {
  settingKey: 'startStatus' | 'finishStatus';
}

/**
 * A status, "do not change", or nothing said. The last two are not the same: `null` is a value
 * (the default of `startStatus` is a status, so `null` is a change), a missing key is the default.
 */
function StatusSelect({ settingKey, overrides, defaults, statuses, onChange }: StatusSelectProps) {
  const stored = overrides.board[settingKey];
  const fallback = defaults[settingKey];
  const options: SelectOption[] = [
    { value: DEFAULT, label: `Default (${fallback ?? 'do not change'})` },
    ...statuses.map((status) => ({ value: `${STATUS}${status}`, label: status })),
    { value: NONE, label: 'Do not change' },
  ];
  // A status the board no longer has stays visible instead of turning into some other choice.
  if (typeof stored === 'string' && !statuses.includes(stored)) {
    options.splice(1, 0, {
      value: `${STATUS}${stored}`,
      label: `${stored} (not a status of this board)`,
    });
  }
  const value = stored === undefined ? DEFAULT : stored === null ? NONE : `${STATUS}${stored}`;

  return (
    <Field label={WORKFLOW_LABELS[settingKey].label} hint={WORKFLOW_LABELS[settingKey].description}>
      {(id, hintId) => (
        <Select
          id={id}
          aria-describedby={hintId}
          options={options}
          value={value}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange((current) =>
              setBoardValue(
                current,
                settingKey,
                chosen === DEFAULT
                  ? undefined
                  : chosen === NONE
                    ? null
                    : chosen.slice(STATUS.length),
              ),
            );
          }}
        />
      )}
    </Field>
  );
}

interface TextSettingProps {
  settingKey: Extract<BoardWorkflowKey, 'baseBranch' | 'checkCommand'>;
  overrides: WorkflowOverrides;
  onChange: BoardSettingsProps['onChange'];
}

/** A text; empty is the default, so there is nothing to choose between "empty" and "missing". */
function TextSetting({ settingKey, overrides, onChange }: TextSettingProps) {
  const stored = overrides.board[settingKey];
  return (
    <Field label={WORKFLOW_LABELS[settingKey].label} hint={WORKFLOW_LABELS[settingKey].description}>
      {(id, hintId) => (
        <Input
          id={id}
          aria-describedby={hintId}
          value={typeof stored === 'string' ? stored : ''}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            onChange((current) => setBoardValue(current, settingKey, event.target.value))
          }
        />
      )}
    </Field>
  );
}
