import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import { claudeCodePrompt, continuationPrompt } from '../../contract/v1/index.js';
import { isTaskId } from '../../core/rules/ids.js';
import type { ResolvedBoard } from './board.js';
import { identify, procProbe } from './processProbe.js';
import { startCheckSession, type Research } from './checkSession.js';
import { deliverPendingCheckEnds } from './checkEnd.js';
import { deliverEnd, deliverPendingEnds } from './runEnd.js';
import { boardMessage, findRunningBoard, get, post } from './running.js';
import type { RuntimeState } from './runtime.js';
import { spawnSession } from './spawnSession.js';
import { writeJournal, type RunJournal } from './runJournal.js';

/** The one program this command starts. It is never taken from the command line (T19). */
const PROGRAM = 'claude';

/**
 * Starts Claude Code on one task, in this terminal. The board server never does this: a route
 * that starts programs would turn the token into the right to run code on the machine, and it
 * has no terminal to give an interactive program (ADR-0008, ADR-0029). The person who runs the
 * command is the one who starts the process, so this is the CLI's job and only the CLI's.
 *
 * It checks everything that can be checked before the session starts — the id, the running
 * board, the task, `claude` itself — and says which of them is wrong. Then Claude Code is given
 * `--session-id <uuid> <prompt>`. No token, no handoff text, no other flags of its own: the
 * permissions are the user's own settings of Claude Code, and so is the model unless the run
 * names one (T35, `startSession`).
 *
 * Resolves to the exit code the session ended with, so that the command ends as `claude` did.
 */
export async function launchClaude(
  board: ResolvedBoard,
  id: string,
  environment: {
    env: NodeJS.ProcessEnv;
    check?: boolean | undefined;
    /** A research of the task, with the person's focus if any (ADR-0029 T54). */
    research?: Research | undefined;
  },
): Promise<number> {
  if (!isTaskId(id)) {
    const prefix = board.config.tasks.idPrefix;
    throw new Error(`"${id}" is not a task id. Task ids look like ${prefix}1, ${prefix}2.`);
  }

  const running = await findRunningBoard(board.root);
  if (running === undefined) throw boardNotRunning();
  const answer = await get(running, `/tasks/${id}`);
  if (answer === undefined) {
    throw new Error('The board did not answer. Is it still running? Try again in a moment.');
  }
  if (!answer.ok) throw new Error(await boardMessage(answer));
  // An end that an earlier runner recorded and could not deliver goes first (T45).
  await deliverPendingEnds(board.root);
  await deliverPendingCheckEnds(board.root);

  const program = await findClaude(environment.env);
  // An actuality check is a session of its own kind, recorded apart from the run (ADR-0030 §6).
  if (environment.check === true) {
    return startCheckSession(program, id, running, board.root, environment.env);
  }
  // So is a research; the comment goes into the begin, never onto the command line.
  if (environment.research !== undefined) {
    return startCheckSession(
      program,
      id,
      running,
      board.root,
      environment.env,
      undefined,
      environment.research,
    );
  }
  return startSession(program, id, running, board.root, environment.env);
}

/**
 * The one way a session of Claude Code starts, for `claude <ID>` and for the runner of
 * `claude --wait` alike. Generates a UUID, records the session on the board (begin), then
 * starts `claude --session-id <uuid> <prompt>` in the root of the project. Records the
 * process outcome on the board (end) before resolving (T33).
 *
 * `model` is the one choice of a run (T35): when given it is passed as `--model` and the model
 * as two arguments, and recorded in `aiRun.model`; when not, neither happens and Claude Code
 * uses the user's own settings. It was checked against the closed form by the contract; the
 * CLI of `claude <ID>` has none.
 */
export async function startSession(
  program: string,
  id: string,
  board: RuntimeState,
  root: string,
  env: NodeJS.ProcessEnv,
  model?: string,
  mode: 'new' | 'resume' | 'restart' = 'new',
): Promise<number> {
  const boardUrl = board.url.replace(/\/+$/, '');
  // Resume continues the session the board recorded for the last run, never a new one (T36);
  // Restart, like a new run, always makes a new one (T37).
  const resuming = mode === 'resume';
  const sessionId = resuming ? await sessionToResume(board, id) : randomUUID();
  const prompt = resuming ? continuationPrompt(id, boardUrl) : claudeCodePrompt(id, boardUrl);

  const runId = await beginRun(board, id, sessionId, model, mode);

  // The prompt stays the last argument.
  const args = [
    ...(model === undefined ? [] : ['--model', model]),
    ...(resuming ? ['--resume'] : ['--session-id']),
    sessionId,
    prompt,
  ];
  const journal = await startJournal(root, id, runId, sessionId);
  return run(program, args, root, env, journal);
}

/**
 * The journal of a run that is about to start (T45): what `claude --recover` needs to find its
 * processes, and where its end waits when the board cannot take it. A disk that refuses it does
 * not stop the session: the end is still sent from memory, and recovery says `unknown`.
 */
async function startJournal(
  root: string,
  taskId: string,
  runId: number,
  sessionId: string,
): Promise<{ root: string; record: RunJournal; kept: boolean }> {
  const probe = procProbe();
  const bootId = await probe.bootId();
  const pidNamespace = await probe.pidNamespace();
  const record: RunJournal = {
    formatVersion: 1,
    taskId,
    runId,
    sessionId,
    host: hostname(),
    platform: process.platform,
    ...(bootId === undefined ? {} : { bootId }),
    ...(pidNamespace === undefined ? {} : { pidNamespace }),
    runner: await identify(probe, process.pid),
  };
  const journal = { root, record, kept: true };
  await keep(journal, record);
  return journal;
}

