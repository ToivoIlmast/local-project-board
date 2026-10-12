import { findRunningBoard, get, post } from './running.js';
import { listJournals, removeJournal, type RunJournal } from './runJournal.js';

export type Delivery = 'delivered' | 'dropped' | 'pending';

/**
 * Tells the board how the run of a journal ended (T45). The board is looked for afresh each
 * time: after a restart it has another address and token, and the ones the runner began with
 * would be refused.
 *
 * `delivered` and `dropped` remove the journal: the board took the end, or will never take it
 * (the run was replaced or abandoned and ended since, or the task is gone; the board's
 * compare-and-set on runId and session decided that, not this code). `pending` keeps it for the
 * next try: the board is not there, or it answered something that may pass.
 */
export async function deliverEnd(root: string, record: RunJournal): Promise<Delivery> {
  const outcome = record.outcome;
  if (outcome === undefined) return 'pending';
  const board = await findRunningBoard(root);
  if (board === undefined) return 'pending';
  const answer = await post(board, `/tasks/${record.taskId}/ai-run/${record.runId}/end`, {
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    ...(outcome.launchError === undefined ? {} : { launchError: outcome.launchError }),
    endedAt: outcome.endedAt,
    sessionId: record.sessionId,
  });
  if (answer === undefined) return 'pending';
  if (answer.ok || answer.status === 404 || answer.status === 409) {
    await removeJournal(root, record.taskId, record.runId);
    return answer.ok ? 'delivered' : 'dropped';
  }
  return 'pending';
}

/**
 * Delivers every end this machine recorded and the board has not taken, and forgets the
 * journals of runs the board has since replaced. Called whenever a command of the CLI finds
 * the board — `claude --wait` on each connection, `claude <ID>`, `claude --recover` — so an end
 * survives the runner that recorded it and a restart of the board.
 */
export async function deliverPendingEnds(root: string): Promise<void> {
  for (const record of await listJournals(root)) {
    if (record.outcome !== undefined) {
      await deliverEnd(root, record);
    } else if (await replaced(root, record)) {
      await removeJournal(root, record.taskId, record.runId);
    }
  }
}

/** The board has a later run, or another session, for the task: this journal's run is over. */
async function replaced(root: string, record: RunJournal): Promise<boolean> {
  const board = await findRunningBoard(root);
  if (board === undefined) return false;
  const answer = await get(board, `/tasks/${record.taskId}`);
  if (answer === undefined) return false;
  if (answer.status === 404) return true;
  if (!answer.ok) return false;
  const task = (await answer.json()) as { aiRun?: { runId?: unknown; sessionId?: unknown } };
  const runId = typeof task.aiRun?.runId === 'number' ? task.aiRun.runId : 0;
  return (
    runId > record.runId || (runId === record.runId && task.aiRun?.sessionId !== record.sessionId)
  );
}
