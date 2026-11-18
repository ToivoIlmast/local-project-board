import { isTaskId } from '../../core/rules/ids.js';
import type { ResolvedBoard } from './board.js';
import { boardNotRunning } from './claude.js';
import type { ProcessProbe } from './processProbe.js';
import { inspectRun } from './runInspect.js';
import { deliverPendingEnds } from './runEnd.js';
import { boardMessage, findRunningBoard, get, post } from './running.js';
import { readJournal, removeJournal } from './runJournal.js';

// The verdict lives in runInspect.ts, which runEnd.ts shares; it is still reachable from here.
export { holdsSession, inspectRun, type Verdict } from './runInspect.js';

export interface RecoverEnvironment {
  confirmStopped: boolean;
  write: (text: string) => void;
  writeError: (text: string) => void;
  probe: ProcessProbe;
}

/**
 * `local-project-board claude --recover <ID>` (T45). Delivers any end this machine still owes
 * the board; then, for a run the board has as `working`, looks at this machine and abandons the
 * run only when it is lost, or when the person confirms it stopped (`--confirm-stopped`) and the
 * machine cannot tell. A run that is seen alive is never abandoned.
 *
 * The board compares runId, session and `working` when it abandons, so a run that ended or was
 * replaced between the look and the request is left as it is. 0 when the board is as it should
 * be; 1 when the run was left alone or the board refused.
 */
export async function recoverRun(
  board: ResolvedBoard,
  id: string,
  environment: RecoverEnvironment,
): Promise<number> {
  const { write, writeError } = environment;
  if (!isTaskId(id)) {
    const prefix = board.config.tasks.idPrefix;
    throw new Error(`"${id}" is not a task id. Task ids look like ${prefix}1, ${prefix}2.`);
  }
  if ((await findRunningBoard(board.root)) === undefined) throw boardNotRunning();

  await deliverPendingEnds(board.root, environment.probe);

  const running = await findRunningBoard(board.root);
  if (running === undefined) throw boardNotRunning();
  const answer = await get(running, `/tasks/${id}`);
  if (answer === undefined) throw new Error('The board did not answer. Is it still running?');
  if (!answer.ok) throw new Error(await boardMessage(answer));
  const task = (await answer.json()) as {
    aiRun?: { state?: string; runId?: number; sessionId?: string };
  };
  const run = task.aiRun;
  if (run?.state !== 'working') {
    write(`${id} has no AI run in progress (${run?.state ?? 'no run'}): nothing to recover.`);
    return 0;
  }
  const runId = run.runId ?? 0;
  if (run.sessionId === undefined) {
    writeError(
      `${id} has a run that an agent reported itself, without a session of a runner: there is ` +
        'no process to look for. Clear it with PATCH /api/v1/tasks/<id> {"aiRun": null}.',
    );
    return 1;
  }
  const sessionId = run.sessionId;

  const journal = await readJournal(board.root, id, runId);
  const verdict = await inspectRun({ sessionId }, journal, environment.probe);
  const because = verdict.reasons.join('; ');
  write(`Run ${runId} of ${id} (session ${sessionId}): ${verdict.kind} — ${because}.`);

  if (verdict.kind === 'alive') {
    writeError('The run is alive: the board is left as it is. Let it end, or stop it yourself.');
    return 1;
  }
  if (verdict.kind === 'unknown' && !environment.confirmStopped) {
    writeError(
      'This machine cannot show whether the session still runs, so the board is left as it ' +
        'is. If you know it has stopped, say so: ' +
        `local-project-board claude --recover ${id} --confirm-stopped`,
    );
    return 1;
  }

  const message = (
    verdict.kind === 'lost'
      ? `lost: ${because}`
      : `confirmed stopped by the user (--confirm-stopped); this machine could not tell: ${because}`
  ).slice(0, 2000);
  const abandoned = await post(running, `/tasks/${id}/ai-run/${runId}/abandon`, {
    sessionId,
    message,
  });
  if (abandoned === undefined) throw new Error('The board did not answer. Is it still running?');
  if (!abandoned.ok) {
    writeError(`The board left the run as it is: ${await boardMessage(abandoned, 'the run')}`);
    return 1;
  }
  await removeJournal(board.root, id, runId);
  write(
    `Run ${runId} of ${id} is now failed (lost). Its session is kept: Resume continues it as ` +
      `run ${runId + 1}.`,
  );
  return 0;
}
