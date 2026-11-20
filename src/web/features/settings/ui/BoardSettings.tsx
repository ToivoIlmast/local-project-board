import {
  WORKFLOW_FLAGS,
  type WorkflowOverrides,
  type WorkflowSettings,
} from '../../../../contract/v1/index';
import { useStatusLabel } from '../../../shared/i18n/index';
import { Checkbox, Field, Input, Select, type SelectOption } from '../../../shared/ui/index';
import {
  effectiveFlag,
  inactiveFlags,
  setBoardCommitLanguage,
  setBoardFlag,
  setBoardLanguage,
  setBoardValue,
} from '../model/draft';
import { useSettingsT } from '../i18n/index';
import { inEffectText, inactiveNote, onOff, sourceLabel } from '../model/labels';
import { BoardLanguage, CommitLanguage } from './LanguageChoice';

export interface BoardSettingsProps {
  overrides: WorkflowOverrides;
  defaults: WorkflowSettings;
  statuses: readonly string[];
  onChange: (change: (current: WorkflowOverrides) => WorkflowOverrides) => void;
}

/** The settings of the whole board: six on/off flags, two statuses, two texts and the languages of the commits and of the report. */
export function BoardSettings({ overrides, defaults, statuses, onChange }: BoardSettingsProps) {
  const t = useSettingsT();
  const inactive = inactiveFlags(overrides, defaults);

  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">{t('legend.board')}</legend>

      {WORKFLOW_FLAGS.map((key) => {
        const { value, source } = effectiveFlag(overrides, defaults, key);
        const muted = inactive.includes(key);
        const hint = [
          t(`description.${key}`),
          inEffectText(onOff(value), sourceLabel(source)),
          muted ? inactiveNote() : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <Checkbox
            key={key}
            label={t(`label.${key}`)}
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

      <CommitLanguage
        value={overrides.board.commitLanguage}
        onChange={(language) => onChange((current) => setBoardCommitLanguage(current, language))}
      />

      <BoardLanguage
        value={overrides.board.reportLanguage}
        onChange={(language) => onChange((current) => setBoardLanguage(current, language))}
      />
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
  const t = useSettingsT();
  // Only the words shown: the value of each option is the status itself.
  const statusLabel = useStatusLabel();
  const stored = overrides.board[settingKey];
  const fallback = defaults[settingKey];
  const options: SelectOption[] = [
    {
      value: DEFAULT,
      label: t('status.default', {
        value: fallback === null ? t('status.keep') : statusLabel(fallback),
      }),
    },
    ...statuses.map((status) => ({ value: `${STATUS}${status}`, label: statusLabel(status) })),
    { value: NONE, label: t('status.keepChoice') },
  ];
  // A status the board no longer has stays visible instead of turning into some other choice.
  if (typeof stored === 'string' && !statuses.includes(stored)) {
    options.splice(1, 0, {
      value: `${STATUS}${stored}`,
      label: t('status.unknown', { status: statusLabel(stored) }),
    });
  }
  const value = stored === undefined ? DEFAULT : stored === null ? NONE : `${STATUS}${stored}`;

  return (
    <Field label={t(`label.${settingKey}`)} hint={t(`description.${settingKey}`)}>
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
  settingKey: 'baseBranch' | 'checkCommand';
  overrides: WorkflowOverrides;
  onChange: BoardSettingsProps['onChange'];
}

/** A text; empty is the default, so there is nothing to choose between "empty" and "missing". */
function TextSetting({ settingKey, overrides, onChange }: TextSettingProps) {
  const t = useSettingsT();
  const stored = overrides.board[settingKey];
  return (
    <Field label={t(`label.${settingKey}`)} hint={t(`description.${settingKey}`)}>
      {(id, hintId) => (
        <Input
          id={id}
          aria-describedby={hintId}
          value={typeof stored === 'string' ? stored : ''}
          // A branch or a command is written left to right in every language of the page.
          dir="ltr"
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
