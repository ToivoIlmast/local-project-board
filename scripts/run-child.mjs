// @ts-check
/**
 * Runs one child process of the local checks (Prettier, ESLint, Jest) and waits for it, so that
 * it never outlives the command that started it.
 *
 * `spawnSync` did not: while it waits, this process cannot react to a signal, so a SIGTERM (an
 * agent or a tool stopping `npm run check`) killed this process and left Prettier, ESLint or
 * Jest running on their own until they finished. Here every SIGINT, SIGTERM and SIGHUP this
 * process receives is passed on to the child, this process waits until the child has really
 * ended, and then ends itself with 128 + the signal, as a shell reports it — so no later step
 * starts after a stop. SIGTERM and SIGHUP are real signals on Linux and macOS only; on Windows
 * Node emulates SIGINT (Ctrl+C) and SIGBREAK/console close, and an outside TerminateProcess
 * (`taskkill /F`, a tool killing the process) ends this process without running any handler.
 *
 * Ctrl+C in a terminal already reaches the child (the whole foreground group on Linux and macOS,
 * every process of the console on Windows); passing it on again does no harm. On Windows a
 * signal to a child terminates it; Jest's worker processes then lose their parent and exit.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/** @type {readonly NodeJS.Signals[]} */
export const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * @typedef {object} ChildDeps
 * @property {typeof spawn} spawn
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} process
 * @property {(code: number) => void} exit
 */

/** @type {ChildDeps} */
const realDeps = {
  spawn,
  process,
  exit: (code) => process.exit(code),
};

/**
 * @param {NodeJS.Signals} signal
 */
export const signalExitCode = (signal) => 128 + (constants.signals[signal] ?? 0);

/**
 * Runs `command args` in `cwd` with this terminal, and resolves to its exit code (a child killed
 * by a signal: 128 + that signal). Rejects only when it could not be started.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 * @param {Partial<ChildDeps>} [overrides]
 * @returns {Promise<number>}
 */
export function runChild(command, args, { cwd, env }, overrides = {}) {
  /** @type {ChildDeps} */
  const deps = { ...realDeps, ...overrides };
  return new Promise((resolve, reject) => {
    const child = deps.spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      ...(env === undefined ? {} : { env }),
    });
    /** @type {NodeJS.Signals | undefined} */
    let stoppedBy;
    const listeners = FORWARDED.map((signal) => {
      const forward = () => {
        stoppedBy ??= signal;
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      deps.process.on(signal, forward);
      return /** @type {const} */ ([signal, forward]);
    });
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      for (const [signal, forward] of listeners) deps.process.off(signal, forward);
      return true;
    };
    child.once('error', (error) => {
      if (release()) reject(error);
    });
    // `exit`, not `close`: with the terminal inherited there are no pipes to drain, and a
    // grandchild that kept the terminal open must not keep this wait going after the child ended.
    child.once('exit', (code, signal) => {
      if (!release()) return;
      if (stoppedBy !== undefined) {
        const stopped = signalExitCode(stoppedBy);
        deps.exit(stopped);
        resolve(stopped); // Reached only where `exit` does not end the process (tests).
        return;
      }
      resolve(code ?? (signal === null ? 1 : signalExitCode(signal)));
    });
  });
}
