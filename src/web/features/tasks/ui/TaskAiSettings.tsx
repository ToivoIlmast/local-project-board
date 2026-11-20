import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BOARD_ONLY_WORKFLOW_KEYS,
  WORKFLOW_FLAGS,
  type Task,
  type TaskWorkflowOverrides,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useUnsavedChanges } from '../../../shared/hooks/unsavedChanges';
import { useStatusLabel, useT } from '../../../shared/i18n/index';
import { Button, Text } from '../../../shared/ui/index';
import {
  FlagChoice,
  inEffectText,
  inactiveNote,
  LanguageChoice,
  WORKFLOW_LABELS,
  boardValueText,
  effectiveFlag,
  effectiveLanguage,
  languageLabel,
  onOff,
  setFlag,
  setTaskLanguage,
  sourceLabel,
  useOverridesDraft,
  useSettingsT,
  type DraftKit,
} from '../../settings/index';
import { useTaskT } from '../i18n/details';
import { hasOwnSettings, sameSettings, settingsRequest } from '../model/taskWorkflow';
import { useEffectiveWorkflow } from '../model/useEffectiveWorkflow';
import type { AgentTarget } from '../model/agentTarget';
import { SendToAi } from './SendToAi';

const taskKit: DraftKit<TaskWorkflowOverrides | undefined, TaskWorkflowOverrides> = {
  read: (workflow) => structuredClone(workflow ?? {}),
  same: sameSettings,
  normalize: (draft) => draft,
};

export interface TaskAiSettingsProps {
  task: Task;
  /** Further ways to send the task to an agent. */
  targets?: readonly AgentTarget[] | undefined;
}

/**
 * How an agent will work on this task, and the exceptions this task makes. What is shown as in
 * effect is the board's own answer; what is edited and stored is the overrides of the task and
 * nothing else — an effective value is never sent back as one (ADR-0028). The settings of the
 * board and the columns are not touched from here.
 */
