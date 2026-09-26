import type { WorkflowFlagOverrides } from '../../../../contract/v1/index';

/**
 * What a task stores about its AI workflow is its overrides and nothing more (ADR-0028): a
 * task that says nothing has no `workflow`, and there is no other way to say "nothing".
 */

/** Whether the task overrides anything; an empty object left in a file overrides nothing. */
export function hasOwnSettings(workflow: WorkflowFlagOverrides | undefined): boolean {
  return workflow !== undefined && Object.keys(workflow).length > 0;
}

/**
 * The `workflow` of `PATCH /tasks/:id` for these overrides: whole, because the board replaces
 * the overrides of a task rather than merging them, and `null` when nothing is left, because
 * that is how the board is told to remove them (an empty object would be stored as one).
 */
export function settingsRequest(draft: WorkflowFlagOverrides): WorkflowFlagOverrides | null {
  return hasOwnSettings(draft) ? { ...draft } : null;
}

/** The same overrides, whatever the order of the keys, and no `workflow` is an empty one. */
export function sameSettings(
  a: WorkflowFlagOverrides | undefined,
  b: WorkflowFlagOverrides | undefined,
): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify(left) === JSON.stringify(right);
}
