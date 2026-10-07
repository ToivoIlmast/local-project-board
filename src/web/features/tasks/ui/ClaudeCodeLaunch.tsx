import { useId, useState, type FormEvent } from 'react';
import {
  CLAUDE_MODEL_ALIASES,
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Button, Field, Input, Modal, Select, type SelectOption } from '../../../shared/ui/index';
import { setTaskLanguage } from '../../settings/index';
import type { TargetDialogProps } from '../model/agentTarget';
import {
  chosenModel,
  initialModel,
  isWorking,
  resumeBlocked,
  runRequest,
  type ModelChoice,
  type ModelDraft,
} from '../model/claudeLaunch';
import { LAUNCH_LABELS as L } from '../model/launchLabels';
import { settingsRequest } from '../model/taskWorkflow';
import { useEffectiveWorkflow } from '../model/useEffectiveWorkflow';

const MODEL_OPTIONS: SelectOption[] = [
  { value: '', label: L.model.default },
  ...CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias })),
  { value: 'other', label: L.model.other },
];

const LANGUAGE_OPTIONS: SelectOption[] = SUPPORTED_LANGUAGES.map((code) => ({
  value: code,
  label: languageName(code),
}));

/**
 * The parameters of a start of Claude Code (T38): the model, the language of the report and the
 * session — three controls and no more. The model is a parameter of this start; the language is
 * a setting of the task, so a change is saved to the task first, and a start whose language could
 * not be saved is not asked for: the session must never read a handoff in the old language.
 * Nothing is shown before the board said it (ADR-0025).
 */
export function ClaudeCodeLaunch({ task, onClose, onDone }: TargetDialogProps) {
  const { client, store } = useBoard();
  const formId = useId();
  const [model, setModel] = useState<ModelDraft>(() => initialModel(task.aiRun));
  const [language, setLanguage] = useState<SupportedLanguage | undefined>(undefined);
  const [session, setSession] = useState<'new' | 'resume'>('new');
  const read = useEffectiveWorkflow(task, true);

  const inEffect: SupportedLanguage | undefined =
    read.effective === undefined ? undefined : (read.effective.values.reportLanguage ?? 'en');
  const sent = chosenModel(model);
  const working = isWorking(task.aiRun);

  const start = useAsyncAction(async () => {
    if (sent === null || working) return;
    if (language !== undefined && inEffect !== undefined && language !== inEffect) {
      await store.updateTask(task.id, {
        workflow: settingsRequest(setTaskLanguage(task.workflow ?? {}, language)),
      });
    }
    await client.runTask(task.id, runRequest(sent));
    onDone(L.started(task.id));
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!start.pending) void start.run();
  };

  return (
    <Modal
      title={L.title(task.id)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{L.cancel}</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={working || sent === null || start.pending}
          >
            {start.pending ? L.starting : L.start}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit}>
        {working ? (
          <p className="notice" role="status">
            {L.working}
          </p>
        ) : null}

        <Field label={L.model.label} hint={L.model.hint}>
          {(id, hintId) => (
            <Select
              id={id}
              aria-describedby={hintId}
              options={MODEL_OPTIONS}
              value={model.choice}
              onChange={(event) =>
                setModel({ ...model, choice: event.target.value as ModelChoice })
              }
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
                onChange={(event) => setModel({ ...model, name: event.target.value })}
              />
            )}
          </Field>
        )}

        <Field
          label={L.language.label}
          hint={
            inEffect === undefined ? `${L.language.hint} ${L.language.reading}` : L.language.hint
          }
        >
          {(id, hintId) => (
            <Select
              id={id}
              aria-describedby={hintId}
              options={LANGUAGE_OPTIONS}
              disabled={inEffect === undefined}
              value={language ?? inEffect ?? 'en'}
              onChange={(event) => setLanguage(event.target.value as SupportedLanguage)}
            />
          )}
        </Field>

        <Field label={L.session.label} hint={L.session.blocked[resumeBlocked(task.aiRun)]}>
          {(id, hintId) => (
            <Select
              id={id}
              aria-describedby={hintId}
              options={[
                { value: 'new', label: L.session.new },
                // Never possible yet: the request has no session to name before T36.
                { value: 'resume', label: L.session.resume, disabled: true },
              ]}
              value={session}
              onChange={(event) => setSession(event.target.value as 'new' | 'resume')}
            />
          )}
        </Field>

        {read.error === undefined ? null : (
          <div className="notice" role="alert">
            <span>{read.error}</span>
            <Button size="small" onClick={read.retry}>
              {L.retry}
            </Button>
          </div>
        )}
        {start.error === undefined ? null : (
          <p className="form__error" role="alert">
            {start.error}
          </p>
        )}
      </form>
    </Modal>
  );
}
