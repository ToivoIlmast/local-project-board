import { isTaskId } from '../../core/rules/ids.js';
import type { ResolvedBoard } from './board.js';
import { boardNotRunning } from './claude.js';
import type { ProcessProbe } from './processProbe.js';
import { deliverPendingEnds } from './runEnd.js';
import { boardMessage, findRunningBoard, get, post } from './running.js';
import { readJournal, removeJournal, type RunJournal } from './runJournal.js';

/** `alive` and `unknown` change nothing; only `lost` — or the person's word — abandons a run. */
export interface Verdict {
  kind: 'alive' | 'lost' | 'unknown';
  /** What the verdict rests on, in words; `lost` is written to the board with them. */
  reasons: string[];
}

/** The flags of Claude Code that name a session, as two arguments or as `flag=value`. */
const SESSION_FLAGS = ['--session-id', '--resume', '-r'];

/**
 * Whether an argv starts or resumes this session of Claude Code: a flag that names a session,
 * followed by exactly this id. Never a substring of the command line — that would find the
 * `grep` that looks for it, or an id that merely begins the same way.
 */
export function holdsSession(argv: readonly string[], sessionId: string): boolean {
  return argv.some(
    (arg, index) =>
      (SESSION_FLAGS.includes(arg) && argv[index + 1] === sessionId) ||
      SESSION_FLAGS.some((flag) => flag.startsWith('--') && arg === `${flag}=${sessionId}`),
  );
}

/**
 * What this machine shows about a run that the board still has as `working` (T45). The run is
 * `alive` when a process is seen that is it; `lost` only on proof that none can be; `unknown`
 * whenever the machine cannot show it, which is never taken for `lost`.
 *
 * Proof of loss is the journal of the runner that started the run, on this host, in this PID
 * namespace: both processes it recorded are gone (pid and start time, so a reused pid does not
 * count) or the machine has booted since; and no process of this user holds the session.
 * The age of the run is not an input: a long session is not a lost one.
 */
export async function inspectRun(
  run: { sessionId: string },
  journal: RunJournal | undefined,
  probe: ProcessProbe,
): Promise<Verdict> {
  const unknown = (reason: string): Verdict => ({ kind: 'unknown', reasons: [reason] });
  if (probe.platform !== 'linux') {
    return unknown(`this machine (${probe.platform}) has no /proc to look at its processes`);
  }
  const bootId = await probe.bootId();
  const namespace = await probe.pidNamespace();
  if (bootId === undefined || namespace === undefined) {
    return unknown('/proc cannot be read on this machine');
  }

  const { list, unreadable } = await probe.processes();
  const holders = list.filter(
    (entry) => entry.pid !== probe.ownPid && holdsSession(entry.argv, run.sessionId),
  );
  if (holders.length > 0) {
    return {
      kind: 'alive',
      reasons: holders.map((entry) => `process ${entry.pid} holds session ${run.sessionId}`),
    };
  }

  if (journal === undefined || journal.sessionId !== run.sessionId) {
    return unknown(
      'no runner journal of this run on this machine: it was started elsewhere, or by a ' +
        'runner that kept none, so finding no process proves nothing',
    );
  }
  if (journal.host !== probe.hostname()) {
    return unknown(`the run was started on another host (${journal.host})`);
  }
  if (journal.bootId !== undefined && journal.bootId !== bootId) {
    return {
      kind: 'lost',
      reasons: ['this machine has booted since the run began: none of its processes survived'],
    };
  }
  if (journal.bootId === undefined || journal.pidNamespace !== namespace) {
    return unknown(
      'the run was started in another PID namespace, whose processes are not seen here',
    );
  }

  const runner = await sameProcess(probe, journal.runner);
  if (runner === 'same') {
    return {
      kind: 'alive',
      reasons: [`its runner (pid ${journal.runner.pid}) is still running and will end the run`],
    };
  }
  if (runner === 'unknown') {
    return unknown(`the runner (pid ${journal.runner.pid}) cannot be identified`);
  }
  if (journal.child === undefined) {
    return unknown('the runner died while it started claude, so its pid was never recorded');
  }
  const child = await sameProcess(probe, journal.child);
  if (child === 'same') {
    return { kind: 'alive', reasons: [`claude (pid ${journal.child.pid}) is still running`] };
  }
  if (child === 'unknown') {
    return unknown(`claude (pid ${journal.child.pid}) cannot be identified`);
  }
  if (unreadable > 0) {
    return unknown(`${unreadable} process(es) of this user could not be read`);
  }
  return {
    kind: 'lost',
    reasons: [
      `claude (pid ${journal.child.pid}) and its runner (pid ${journal.runner.pid}) no longer ` +
        `exist, and no process holds session ${run.sessionId}`,
    ],
  };
}

/** Whether the recorded process still runs: the same pid with the same start time. */
async function sameProcess(
  probe: ProcessProbe,
  recorded: { pid: number; start?: string | undefined },
): Promise<'same' | 'gone' | 'unknown'> {
  if (recorded.start === undefined) return 'unknown';
  const now = await probe.startOf(recorded.pid);
  if (now === undefined) return 'unknown';
  return now === recorded.start ? 'same' : 'gone';
}

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

  await deliverPendingEnds(board.root);

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