async function keep(
  journal: { root: string; record: RunJournal; kept: boolean },
  record: RunJournal,
): Promise<void> {
  journal.record = record;
  try {
    await writeJournal(journal.root, record);
  } catch (error) {
    if (journal.kept) {
      process.stderr.write(
        `Warning: the runner journal of ${record.taskId} could not be written ` +
          `(${error instanceof Error ? error.message : String(error)}). If this runner dies, ` +
          '`claude --recover` will not be able to tell whether the run is lost.\n',
      );
    }
    journal.kept = false;
  }
}

/** The session of the last run of the task, as the board has it; the board refuses what is not one. */
async function sessionToResume(board: RuntimeState, taskId: string): Promise<string> {
  const answer = await get(board, `/tasks/${taskId}`);
  if (answer === undefined) {
    throw new Error('The board did not answer. Is it still running? Try again in a moment.');
  }
  if (!answer.ok) throw new Error(await boardMessage(answer));
  const task = (await answer.json()) as { aiRun?: { sessionId?: unknown; state?: unknown } };
  const sessionId = task.aiRun?.sessionId;
  if (typeof sessionId !== 'string' || task.aiRun?.state === 'working') {
    throw new Error(`Task ${taskId} has no finished session of Claude Code to resume.`);
  }
  return sessionId;
}

/** `claude` as the PATH finds it, or the reason there is none, in words a user can act on. */
export async function findClaude(env: NodeJS.ProcessEnv): Promise<string> {
  const program = await findExecutable(PROGRAM, env);
  if (program === undefined) {
    throw new Error(
      'Claude Code was not found: there is no `claude` in the PATH. Install it and try again, ' +
        'or give another agent the text of "Send to AI → Copy handoff" in the board.',
    );
  }
  return program;
}

export function boardNotRunning(): Error {
  return new Error(
    'The board is not running for this project, so Claude Code would have no handoff to read. ' +
      'Start it in another terminal with `npx local-project-board` and try again.',
  );
}

/**
 * Records the start of a session on the board; throws if the board refuses.
 * Called before spawn so that no session ever runs without a recorded run (T33).
 */
async function beginRun(
  board: RuntimeState,
  taskId: string,
  sessionId: string,
  model: string | undefined,
  mode: 'new' | 'resume' | 'restart',
): Promise<number> {
  const response = await post(board, `/tasks/${taskId}/ai-run`, {
    sessionId,
    mode,
    ...(model === undefined ? {} : { model }),
  });
  if (response === undefined) {
    throw new Error(
      `The board did not answer when beginning run for ${taskId}. Is it still running?`,
    );
  }
  if (!response.ok) {
    throw new Error(await boardMessage(response));
  }
  const body = (await response.json()) as { runId?: number };
  if (typeof body.runId !== 'number') {
    throw new Error(`The board returned an unexpected response for begin on ${taskId}.`);
  }
  return body.runId;
}

/** How long to retry end before leaving it to the journal. */
const END_RETRY_MS = 30_000;
const END_RETRY_INITIAL_DELAY_MS = 200;

/**
 * Records the end of a session (T33): first in the journal, on the disk, then on the board,
 * retrying for ~30 s and looking for the board afresh each time, since a board that restarted
 * has another address and token. An end the board did not take stays in the journal and is
 * delivered by the next runner, `claude <ID>` or `claude --recover` (T45).
 */
async function endRun(
  journal: { root: string; record: RunJournal; kept: boolean },
  input: { exitCode?: number; launchError?: string },
): Promise<void> {
  await keep(journal, {
    ...journal.record,
    outcome: { ...input, endedAt: new Date().toISOString() },
  });
  const { taskId, runId } = journal.record;
  const deadline = Date.now() + END_RETRY_MS;
  let delay = END_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    if ((await deliverEnd(journal.root, journal.record)) !== 'pending') return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(delay, remaining));
    });
    delay = Math.min(delay * 2, 5_000);
  }
  process.stderr.write(
    `Warning: the board did not take the end of run ${runId} of ${taskId}.\n` +
      (journal.kept
        ? '  It is kept in .board/runner/ and is delivered by the next ' +
          '`local-project-board claude --wait` or `claude <ID>`, or now by:\n'
        : '  It could not be kept on disk either. When the board is back, run:\n') +
      `    local-project-board claude --recover ${taskId}\n`,
  );
}

/**
 * The file `name` in the PATH that can be run, or nothing. Looked up here, not left to `spawn`,
 * so that a missing `claude` is told apart from any other reason a start can fail. On Windows
 * only `claude.exe` counts: a `.cmd` cannot be started without a shell, and there is none here.
 */
async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const windows = process.platform === 'win32';
  const path = env.PATH ?? env.Path ?? '';
  for (const directory of path.split(delimiter).filter((entry) => entry !== '')) {
    const candidate = join(directory, windows ? `${name}.exe` : name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, windows ? fsConstants.F_OK : fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here; the next directory.
    }
  }
  return undefined;
}

/**
 * Runs the session of a task and records it in the journal of its run. Records begin/end on the
 * board; the end is always sent (T33), and the processes are written down for recovery (T45).
 */
function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  journal: { root: string; record: RunJournal; kept: boolean },
): Promise<number> {
  return spawnSession(program, args, cwd, env, {
    // Who claude is, by pid and start time, for `claude --recover` if this runner dies (T45).
    onSpawn: (pid) =>
      identify(procProbe(), pid).then((identity) =>
        keep(journal, { ...journal.record, child: identity }),
      ),
    onEnd: (input) => endRun(journal, input),
  });
}
