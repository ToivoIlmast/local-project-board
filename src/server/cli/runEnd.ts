import { findRunningBoard, get, post } from './running.js';
import { procProbe, type ProcessProbe } from './processProbe.js';
import { inspectRun } from './runInspect.js';
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
 * journals that have nothing left to deliver. Called whenever a command of the CLI finds
 * the board — `claude --wait` on each connection, `claude <ID>`, `claude --recover` — so an end
 * survives the runner that recorded it and a restart of the board.
 *
 * A journal with no `outcome` is dropped in two cases, both decided by the board's own answer
 * (T71: this sweep, not `claude --recover`, owns it, because it already looks at every journal
 * and at the board whenever one is found):
 * - the board has replaced the run (a later run, another session, or no task);
 * - the board has the very run as over (not `working`) and `inspectRun` — the proof `--recover`
 *   uses — shows both of its processes gone, by pid **and start time**. The runner died after
 *   the agent reported and before it wrote the outcome; nothing is left to deliver, and no
 *   outcome is made up. Anything but proof (`alive`, `unknown`) keeps the journal.
 */
export async function deliverPendingEnds(
  root: string,
  probe: ProcessProbe = procProbe(),
): Promise<void> {
  for (const record of await listJournals(root)) {
    if (record.outcome !== undefined) {
      await deliverEnd(root, record);
      continue;
    }
    const standing = await standingOf(root, record);
    if (standing === 'replaced') {
      await removeJournal(root, record.taskId, record.runId);
    } else if (standing === 'over') {
      const verdict = await inspectRun({ sessionId: record.sessionId }, record, probe);
      if (verdict.kind === 'lost') await removeJournal(root, record.taskId, record.runId);
    }
  }
}

/**
 * What the board says of the journal's run: `replaced` (a later run, another session, or no
 * task), `over` (this very run, no longer `working`) or `current` — also when it cannot tell.
 */
async function standingOf(
  root: string,
  record: RunJournal,
): Promise<'replaced' | 'over' | 'current'> {
  const board = await findRunningBoard(root);
  if (board === undefined) return 'current';
  const answer = await get(board, `/tasks/${record.taskId}`);
  if (answer === undefined) return 'current';
  if (answer.status === 404) return 'replaced';
  if (!answer.ok) return 'current';
  const task = (await answer.json()) as {
    aiRun?: { runId?: unknown; sessionId?: unknown; state?: unknown };
  };
  const runId = typeof task.aiRun?.runId === 'number' ? task.aiRun.runId : 0;
  if (runId > record.runId) return 'replaced';
  if (runId !== record.runId) return 'current';
  if (task.aiRun?.sessionId !== record.sessionId) return 'replaced';
  return task.aiRun?.state === 'working' ? 'current' : 'over';
}
