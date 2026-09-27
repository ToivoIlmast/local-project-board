import { useState } from 'react';
import type { BoardClient } from '../../../api/index';
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
  /**
   * Does it for this task. A text it resolves with is said to the person as the result. What
   * it may use is what the menu gives it; a target that needs more than that is not a menu entry.
   */
  run: (taskId: string, context: TargetContext) => Promise<string | void>;
}

export interface TargetContext {
  /** Puts the text on the clipboard; false when the browser refused. */
  copy: (text: string) => Promise<boolean>;
  /** The board this page is served by. */
  client: BoardClient;
}

/**
 * Claude Code. Neither the page nor the board's server can start a program (ADR-0029), so this
 * asks the board to hand the task to the runner the person started in a terminal of the project
 * (`npx local-project-board claude --wait`), and that runner starts the session there (T27). The
 * page sends the id of the task and the name of the agent; the prompt, the program and the
 * handoff are none of its business. When nothing waits, the board says what to do instead.
 */
const CLAUDE_CODE: AgentTarget = {
  label: 'Claude Code',
  run: async (id, { client }) => {
    await client.runTask(id, 'claude-code');
    return (
      `Claude Code is starting on ${id} in the terminal where ` +
      '`local-project-board claude --wait` runs.'
    );
  },
};

/** The further ways to send a task, in the order the menus show them. */
export const AGENT_TARGETS: readonly AgentTarget[] = [CLAUDE_CODE];

const CLIPBOARD_REFUSED = new Error(
  'The page could not write to the clipboard: the browser refused.',
);

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
      if (!(await copy(text))) throw CLIPBOARD_REFUSED;
      return 'Handoff copied to the clipboard.';
    },
  };

  const sending = useAsyncAction(async (target: AgentTarget) => {
    setDone(undefined);
    setDone((await target.run(taskId, { copy, client })) ?? undefined);
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
