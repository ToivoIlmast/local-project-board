import { BoardError } from '../errors.js';
import type { FromCheck, TaskContent, TaskVersion } from '../model/history.js';
import type { Storage } from '../ports.js';
import {
  applyBlockers,
  changedFields,
  contentHash,
  contentOf,
  sameContent,
} from '../rules/history.js';

/**
 * The parts of ADR-0030 §3 that more than one service needs. Everything here runs inside the
 * lock of one task, taken once by the caller: nothing here takes it, and nothing here calls a
 * locked operation (the lock cannot be entered twice).
 */

/** The latest version, by number; the list is whatever could be read. */
export function latestVersion(versions: readonly TaskVersion[]): TaskVersion | undefined {
  return versions.reduce<TaskVersion | undefined>(
    (latest, version) =>
      latest === undefined || version.number > latest.number ? version : latest,
    undefined,
  );
}

/**
 * Step 3: makes history end at what is on disk. A task that has none gets a `baseline` of its
 * content; a task whose content differs from its latest version gets an `external` one, for a
 * change made outside the server. Returns the versions it appended, to be announced.
 */
export async function syncHistory(
  storage: Storage,
  taskId: string,
  content: TaskContent,
): Promise<TaskVersion[]> {
  const latest = latestVersion(await storage.listVersions(taskId));
  if (latest === undefined) {
    return [
      await storage.appendVersion(taskId, {
        source: 'baseline',
        changed: [],
        snapshot: contentOf(content),
      }),
    ];
  }
  if (sameContent(latest.snapshot, content)) return [];
  return [
    await storage.appendVersion(taskId, {
      source: 'external',
      changed: changedFields(latest.snapshot, content),
      snapshot: contentOf(content),
    }),
  ];
}

export function contentChanged(
  taskId: string,
  content: TaskContent,
  latest: TaskVersion | undefined,
): BoardError {
  const currentHash = contentHash(content);
  return new BoardError(
    'TASK_CONTENT_CHANGED',
    `The content of task "${taskId}" is no longer the one the change was based on.`,
    { id: taskId, currentHash, latestVersion: latest?.number ?? null },
  );
}

/**
 * Step 2.1: `ifContentHash` against the content just read (ADR-0030 §4). Nothing is written
 * when it does not match, not even the sync.
 */
export async function assertContentHash(
  storage: Storage,
  taskId: string,
  content: TaskContent,
  ifContentHash: string | undefined,
): Promise<void> {
  if (ifContentHash === undefined || ifContentHash === contentHash(content)) return;
  throw contentChanged(taskId, content, latestVersion(await storage.listVersions(taskId)));
}

/**
 * Step 2.2: `fromCheck` against the check, its report and its decisions as just read
 * (ADR-0030 §7). The first failing rule answers.
 */
export async function assertFromCheck(
  storage: Storage,
  taskId: string,
  fromCheck: FromCheck,
  content: TaskContent,
  ifContentHash: string | undefined,
): Promise<void> {
  const check = await storage.readCheck(taskId, fromCheck.check);
  if (check === null) {
    throw new BoardError('CHECK_NOT_FOUND', `Task "${taskId}" has no check ${fromCheck.check}.`, {
      id: taskId,
      check: fromCheck.check,
    });
  }
  const report = check.report;
  if (check.state !== 'reported' || report === undefined) {
    throw new BoardError(
      'CHECK_NOT_REPORTED',
      `Check ${fromCheck.check} of task "${taskId}" has no report to apply.`,
      { id: taskId, check: fromCheck.check, state: check.state },
    );
  }
  const known = new Set(report.recommendations.map((recommendation) => recommendation.id));
  const unknown = fromCheck.recommendations.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new BoardError(
      'RECOMMENDATION_NOT_FOUND',
      `Check ${fromCheck.check} of task "${taskId}" has no recommendation ${unknown.join(', ')}.`,
      { id: taskId, check: fromCheck.check, recommendations: unknown },
    );
  }

  if (fromCheck.basis !== 'report') return;

  if (ifContentHash === undefined) {
    throw new BoardError(
      'INVALID_REQUEST',
      'Applying a report needs ifContentHash: the content the draft was made from.',
      { issues: [{ path: 'ifContentHash', message: 'Required with fromCheck.basis "report".' }] },
    );
  }
  const pinned = await storage.readVersion(taskId, check.begin.version);
  const { blocked, notAccepted } = applyBlockers({
    stale: pinned === null || !sameContent(pinned.snapshot, content),
    decisions: check.decisions,
    recommendations: fromCheck.recommendations,
  });
  if (blocked) {
    throw new BoardError(
      'STALE_CHECK',
      `Check ${fromCheck.check} of task "${taskId}" cannot be applied to the task as it is now.`,
      {
        id: taskId,
        check: fromCheck.check,
        version: check.begin.version,
        ...(notAccepted.length > 0 ? { notAccepted } : {}),
      },
    );
  }
}
