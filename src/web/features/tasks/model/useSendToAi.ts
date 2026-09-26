import { useState } from 'react';
import { claudeCodeCommand } from '../../../../contract/v1/index';
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
  /** Where the board answers, as an agent on this machine reaches it: `http://127.0.0.1:<port>`. */
  boardUrl: string;
}

/**
 * Claude Code. The page cannot start a program and neither can the board's server (ADR-0008), so
 * this puts on the clipboard the one line that does, for a terminal in the project: `claude`
 * with a prompt that points at the live handoff of this task (T19). The same session starts
 * from `npx local-project-board claude <ID>` without pasting anything.
 */
const CLAUDE_CODE: AgentTarget = {
  label: 'Claude Code — copy command',
  run: async (id, { copy, boardUrl }) => {
    if (!(await copy(claudeCodeCommand(id, boardUrl)))) throw CLIPBOARD_REFUSED;
    return 'Command for Claude Code copied. Paste it in a terminal in the project folder.';
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
    setDone((await target.run(taskId, { copy, boardUrl: boardUrl() })) ?? undefined);
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

/** The page is served by the board, so its port is the board's; an agent reaches it by loopback. */
function boardUrl(): string {
  return `http://127.0.0.1:${window.location.port}`;
}