export function TaskAiSettings({ task, targets }: TaskAiSettingsProps) {
  const { state, store } = useBoard();
  // The sentences built from the words of the settings, and the words of this block.
  const words = useSettingsT();
  const t = useTaskT();
  const common = useT();
  const statusLabel = useStatusLabel();
  const form = useOverridesDraft(task.workflow, taskKit);
  const [asked, setAsked] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggleRef = useRef(false);

  // Nothing to fold away where the task makes an exception, or where somebody is editing one.
  const exceptions = hasOwnSettings(task.workflow) || form.dirty;
  const open = exceptions || asked;
  const read = useEffectiveWorkflow(task, open);

  // The button that was pressed to fold the block away is gone with it; the focus goes to the
  // one that opens it again rather than to the top of the page.
  useEffect(() => {
    if (!open && focusToggleRef.current) {
      focusToggleRef.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);

  const send = useAsyncAction(async (mode: 'save' | 'reset') => {
    const push = async (draft: TaskWorkflowOverrides): Promise<void> => {
      const request = settingsRequest(draft);
      // Set before the request: the board's answer folds the block away before this resumes.
      focusToggleRef.current = request === null;
      try {
        await store.updateTask(task.id, { workflow: request });
      } catch (error) {
        focusToggleRef.current = false;
        throw error;
      }
    };
    // A reset is a save of "nothing"; whatever was typed goes with it.
    await (mode === 'reset' ? form.save(push, {}) : form.save(push));
    setAsked(false);
  });

  useUnsavedChanges({
    dirty: form.dirty,
    what: t('ai.settings.what', { task: task.id }),
    note: form.changedElsewhere ? t('ai.settings.elsewhereNote') : undefined,
    save: () => send.attempt('save'),
    discard: form.discard,
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (form.dirty && !send.pending) void send.run('save');
  };

  const canSay = state.workflow;
  const effective = read.effective;

  const boardLanguage =
    canSay === undefined ? undefined : effectiveLanguage(canSay, canSay.defaults);
  // The column is named as the board names it: the four standard statuses in the language shown.
  const column = statusLabel(task.status);
  const languageInheritLabel =
    boardLanguage === undefined
      ? words('task.languageInheritPlain')
      : words('task.languageInherit', {
          value: languageLabel(boardLanguage.value ?? 'en'),
          source: sourceLabel(boardLanguage.source, column),
        });
  const languageHint = [
    effective === undefined
      ? read.error === undefined
        ? words('task.reading')
        : words('task.readFailed')
      : inEffectText(
          languageLabel(effective.values.reportLanguage ?? 'en'),
          sourceLabel(effective.sources.reportLanguage, column),
        ),
    form.draft.reportLanguage !== task.workflow?.reportLanguage ? words('task.unsaved') : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="ai" aria-labelledby={`ai-${task.id}`}>
      <div className="ai__head">
        <h3 className="ai__title" id={`ai-${task.id}`}>
          {t('ai.settings.title')}
        </h3>
        <SendToAi task={task} targets={targets} reasons={state.readiness[task.id]} />
      </div>

      {exceptions ? null : (
        <div className="ai__summary">
          <Text tone="muted">{t('ai.settings.usesColumn', { column })}</Text>
          <Button
            size="small"
            ref={toggleRef}
            aria-expanded={open}
            onClick={() => setAsked(!asked)}
          >
            {open ? t('ai.settings.hide') : t('ai.settings.customize')}
          </Button>
        </div>
      )}

      {!open ? null : (
        <form className="form" onSubmit={submit}>
          {form.changedElsewhere ? (
            <div className="notice" role="status">
              <span>{t('ai.settings.changedElsewhere')}</span>
              <Button size="small" onClick={form.takeElsewhere}>
                {t('ai.settings.loadNew')}
              </Button>
            </div>
          ) : null}

          <fieldset className="settings__group">
            <legend className="settings__legend">{t('ai.settings.legend')}</legend>
            {WORKFLOW_FLAGS.map((key) => {
              const inherited =
                canSay === undefined
                  ? undefined
                  : effectiveFlag(canSay, canSay.defaults, key, task.status);
              const muted = effective?.inactive.includes(key) ?? false;
              const unsaved = form.draft[key] !== task.workflow?.[key];
              const hint = [
                effective === undefined
                  ? read.error === undefined
                    ? words('task.reading')
                    : words('task.readFailed')
                  : inEffectText(
                      onOff(effective.values[key]),
                      sourceLabel(effective.sources[key], column),
                    ),
                muted ? inactiveNote() : undefined,
                unsaved ? words('task.unsaved') : undefined,
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <FlagChoice
                  key={key}
                  flag={key}
                  own={form.draft[key]}
                  inheritLabel={
                    inherited === undefined
                      ? words('task.inheritPlain')
                      : words('task.inherit', {
                          value: onOff(inherited.value),
                          source: sourceLabel(inherited.source, column),
                        })
                  }
                  hint={hint}
                  muted={muted}
                  onChange={(chosen) => form.edit((current) => setFlag(current, key, chosen))}
                />
              );
            })}
            <LanguageChoice
              own={form.draft.reportLanguage}
              inheritLabel={languageInheritLabel}
              hint={languageHint}
              onChange={(chosen) => form.edit((current) => setTaskLanguage(current, chosen))}
            />
          </fieldset>

          {effective === undefined ? null : (
            <>
              <Text tone="muted">{t('ai.settings.boardOnly')}</Text>
              <dl className="ai__values">
                {BOARD_ONLY_WORKFLOW_KEYS.map((key) => (
                  <div key={key} className="ai__value">
                    <dt>{WORKFLOW_LABELS[key].label}</dt>
                    <dd>
                      {words('task.valueFrom', {
                        value: boardValueText(key, effective.values, statusLabel),
                        source: sourceLabel(effective.sources[key], column),
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {read.error === undefined ? null : (
            <div className="notice" role="alert">
              <span>{read.error}</span>
              <Button size="small" onClick={read.retry}>
                {common('ui.tryAgain')}
              </Button>
            </div>
          )}
          {send.error === undefined ? null : (
            <p className="form__error" role="alert">
              {send.error}
            </p>
          )}

          <div className="form__actions ai__actions">
            <p className="settings__saved" aria-live="polite">
              {form.saved ? t('ai.settings.saved') : null}
            </p>
            <Button type="submit" variant="primary" disabled={!form.dirty || send.pending}>
              {send.pending ? common('ui.saving') : common('ui.save')}
            </Button>
            <Button
              disabled={!hasOwnSettings(task.workflow) || send.pending}
              onClick={() => void send.run('reset')}
            >
              {t('ai.settings.reset', { column })}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
