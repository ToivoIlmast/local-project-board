import type { ComponentType } from 'react';
import type { Task } from '../../../../contract/v1/index';
import type { BoardClient } from '../../../api/index';

/**
 * A way to hand a task to an agent. The menus list the ones they are given after their own: a
 * new one is one more entry in `AGENT_TARGETS`, not a change to a menu. A target either does
 * its work at once (`run`), or asks for the parameters of the run first (`dialog`, T38).
 */
export type AgentTarget = RunTarget | DialogTarget;

export interface RunTarget {
  label: string;
  /**
   * Does it for this task. A text it resolves with is said to the person as the result. What
   * it may use is what the menu gives it; a target that needs more than that has a dialog.
   */
  run: (taskId: string, context: TargetContext) => Promise<string | void>;
}

export interface DialogTarget {
  label: string;
  /** Opened by the menu; it does the work itself and says when it is done. */
  dialog: ComponentType<TargetDialogProps>;
}

export interface TargetContext {
  /** Puts the text on the clipboard; false when the browser refused. */
  copy: (text: string) => Promise<boolean>;
  /** The board this page is served by. */
  client: BoardClient;
}

export interface TargetDialogProps {
  /** The task as the board has it now. */
  task: Task;
  /** Closed without doing anything. */
  onClose: () => void;
  /** Done: the text is said to the person as the result, and the dialog is closed. */
  onDone: (text: string) => void;
}
