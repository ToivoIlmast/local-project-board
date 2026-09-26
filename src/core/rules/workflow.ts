import {
  WORKFLOW_KEYS,
  type BoardWorkflowOverrides,
  type EffectiveWorkflow,
  type WorkflowFlag,
  type WorkflowFlagOverrides,
  type WorkflowKey,
  type WorkflowOverrides,
  type WorkflowSettings,
  type WorkflowSource,
} from '../model/workflow.js';

/**
 * What an agent does when nothing is configured (ADR-0028). `startStatus` is the status a board
 * with the usual columns has; `defaultWorkflow` drops it for a board without one.
 */
export const DEFAULT_WORKFLOW: Readonly<WorkflowSettings> = {
  editCode: true,
  branch: true,
  checks: true,
  commit: true,
  push: false,
  report: true,
  startStatus: 'in-progress',
  finishStatus: null,
  baseBranch: null,
  checkCommand: null,
};

/** The settings that stop having an effect when `editCode` is off. */
const NEEDS_EDIT_CODE: readonly WorkflowFlag[] = ['branch', 'checks', 'commit', 'push'];

/** The defaults for a board with these statuses: no status is invented for `startStatus`. */
export function defaultWorkflow(statuses: readonly string[]): WorkflowSettings {
  const start = DEFAULT_WORKFLOW.startStatus;
  return {
    ...DEFAULT_WORKFLOW,
    startStatus: start !== null && statuses.includes(start) ? start : null,
  };
}

type Layer = { readonly [K in WorkflowKey]?: WorkflowSettings[K] | undefined };

/**
 * The settings a task runs with: the defaults, then the board's overrides, then those of the
 * task's column, then the task's own — a key set on a later level wins, key by key. There is
 * no other merge rule and no condition (ADR-0028). Pure: nothing is read or written.
 *
 * Each value comes with the level it was taken from. `editCode: false` does not change any
 * value; it only lists the settings that no longer matter under `inactive`.
 */
export function resolveWorkflow(
  defaults: WorkflowSettings,
  board: BoardWorkflowOverrides,
  status: WorkflowFlagOverrides | undefined,
  task: WorkflowFlagOverrides | undefined,
): EffectiveWorkflow {
  const layers: [WorkflowSource, Layer][] = [
    ['board', board],
    ['status', status ?? {}],
    ['task', task ?? {}],
  ];

  const values: Record<string, unknown> = {};
  const sources = {} as Record<WorkflowKey, WorkflowSource>;
  for (const key of WORKFLOW_KEYS) {
    values[key] = defaults[key];
    sources[key] = 'default';
    for (const [source, layer] of layers) {
      const value = layer[key];
      if (value === undefined) continue;
      values[key] = value;
      sources[key] = source;
    }
  }

  const settings = values as unknown as WorkflowSettings;
  return {
    values: settings,
    sources,
    inactive: settings.editCode ? [] : [...NEEDS_EDIT_CODE],
  };
}

/**
 * What in the overrides refers to a status the board does not have: a column that is not
 * configured, a start or finish status that is not. One message per problem, in the order the
 * keys were written. Such overrides are reported, not repaired: the board keeps working.
 */
export function findWorkflowIssues(
  workflow: WorkflowOverrides,
  statuses: readonly string[],
): string[] {
  const configured = `configured: ${statuses.join(', ')}`;
  const issues: string[] = [];
  for (const key of ['startStatus', 'finishStatus'] as const) {
    const status = workflow.board[key];
    if (status !== undefined && status !== null && !statuses.includes(status)) {
      issues.push(`board.${key}: "${status}" is not a configured status (${configured}).`);
    }
  }
  for (const status of Object.keys(workflow.statuses)) {
    if (!statuses.includes(status)) {
      issues.push(`statuses.${status}: "${status}" is not a configured status (${configured}).`);
    }
  }
  return issues;
}
