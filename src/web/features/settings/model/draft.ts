import {
  type BoardWorkflowKey,
  type BoardWorkflowOverrides,
  type WorkflowFlag,
  type WorkflowFlagOverrides,
  type WorkflowOverrides,
  type WorkflowSettings,
} from '../../../../contract/v1/index';

/**
 * What the form edits is the overrides, in the shape `PUT /workflow` takes and nothing else:
 * the effective values are computed for display and never enter it (ADR-0028). Every function
 * here is pure and returns a new object.
 */

/**
 * The settings that stop having an effect while `editCode` is off. `resolveWorkflow` keeps the
 * same list to itself; a test holds the two together.
 */
export const INACTIVE_WITHOUT_EDIT_CODE: readonly WorkflowFlag[] = [
  'branch',
  'checks',
  'commit',
  'push',
];

/** The overrides of one column; a status is a key of the record, never a property of its prototype. */
function columnOf(overrides: WorkflowOverrides, status: string): WorkflowFlagOverrides {
  return Object.hasOwn(overrides.statuses, status) ? (overrides.statuses[status] ?? {}) : {};
}

/** Where a value in effect comes from; a task is not edited on this page. */
export type Source = 'default' | 'board' | 'status';

export interface Effective {
  value: boolean;
  source: Source;
}

/**
 * The value a flag has on the board (no status) or in a column, and where it comes from: the
 * column's override, else the board's, else the default. The same rule `resolveWorkflow` applies.
 */
export function effectiveFlag(
  overrides: WorkflowOverrides,
  defaults: WorkflowSettings,
  key: WorkflowFlag,
  status?: string,
): Effective {
  const column = status === undefined ? undefined : columnOf(overrides, status)[key];
  if (column !== undefined) return { value: column, source: 'status' };
  const board = overrides.board[key];
  if (board !== undefined) return { value: board, source: 'board' };
  return { value: defaults[key], source: 'default' };
}

/** The flags that do nothing in a place where `editCode` is off. */
export function inactiveFlags(
  overrides: WorkflowOverrides,
  defaults: WorkflowSettings,
  status?: string,
): readonly WorkflowFlag[] {
  return effectiveFlag(overrides, defaults, 'editCode', status).value
    ? []
    : INACTIVE_WITHOUT_EDIT_CODE;
}

/**
 * A board-level flag. A value that is only the default is not an override, so it is removed:
 * a checkbox put back where it was leaves nothing to save.
 */
export function setBoardFlag(
  overrides: WorkflowOverrides,
  key: WorkflowFlag,
  value: boolean,
  defaults: WorkflowSettings,
): WorkflowOverrides {
  const { [key]: _old, ...rest } = overrides.board;
  return {
    ...overrides,
    board: value === defaults[key] ? rest : { ...rest, [key]: value },
  };
}

/**
 * One of the board-only settings. `undefined` means "no override"; `null` is a value of its
 * own, and so is any text — as typed, spaces included, because this is called on every key.
 * Only the empty text is no override; `normalizeOverrides` deals with the rest.
 */
export function setBoardValue(
  overrides: WorkflowOverrides,
  key: BoardWorkflowKey,
  value: string | null | undefined,
): WorkflowOverrides {
  const { [key]: _old, ...rest } = overrides.board;
  return {
    ...overrides,
    board: value === undefined || value === '' ? rest : { ...rest, [key]: value },
  };
}

/** One flag of one column; `'inherit'` takes the key out, and a column left empty with it. */
export function setColumnFlag(
  overrides: WorkflowOverrides,
  status: string,
  key: WorkflowFlag,
  value: boolean | 'inherit',
): WorkflowOverrides {
  const { [key]: _old, ...rest } = columnOf(overrides, status);
  const next: WorkflowFlagOverrides = value === 'inherit' ? rest : { ...rest, [key]: value };
  const { [status]: _column, ...others } = overrides.statuses;
  return {
    ...overrides,
    statuses: Object.keys(next).length === 0 ? others : { ...others, [status]: next },
  };
}

/** Everything a column says, dropped: what the person does to a column that is not a status. */
export function removeColumn(overrides: WorkflowOverrides, status: string): WorkflowOverrides {
  const { [status]: _column, ...others } = overrides.statuses;
  return { ...overrides, statuses: others };
}

/**
 * What is sent and what is compared: a column with nothing in it says nothing, and a text
 * setting is what it says without the spaces around it — blank is no override at all.
 */
export function normalizeOverrides(overrides: WorkflowOverrides): WorkflowOverrides {
  const board: BoardWorkflowOverrides = { ...overrides.board };
  for (const key of ['baseBranch', 'checkCommand'] as const) {
    const text = board[key];
    if (typeof text !== 'string') continue;
    if (text.trim() === '') delete board[key];
    else board[key] = text.trim();
  }
  const statuses: Record<string, WorkflowFlagOverrides> = {};
  for (const [status, flags] of Object.entries(overrides.statuses)) {
    if (Object.keys(flags).length > 0) statuses[status] = flags;
  }
  return { board, statuses };
}

/** The same overrides, whatever the order of the keys and whether a column is empty. */
export function sameOverrides(a: WorkflowOverrides, b: WorkflowOverrides): boolean {
  return canonical(normalizeOverrides(a)) === canonical(normalizeOverrides(b));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

export interface Orphans {
  /** Columns of the overrides that are not a status of the board. */
  columns: string[];
  /** Board settings that name a status the board does not have. */
  board: { key: 'startStatus' | 'finishStatus'; status: string }[];
}

/** What refers to a status the board no longer has; the board reports it, the form shows it. */
export function orphanStatuses(overrides: WorkflowOverrides, statuses: readonly string[]): Orphans {
  const board: Orphans['board'] = [];
  for (const key of ['startStatus', 'finishStatus'] as const) {
    const status = overrides.board[key];
    if (typeof status === 'string' && !statuses.includes(status)) board.push({ key, status });
  }
  return {
    columns: Object.keys(overrides.statuses).filter((status) => !statuses.includes(status)),
    board,
  };
}
