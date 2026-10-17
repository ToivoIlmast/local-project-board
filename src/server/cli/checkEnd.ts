import { listCheckJournals, removeCheckJournal, type CheckJournal } from './checkJournal.js';
import { findRunningBoard, get, post } from './running.js';

export type CheckDelivery = 'delivered' | 'dropped' | 'pending';

/**
 * Tells the board how the process of a check ended (ADR-0030 §6). The board is looked for afresh
 * each time: after a restart it has another address and token.
 *
 * The journal is removed on `2xx`, `404` (the task or the check is gone) and `409` (the end was
 * taken already, or the session is another one): the board's own check of the session decided
 * it, not this code. It stays on anything else, for the next try. The same rule as a run's end.
 */
export async function deliverCheckEnd(root: string, record: CheckJournal): Promise<CheckDelivery> {
  const outcome = record.outcome;
  if (outcome === undefined) return 'pending';
  const board = await findRunningBoard(root);
  if (board === undefined) return 'pending';
  const answer = await post(board, `/tasks/${record.taskId}/checks/${record.check}/end`, {
    sessionId: record.sessionId,
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    endedAt: outcome.endedAt,
  });
  if (answer === undefined) return 'pending';
  if (answer.ok || answer.status === 404 || answer.status === 409) {
    await removeCheckJournal(root, record.taskId, record.check);
    return answer.ok ? 'delivered' : 'dropped';
  }
  return 'pending';
}

/**
 * Delivers every check end this machine recorded and the board has not taken, and forgets the
 * journals that hold nothing the check could still use: one without an outcome (the runner died
 * before `claude` ended) is dropped once the board answers 404 for the check, or shows it with
 * an end or a report. It is never judged against `aiRun`. Otherwise it stays.
 */
export async function deliverPendingCheckEnds(root: string): Promise<void> {
  for (const record of await listCheckJournals(root)) {
    if (record.outcome !== undefined) {
      await deliverCheckEnd(root, record);
    } else if (await settled(root, record)) {
      await removeCheckJournal(root, record.taskId, record.check);
    }
  }
}

async function settled(root: string, record: CheckJournal): Promise<boolean> {
  const board = await findRunningBoard(root);
  if (board === undefined) return false;
  const answer = await get(board, `/tasks/${record.taskId}/checks/${record.check}`);
  if (answer === undefined) return false;
  if (answer.status === 404) return true;
  if (!answer.ok) return false;
  const check = (await answer.json()) as { end?: unknown; report?: unknown };
  return check.end !== undefined || check.report !== undefined;
}
