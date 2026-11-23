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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { cwd, env, stdio: 'inherit', shell: false });
    } catch (error) {
      // spawn emits only a few failures (ENOENT, EACCES…) as 'error' and throws the rest, such
      // as a claude.exe that Windows cannot run (EFTYPE). Either way the start failed (T10).
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Claude Code could not be started: ${message}\n`);
      hooks.onEnd({ launchError: message }).then(
        () => resolve(1),
        () => resolve(1),
      );
      return;
    }
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

/** How long the output of an ended console process is waited for after its `exit`. */
const STDIO_GRACE_MS = 1_000;

/** How a console process ended; `launchError` when it never started (T10). */
export interface ConsoleExit {
  exitCode: number | null;
  signal: string | null;
  launchError?: string;
}

/** The process of a Console mode session, with the pipes this runner talks to it through. */
export interface ConsoleProcess {
  /** The pid once it is running; nothing when it could not be started. */
  spawned: Promise<number | undefined>;
  /** Writes one line to its stdin; false when stdin is closed or broken (EPIPE). */
  writeLine(line: string): boolean;
  /** Closes stdin: Claude Code finishes its work and exits (§8.2). */
  closeStdin(): void;
  /** Synchronous, so that it can be used from `process.on('exit')`. */
  kill(signal?: NodeJS.Signals): void;
  /** True from the start until the process has ended. */
  alive(): boolean;
  /** Resolves when it has ended and all of its output was handed over, or never started. */
  exited: Promise<ConsoleExit>;
}

/**
 * Starts `claude -p` for Console mode (plan C8): pipes instead of the terminal, no shell, and
 * `detached: false` on every platform, so that it stays in the job object (Windows) and in the
 * group of the terminal (POSIX, §8.4). What to do with the signals of this process is the
 * caller's: it is the one who knows whether stdin was closed already. `spawnSession` is not
 * used for this and is not changed.
 */
export function spawnConsoleSession(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: { onStdout: (chunk: Buffer) => void; onStderr: (chunk: Buffer) => void },
): ConsoleProcess {
  let running = false;
  let child: ReturnType<typeof spawn> | undefined;
  const failed = (error: unknown): ConsoleProcess => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Claude Code could not be started: ${message}\n`);
    return {
      spawned: Promise.resolve(undefined),
      writeLine: () => false,
      closeStdin: () => undefined,
      kill: () => undefined,
      alive: () => false,
      exited: Promise.resolve({ exitCode: null, signal: null, launchError: message }),
    };
  };
  try {
    child = spawn(program, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      shell: false,
    });
  } catch (error) {
    // As in spawnSession: spawn throws what it does not emit, such as EFTYPE (T10).
    return failed(error);
  }
  const started = child;
  running = true;
  started.stdin?.on('error', () => undefined);
  started.stdout?.on('data', output.onStdout);
  started.stderr?.on('data', output.onStderr);

  const spawned = new Promise<number | undefined>((resolve) => {
    started.once('spawn', () => resolve(started.pid));
    started.once('error', () => resolve(undefined));
  });
  const exited = new Promise<ConsoleExit>((resolve) => {
    started.once('error', (error) => {
      running = false;
      process.stderr.write(`Claude Code could not be started: ${error.message}\n`);
      resolve({ exitCode: null, signal: null, launchError: error.message });
    });
    // `close` waits for the pipes, which a process of its own that `claude` started may hold open
    // after `claude` is gone: the end is not held back for them longer than a moment.
    started.once('exit', (code, signal) => {
      running = false;
      setTimeout(() => resolve({ exitCode: code, signal }), STDIO_GRACE_MS);
    });
    started.once('close', (code, signal) => {
      running = false;
      resolve({ exitCode: code, signal });
    });
  });
  return {
    spawned,
    writeLine: (line) => {
      const stdin = started.stdin;
      if (stdin === null || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(line);
      return true;
    },
    closeStdin: () => {
      if (started.stdin?.writableEnded === false) started.stdin.end();
    },
    kill: (signal) => {
      if (running) started.kill(signal);
    },
    alive: () => running,
    exited,
  };
}

/** The exit code a shell would show for how a process ended, as `spawnSession` resolves. */
export function exitCodeOf(exit: ConsoleExit): number {
  if (exit.launchError !== undefined) return 1;
  if (exit.exitCode !== null) return exit.exitCode;
  return exit.signal === null ? 1 : 128 + (constants.signals[exit.signal as NodeJS.Signals] ?? 0);
}
