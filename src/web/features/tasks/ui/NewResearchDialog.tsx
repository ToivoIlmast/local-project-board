import { useId, useState, type FormEvent } from 'react';
import { COMMENT_MAX_LENGTH, type AiRun } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useT } from '../../../shared/i18n/index';
import { Button, Field, Modal, Textarea } from '../../../shared/ui/index';
import { useTaskT } from '../i18n/details';
import { chosenModel, initialModel, researchRequest, type ModelDraft } from '../model/claudeLaunch';
import { ModelField } from './ModelField';

export interface NewResearchDialogProps {
  taskId: string;
  /** The last run of the task, for the model the dialog starts with. */
  aiRun: AiRun | undefined;
  onClose: () => void;
  /** Called with what to say once the board has handed the research to a runner. */
  onDone: (message: string) => void;
}

/**
 * Asks for a research of the task (ADR-0030 R1, ADR-0029 T54): a focus, a model, and nothing
 * else — no session, because a research is always a new one and starts no implementation. The
 * research shows in the list when the board says it began, not when this dialog closes
 * (ADR-0025).
 */
export function NewResearchDialog({ taskId, aiRun, onClose, onDone }: NewResearchDialogProps) {
  const t = useTaskT();
  const common = useT();
  const { client } = useBoard();
  const formId = useId();
  const [focus, setFocus] = useState('');
  const [model, setModel] = useState<ModelDraft>(() => initialModel(aiRun));
  const sent = chosenModel(model);

  const start = useAsyncAction(async () => {
    if (sent === null) return;
    await client.runTask(taskId, researchRequest(sent, focus));
    onDone(t('research.handed', { task: taskId }));
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!start.pending) void start.run();
  };

  return (
    <Modal
      title={t('research.title', { task: taskId })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{common('ui.cancel')}</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={sent === null || start.pending}
          >
            {start.pending ? t('research.starting') : t('research.start')}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit}>
        <p className="notice" role="note">
          {t('research.note')}
        </p>
        <Field label={t('research.focusLabel')} hint={t('research.focusHint')}>
          {(id, hintId) => (
            <Textarea
              id={id}
              aria-describedby={hintId}
              rows={4}
              maxLength={COMMENT_MAX_LENGTH}
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
            />
          )}
        </Field>
        <ModelField model={model} onChange={setModel} />
        {start.error === undefined ? null : (
          <p className="form__error" role="alert">
            {start.error}
          </p>
        )}
      </form>
    </Modal>
  );
}
