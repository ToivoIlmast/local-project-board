import { useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useCopyToClipboard } from '../../../shared/hooks/useCopyToClipboard';
import { Menu, type MenuItem } from '../../../shared/ui/index';

/**
 * A way to hand a task to an agent. The menu lists the ones it is given after its own: a new
 * one is one more entry in a list, not a change to the menu.
 */
export interface AgentTarget {
  label: string;
  /** Does it for this task. A text it resolves with is said to the person as the result. */
  run: (taskId: string) => Promise<string | void>;
}

export interface SendToAiProps {
  taskId: string;
  /** Further ways to send the task, shown after "Copy handoff". */
  targets?: readonly AgentTarget[] | undefined;
}

/**
 * "Send to AI": what an agent is given for this task. The page does not compose it — the
 * board does, from the task, its documents and the settings that apply to it — so there is
 * one text, the same for this button, the API and the command line, and it has no token.
 */
export function SendToAi({ taskId, targets = [] }: SendToAiProps) {
  const { client } = useBoard();
  const { copy } = useCopyToClipboard();
  const [done, setDone] = useState<string | undefined>(undefined);

  const copyHandoff: AgentTarget = {
    label: 'Copy handoff',
    run: async (id) => {
      const text = await client.handoff(id);
      if (!(await copy(text))) {
        throw new Error('The page could not write to the clipboard: the browser refused.');
      }
      return 'Handoff copied to the clipboard.';
    },
  };

  const sending = useAsyncAction(async (target: AgentTarget) => {
    setDone(undefined);
    setDone((await target.run(taskId)) ?? undefined);
  });

  const items: MenuItem[] = [copyHandoff, ...targets].map((target) => ({
    label: target.label,
    disabled: sending.pending,
    onSelect: () => void sending.run(target),
  }));

  return (
    <>
      <Menu label="Send to AI" items={items} appearance="button">
        Send to AI <span aria-hidden="true">▾</span>
      </Menu>
      {/* Always there, so that what is put into it is announced; empty, it takes no room. */}
      <p className="send-ai__done" aria-live="polite">
        {sending.error === undefined ? done : null}
      </p>
      {sending.error === undefined ? null : (
        <p className="form__error send-ai__error" role="alert">
          {sending.error}
        </p>
      )}
    </>
  );
}
