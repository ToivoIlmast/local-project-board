import {
  WORKFLOW_FLAGS,
  type WorkflowOverrides,
  type WorkflowSettings,
} from '../../../../contract/v1/index';
import { useStatusLabel } from '../../../shared/i18n/index';
import { Button } from '../../../shared/ui/index';
import { useSettingsT } from '../i18n/index';
import {
  effectiveFlag,
  inactiveFlags,
  removeColumn,
  setColumnFlag,
  type Effective,
} from '../model/draft';
import { inEffectText, inactiveNote, onOff, sourceLabel } from '../model/labels';
import { FlagChoice } from './FlagChoice';

export interface ColumnSettingsProps {
  status: string;
  overrides: WorkflowOverrides;
  defaults: WorkflowSettings;
  onChange: (change: (current: WorkflowOverrides) => WorkflowOverrides) => void;
}

/**
 * One column: each of the six flags is "as the board" (and what that is now), on, or off. What
 * is in effect and where it comes from is said under every control, so nobody has to add up
 * the levels in their head.
 */
export function ColumnSettings({ status, overrides, defaults, onChange }: ColumnSettingsProps) {
  const t = useSettingsT();
  const statusLabel = useStatusLabel();
  const inactive = inactiveFlags(overrides, defaults, status);

  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">
        {t('legend.column', { status: statusLabel(status) })}
      </legend>
      {WORKFLOW_FLAGS.map((key) => {
        const own = overrides.statuses[status]?.[key];
        const board = effectiveFlag(overrides, defaults, key);
        const { value, source }: Effective = effectiveFlag(overrides, defaults, key, status);
        const muted = inactive.includes(key);
        const hint = [
          inEffectText(onOff(value), sourceLabel(source)),
          muted ? inactiveNote() : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <FlagChoice
            key={key}
            flag={key}
            own={own}
            inheritLabel={t('inherit.board', { value: onOff(board.value) })}
            hint={hint}
            muted={muted}
            onChange={(chosen) =>
              onChange((current) => setColumnFlag(current, status, key, chosen))
            }
          />
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
  const t = useSettingsT();
  const statusLabel = useStatusLabel();
  const flags = overrides.statuses[status] ?? {};
  return (
    <fieldset className="settings__group">
      <legend className="settings__legend">
        {t('legend.stale', { status: statusLabel(status) })}
      </legend>
      <ul className="settings__stale">
        {WORKFLOW_FLAGS.flatMap((key) => {
          const value = flags[key];
          return value === undefined
            ? []
            : [
                <li key={key}>
                  {t('stale.flag', { label: t(`label.${key}`), value: onOff(value) })}
                </li>,
              ];
        })}
      </ul>
      <Button size="small" onClick={() => onChange((current) => removeColumn(current, status))}>
        {t('stale.remove', { status: statusLabel(status) })}
      </Button>
    </fieldset>
  );
}
