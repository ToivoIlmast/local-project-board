import { Menu } from '../../../shared/ui/index';
import { useSendToAi, type AgentTarget } from '../model/useSendToAi';

export interface SendToAiProps {
  taskId: string;
  /** Further ways to send the task, shown after "Copy handoff"; by default `AGENT_TARGETS`. */
  targets?: readonly AgentTarget[] | undefined;
}

/** "Send to AI" in the details of a task: a menu, and what came of choosing from it. */
export function SendToAi({ taskId, targets }: SendToAiProps) {
  const { items, done, error } = useSendToAi(taskId, targets);

  return (
    <>
      <Menu label="Send to AI" items={items} appearance="button">
        Send to AI <span aria-hidden="true">▾</span>
      </Menu>
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
