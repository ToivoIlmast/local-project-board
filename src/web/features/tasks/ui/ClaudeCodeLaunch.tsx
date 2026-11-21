import { useId, useState, type FormEvent } from 'react';
import {
  COMMENT_MAX_LENGTH,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useT } from '../../../shared/i18n/index';
import { Button, Field, Modal, Select, Textarea } from '../../../shared/ui/index';
import { languageOptionLabel, setTaskLanguage } from '../../settings/index';
import { useTaskT } from '../i18n/details';
import type { TargetDialogProps } from '../model/agentTarget';
import {
  chosenModel,
  commentTooLong,
  initialModel,
  isWorking,
  resumeBlocked,
  runRequest,
  type ModelDraft,
} from '../model/claudeLaunch';
import { explainError } from '../model/explainError';
import { launchNotice } from '../model/history';
import { settingsRequest } from '../model/taskWorkflow';
import { useEffectiveWorkflow } from '../model/useEffectiveWorkflow';
import { useTaskHistory } from '../model/useTaskHistory';
import { ModelField } from './ModelField';

/**
 * The parameters of a start of Claude Code (T38): the model, the language of the report and the
 * session — three controls and no more. The model is a parameter of this start; the language is
 * a setting of the task, so a change is saved to the task first, and a start whose language could
 * not be saved is not asked for: the session must never read a handoff in the old language.
 * Nothing is shown before the board said it (ADR-0025). A research still working, or
 * recommendations still undecided, are said and do not keep the run from starting (D11).
 */
export function ClaudeCodeLaunch({
  task,
  onClose,
  onDone,
  initialSession = 'new',
}: TargetDialogProps & {
  /** The session the dialog opens with; Resume of a failed run (T39) opens it on `resume`. */
  initialSession?: 'new' | 'resume';
}) {
  const t = useTaskT();
  const common = useT();
  const { client, store } = useBoard();
  const formId = useId();
  const [model, setModel] = useState<ModelDraft>(() => initialModel(task.aiRun));
  const [language, setLanguage] = useState<SupportedLanguage | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [session, setSession] = useState<'new' | 'resume'>(initialSession);
  const read = useEffectiveWorkflow(task, true);
  const research = launchNotice(useTaskHistory(task.id).history?.checks);

  // The names of the languages are said in the language shown, as the settings say them.
  const languageOptions = SUPPORTED_LANGUAGES.map((code) => ({
    value: code,
    label: languageOptionLabel(code),
  }));

  const inEffect: SupportedLanguage | undefined =
    read.effective === undefined ? undefined : (read.effective.values.reportLanguage ?? 'en');
  const sent = chosenModel(model);
  const tooLong = commentTooLong(comment);
  const working = isWorking(task.aiRun);
  const blocked = resumeBlocked(task.aiRun);
  // A Resume that is no longer possible — the run went on while the dialog was open — is not sent.
  const mode = session === 'resume' && blocked === undefined ? 'resume' : 'new';

  const start = useAsyncAction(async () => {
    if (sent === null || working || tooLong) return;
    if (language !== undefined && inEffect !== undefined && language !== inEffect) {
      await store.updateTask(task.id, {
        workflow: settingsRequest(setTaskLanguage(task.workflow ?? {}, language)),
      });
    }
    try {
      await client.runTask(task.id, runRequest(sent, mode, comment));
    } catch (error) {
      // A task that became blocked since the page last read it: the reasons are the answer.
      throw explainError(error);
    }
    onDone(t('ai.launch.sent', { task: task.id }));
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!start.pending) void start.run();
  };

  return (
    <Modal
      title={t('ai.launch.title', { task: task.id })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{common('ui.cancel')}</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={working || sent === null || tooLong || start.pending}
          >
            {start.pending ? t('ai.launch.sending') : t('ai.launch.start')}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit}>
        {working ? (
          <p className="notice" role="status">
            {t('ai.launch.working')}
          </p>
        ) : null}

        {research === undefined ? null : (
          <p className="notice" role="status">
            {research}
          </p>
        )}

        <ModelField model={model} onChange={setModel} />

        <Field
          label={t('ai.language.label')}
          hint={
            inEffect === undefined
              ? `${t('ai.language.hint')} ${t('ai.language.reading')}`
              : t('ai.language.hint')
          }
        >
          {(id, hintId) => (
            <Select
              id={id}
              aria-describedby={hintId}
              options={languageOptions}
              disabled={inEffect === undefined}
              value={language ?? inEffect ?? 'en'}
              onChange={(event) => setLanguage(event.target.value as SupportedLanguage)}
            />
          )}
        </Field>

        <Field
          label={t('ai.session.label')}
          hint={
            blocked === undefined
              ? t('ai.session.available')
              : t(blocked === 'noSession' ? 'ai.session.noSession' : 'ai.session.workingBlocked')
          }
        >
          {(id, hintId) => (
            <Select
              id={id}
              aria-describedby={hintId}
              options={[
                { value: 'new', label: t('ai.session.new') },
                // The session itself is never sent: the runner reads it from the board.
                {
                  value: 'resume',
                  label: t('ai.session.resume'),
                  disabled: blocked !== undefined,
                },
              ]}
              value={mode}
              onChange={(event) => setSession(event.target.value as 'new' | 'resume')}
            />
          )}
        </Field>

        <Field
          label={t('ai.comment.label')}
          hint={t('ai.comment.hint')}
          error={
            tooLong
              ? t('ai.comment.tooLong', { count: comment.length, max: COMMENT_MAX_LENGTH })
              : undefined
          }
        >
          {(id, hintId) => (
            <Textarea
              id={id}
              aria-describedby={hintId}
              rows={4}
              aria-invalid={tooLong}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          )}
        </Field>

        {read.error === undefined ? null : (
          <div className="notice" role="alert">
            <span>{read.error}</span>
            <Button size="small" onClick={read.retry}>
              {common('ui.tryAgain')}
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
