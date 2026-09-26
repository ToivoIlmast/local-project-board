import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { delimiter, join } from 'node:path';
import { claudeCodePrompt } from '../../contract/v1/index.js';
import { isTaskId } from '../../core/rules/ids.js';
import type { ResolvedBoard } from './board.js';
import { findRunningBoard, get } from './running.js';

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
 * one thing: the prompt that points it at the live handoff. No token, no handoff text, no flags
 * of its own: the model and the permissions are the user's own settings of Claude Code.
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
  if (running === undefined) {
    throw new Error(
      'The board is not running for this project, so Claude Code would have no handoff to read. ' +
        'Start it in another terminal with `npx local-project-board` and try again.',
    );
  }
  const answer = await get(running, `/tasks/${id}`);
  if (answer === undefined) {
    throw new Error('The board did not answer. Is it still running? Try again in a moment.');
  }
  if (!answer.ok) throw new Error(await boardMessage(answer));

  const program = await findExecutable(PROGRAM, environment.env);
  if (program === undefined) {
    throw new Error(
      'Claude Code was not found: there is no `claude` in the PATH. Install it and try again, ' +
        'or give another agent the text of "Send to AI → Copy handoff" in the board.',
    );
  }

  const prompt = claudeCodePrompt(id, running.url.replace(/\/+$/, ''));
  return run(program, [prompt], board.root, environment.env);
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
 * ended. While it runs, Ctrl+C belongs to it: the terminal sends it to both of us, and this
 * process must not die before the session has said goodbye.
 */
function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: 'inherit', shell: false });
    const forwarded = (['SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const forward = (): void => void child.kill(signal);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);
    const release = (): void => {
      process.off('SIGINT', ignore);
      for (const [signal, forward] of forwarded) process.off(signal, forward);
    };

    child.once('error', (error) => {
      release();
      reject(new Error(`Claude Code could not be started: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      release();
      // The way a shell reports a program that a signal ended.
      resolve(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}
