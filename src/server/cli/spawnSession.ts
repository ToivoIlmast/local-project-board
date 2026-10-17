import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export interface SessionHooks {
  /** `claude` was spawned with this pid; awaited before the end is recorded. */
  onSpawn?: ((pid: number) => Promise<void>) | undefined;
  /** How it ended: written down and delivered; awaited before the session resolves. */
  onEnd: (input: { exitCode?: number; launchError?: string }) => Promise<void>;
}

/**
 * Runs the program with the terminal of this process, without a shell, and resolves to how it
 * ended. While it runs, Ctrl+C belongs to it: the terminal sends it to both of us, and this
 * process must not die before the session has said goodbye. The end is always recorded, whether
 * the process exits normally, via signal, or fails to start (T33). Shared by the run of a task
 * and by an actuality check (ADR-0030 §6), which differ only in what they record.
 */
export function spawnSession(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  hooks: SessionHooks,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, stdio: 'inherit', shell: false });
    let recorded: Promise<void> = Promise.resolve();
    child.once('spawn', () => {
      const pid = child.pid;
      if (pid === undefined || hooks.onSpawn === undefined) return;
      recorded = hooks.onSpawn(pid);
    });
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
      recorded
        .then(() => hooks.onEnd(input))
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
