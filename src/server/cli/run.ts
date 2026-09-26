import { parseCliArgs, USAGE, UsageError } from './args.js';
import { resolveBoard } from './board.js';
import { exportBoard } from './export.js';
import { printHandoff } from './handoff.js';
import { printInstructions } from './instructions.js';
import { openBrowser as spawnBrowser } from './openBrowser.js';
import { startBoard } from './serve.js';

export interface CliEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  writeError: (text: string) => void;
  /** Injected so that a test never spawns a browser; the CLI passes the real one. */
  openBrowser?: ((url: string) => void) | undefined;
}

export interface CliResult {
  exitCode: 0 | 1;
  /** Present when the command left a server running; the caller stops it on a signal. */
  stop?: (() => Promise<void>) | undefined;
}

/**
 * The whole CLI: parse, compose, run one command. It holds no rules of its own — ranking,
 * statuses, document names and HTTP all live behind it — and it turns a failure into a
 * sentence a user can act on, never a stack trace (§15).
 */
export async function runCli(argv: string[], environment: CliEnvironment): Promise<CliResult> {
  try {
    const args = parseCliArgs(argv);
    if (args.command === 'help') {
      environment.write(USAGE);
      return { exitCode: 0 };
    }

    const board = await resolveBoard(args, environment);
    switch (args.command) {
      case 'instructions':
        await printInstructions(board, environment.write);
        return { exitCode: 0 };
      case 'handoff':
        // The command line parser does not let a handoff without an id get this far.
        await printHandoff(board, args.id as string, environment.write);
        return { exitCode: 0 };
      case 'export':
        await exportBoard(board, { out: args.out, write: environment.write });
        return { exitCode: 0 };
      case 'serve': {
        const running = await startBoard({
          board,
          args,
          write: environment.write,
          openBrowser: environment.openBrowser ?? spawnBrowser,
        });
        return { exitCode: 0, stop: running.stop };
      }
    }
  } catch (error) {
    environment.writeError(message(error));
    if (error instanceof UsageError) environment.writeError(`\n${error.usage}`);
    return { exitCode: 1 };
  }
}

/** What the user is told: the message of the failure, and nothing about where it came from. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
