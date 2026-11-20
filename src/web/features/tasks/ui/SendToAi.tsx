import type { BlockingReason, Task } from '../../../../contract/v1/index';
import { Menu } from '../../../shared/ui/index';
import { useTaskT } from '../i18n/details';
import { useSendToAi, type AgentTarget } from '../model/useSendToAi';

export interface SendToAiProps {
  task: Task;
  /** Further ways to send the task, shown after "Copy handoff"; by default `AGENT_TARGETS`. */
  targets?: readonly AgentTarget[] | undefined;
  /** Why the task may not start yet, as the board computed it; none, or unknown, means it may. */
  reasons?: readonly BlockingReason[] | undefined;
}

/** "Send to AI" in the details of a task: a menu, and what came of choosing from it. */
export function SendToAi({ task, targets, reasons }: SendToAiProps) {
  const t = useTaskT();
  const { items, dialog, done, error } = useSendToAi(task, targets, reasons);

  return (
    <>
      <Menu label={t('ai.send.menu')} items={items} appearance="button">
        {t('ai.send.menu')} <span aria-hidden="true">▾</span>
      </Menu>
      {dialog}
      {/* Always there, so that what is put into it is announced; empty, it takes no room. */}
      <p className="send-ai__done" aria-live="polite">
        {done}
      </p>
      {error === undefined ? null : (
        <p className="form__error send-ai__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
