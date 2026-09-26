import { useState } from 'react';
import { useBoardClient } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useCopyToClipboard } from '../../../shared/hooks/useCopyToClipboard';
import type { MenuItem } from '../../../shared/ui/index';

/**
 * A way to hand a task to an agent. The menus list the ones they are given after their own: a
 * new one is one more entry in `AGENT_TARGETS`, not a change to a menu.
 */
export interface AgentTarget {
  label: string;
  /** Does it for this task. A text it resolves with is said to the person as the result. */
  run: (taskId: string) => Promise<string | void>;
}

/** The further ways to send a task, in the order the menus show them; T19 adds Claude Code. */
export const AGENT_TARGETS: readonly AgentTarget[] = [];

export interface SendToAiState {
  /** "Copy handoff" and the further targets, ready for a `Menu`. */
  items: MenuItem[];
  /** What was done, for a live region; nothing while nothing was. */
  done: string | undefined;
  /** Why it was not, in the board's own words. */
  error: string | undefined;
}

/**
 * Everything "Send to AI" does, for whichever menu offers it: the task's own details and its
 * card on the board use this and nothing else. The handoff is asked of the board when the
 * entry is chosen — the page composes nothing, so the text is the API's and the command
 * line's, and has no token (T15).
 */
export function useSendToAi(
  taskId: string,
  targets: readonly AgentTarget[] = AGENT_TARGETS,
): SendToAiState {
  const client = useBoardClient();
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

  return {
    items: [copyHandoff, ...targets].map((target) => ({
      label: target.label,
      disabled: sending.pending,
      onSelect: () => void sending.run(target),
    })),
    done: sending.error === undefined ? done : undefined,
    error: sending.error,
  };
}
