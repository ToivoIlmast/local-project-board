import { createElement, useState, type ReactElement } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { useBoardClient } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useCopyToClipboard } from '../../../shared/hooks/useCopyToClipboard';
import type { MenuItem } from '../../../shared/ui/index';
import { ClaudeCodeLaunch } from '../ui/ClaudeCodeLaunch';
import type { AgentTarget, DialogTarget, RunTarget } from './agentTarget';

export type { AgentTarget } from './agentTarget';

/**
 * Claude Code. Neither the page nor the board's server can start a program (ADR-0029), so this
 * asks the board to hand the task to the runner the person started in a terminal of the project
 * (`npx local-project-board claude --wait`), and that runner starts the session there (T27). The
 * dialog asks for the parameters of the run first (T38); the page sends the id of the task, the
 * name of the agent and the chosen model. The prompt, the program and the handoff are none of
 * its business. When nothing waits, the board says what to do instead.
 */
const CLAUDE_CODE: DialogTarget = { label: 'Claude Code', dialog: ClaudeCodeLaunch };

/** The further ways to send a task, in the order the menus show them. */
export const AGENT_TARGETS: readonly AgentTarget[] = [CLAUDE_CODE];

const CLIPBOARD_REFUSED = new Error(
  'The page could not write to the clipboard: the browser refused.',
);

export interface SendToAiState {
  /** "Copy handoff" and the further targets, ready for a `Menu`. */
  items: MenuItem[];
  /** The dialog of a target that asked for one, while it is open. */
  dialog: ReactElement | null;
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
  task: Task,
  targets: readonly AgentTarget[] = AGENT_TARGETS,
): SendToAiState {
  const client = useBoardClient();
  const { copy } = useCopyToClipboard();
  const [done, setDone] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<DialogTarget | undefined>(undefined);

  const copyHandoff: RunTarget = {
    label: 'Copy handoff',
    run: async (id) => {
      const text = await client.handoff(id);
      if (!(await copy(text))) throw CLIPBOARD_REFUSED;
      return 'Handoff copied to the clipboard.';
    },
  };

  const sending = useAsyncAction(async (target: RunTarget) => {
    setDone(undefined);
    setDone((await target.run(task.id, { copy, client })) ?? undefined);
  });

  const choose = (target: AgentTarget): void => {
    if ('run' in target) {
      void sending.run(target);
      return;
    }
    setDone(undefined);
    sending.clearError();
    setOpen(target);
  };

  return {
    items: [copyHandoff, ...targets].map((target) => ({
      label: target.label,
      disabled: sending.pending,
      onSelect: () => choose(target),
    })),
    dialog:
      open === undefined
        ? null
        : createElement(open.dialog, {
            task,
            onClose: () => setOpen(undefined),
            onDone: (text: string) => {
              setOpen(undefined);
              setDone(text);
            },
          }),
    done: sending.error === undefined ? done : undefined,
    error: sending.error,
  };
}
