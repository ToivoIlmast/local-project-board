import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { delimiter, join } from 'node:path';
import { API_BASE_PATH, claudeCodePrompt } from '../../contract/v1/index.js';
import { isTaskId } from '../../core/rules/ids.js';
import type { ResolvedBoard } from './board.js';
import { findRunningBoard, get } from './running.js';
import type { RuntimeState } from './runtime.js';

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
 * model and the permissions are the user's own settings of Claude Code.
 *
 * Resolves to the exit code the session ended with, so that the command ends as `claude` did.
 */
export async function launchClaude(
  board: ResolvedBoard,
  id: string,
  environment: { env: NodeJS.ProcessEnv },
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

  const program = await findClaude(environment.env);
  return startSession(program, id, running, board.root, environment.env);
}

/**
 * The one way a session of Claude Code starts, for `claude <ID>` and for the runner of
 * `claude --wait` alike. Generates a UUID, records the session on the board (begin), then
 * starts `claude --session-id <uuid> <prompt>` in the root of the project. Records the
 * process outcome on the board (end) before resolving (T33).
 */
export async function startSession(
  program: string,
  id: string,
  board: RuntimeState,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const sessionId = randomUUID();
  const prompt = claudeCodePrompt(id, board.url.replace(/\/+$/, ''));

  const runId = await beginRun(board, id, sessionId);

  return run(program, ['--session-id', sessionId, prompt], root, env, board, id, runId, sessionId);
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

/** The board says what is wrong in its own words; a board that says nothing is quoted by status. */
async function boardMessage(answer: Response): Promise<string> {
  try {
    const body = (await answer.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') return body.error.message;
  } catch {
    // Not the board's own error: the status is all there is to say.
  }
  return `The board answered ${answer.status} when asked for the task.`;
}

/**
 * POST to the board with the session token; nothing when the network fails.
 * Never puts the token in a URL or a log.
 */
async function postBoard(
  state: RuntimeState,
  path: string,
  body: unknown,
): Promise<Response | undefined> {
  try {
    return await fetch(`${state.url}${API_BASE_PATH.slice(1)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return undefined;
  }
}

/**
 * Records the start of a session on the board; throws if the board refuses.
 * Called before spawn so that no session ever runs without a recorded run (T33).
 */
async function beginRun(board: RuntimeState, taskId: string, sessionId: string): Promise<number> {
  const response = await postBoard(board, `/tasks/${taskId}/ai-run`, { sessionId, mode: 'new' });
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

/** How long to retry end before giving up and printing a manual-recovery message. */
const END_RETRY_MS = 30_000;
const END_RETRY_INITIAL_DELAY_MS = 200;

/**
 * Records the end of a session on the board, retrying for ~30 s on network failure.
 * If all retries fail, prints a recovery message to stderr — the one case that cannot
 * be recorded (T33).
 */
async function endRun(
  board: RuntimeState,
  taskId: string,
  runId: number,
  input: { exitCode?: number; launchError?: string },
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + END_RETRY_MS;
  let delay = END_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    const response = await postBoard(board, `/tasks/${taskId}/ai-run/${runId}/end`, input);
    if (response?.ok) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const ms = Math.min(delay, remaining);
      setTimeout(resolve, ms);
    });
    delay = Math.min(delay * 2, 5_000);
  }
  process.stderr.write(
    `Warning: could not record run end for task ${taskId}.\n` +
      `  taskId: ${taskId}  runId: ${runId}  sessionId: ${sessionId}\n` +
      `  Recover: PATCH /api/v1/tasks/${taskId}/ai-run/${runId}/end manually.\n`,
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
 * Runs the program with the terminal of this process, without a shell, and resolves to how it
 * ended. Records begin/end on the board. While it runs, Ctrl+C belongs to it: the terminal
 * sends it to both of us, and this process must not die before the session has said goodbye.
 * End is always sent — whether the process exits normally, via signal, or fails to start (T33).
 */
function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  board: RuntimeState,
  taskId: string,
  runId: number,
  sessionId: string,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, stdio: 'inherit', shell: false });
    const forwarded = (['SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const forward = (): void => void child.kill(signal);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      process.off('SIGINT', ignore);
      for (const [signal, forward] of forwarded) process.off(signal, forward);
    };

    let ended = false;
    const doEnd = (input: { exitCode?: number; launchError?: string }, code: number): void => {
      if (ended) return;
      ended = true;
      release();
      endRun(board, taskId, runId, input, sessionId)
        .then(() => resolve(code))
        .catch(() => resolve(code));
    };

    child.once('error', (error) => {
      process.stderr.write(`Claude Code could not be started: ${error.message}\n`);
      doEnd({ launchError: error.message }, 1);
    });
    child.once('close', (code, signal) => {
      const exitCode = code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
      doEnd({ exitCode }, exitCode);
    });
  });
}
