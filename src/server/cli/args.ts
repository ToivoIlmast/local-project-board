import { parseArgs } from 'node:util';

export type Command = 'serve' | 'instructions' | 'handoff' | 'claude' | 'export' | 'help';

export interface ParsedArgs {
  command: Command;
  /** Only for serve; it is handed to the configuration, which validates it. */
  port?: number;
  /** True when the port came from the flag: then a busy port is an error, not a hint. */
  explicitPort?: boolean;
  open?: boolean;
  /** Only for export: where to write the snapshot; stdout when absent. */
  out?: string;
  /** Only for handoff and claude: the task, as it was typed; the board says whether it exists. */
  id?: string;
  /** Only for claude, instead of an id: wait for Send to AI in the board (T27). */
  wait?: boolean;
  /** Only for claude, with an id: look at a run whose runner died and recover it (T45). */
  recover?: boolean;
  /** Only for claude, with an id: check whether the task is still current (ADR-0030). */
  check?: boolean;
  /** Only with --recover: the person says the session is stopped when this machine cannot tell. */
  confirmStopped?: boolean;
}

export const USAGE = [
  'Usage: local-project-board [command] [options]',
  '',
  'Commands:',
  '  (none)                 start the board and open it in a browser',
  '  instructions           print the API instructions for an AI agent',
  '  handoff <id>           print everything an AI agent needs to work on a task',
  '  claude <id>            start Claude Code on a task, in this terminal',
  '  claude <id> --check    start Claude Code on an actuality check of a task: it reports',
  '                         whether the task still matches the repository, and changes nothing',
  '  claude --wait          start Claude Code in this terminal on each task sent from the',
  '                         board with Send to AI → Claude Code, one after another',
  '  claude --recover <id>  check whether the AI run of a task is still alive on this machine,',
  '                         and mark it lost on the board when it certainly is not',
  '      --confirm-stopped  with --recover: you know the session has stopped, though this',
  '                         machine cannot show it; the board records your confirmation',
  '  export                 print a snapshot of the board',
  '',
  'Options:',
  '  --port <number>        port to listen on (default 7432, or the next free one)',
  '  --no-open              do not open a browser',
  '  --out <file>           write the snapshot to a file (export only)',
  '  -h, --help             show this text',
].join('\n');

/** A command line the board cannot act on; the user is shown what it does take. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  readonly usage = USAGE;
}

const COMMANDS = new Set<Command>(['instructions', 'handoff', 'claude', 'export']);

/**
 * The whole command line surface of the board. It only sorts out what was asked for:
 * values are validated by the configuration, which can name the flag they came from.
 */
export function parseCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        out: { type: 'string' },
        wait: { type: 'boolean' },
        recover: { type: 'boolean' },
        check: { type: 'boolean' },
        'confirm-stopped': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    // node explains how to pass a positional that looks like a flag; the board does not
    // take positionals like that, so the user is shown the first sentence and the usage.
    throw new UsageError(`${(error as Error).message.split('. ')[0] ?? ''}`);
  }

  const { values, positionals } = parsed;
  if (values.help === true) return { command: 'help' };

  const [name, ...rest] = positionals;
  const command: Command = name === undefined ? 'serve' : asCommand(name);
  const wait = values.wait === true;
  const recover = values.recover === true;
  const check = values.check === true;
  const confirmStopped = values['confirm-stopped'] === true;
  if (wait && command !== 'claude') {
    throw new UsageError('The --wait flag belongs to the claude command.');
  }
  if (recover && command !== 'claude') {
    throw new UsageError('The --recover flag belongs to the claude command.');
  }
  if (check && command !== 'claude') {
    throw new UsageError('The --check flag belongs to the claude command.');
  }
  if (check && (wait || recover)) {
    throw new UsageError(
      'claude --check takes one task and starts a check of it: leave out --wait and --recover.',
    );
  }
  if (recover && wait) {
    throw new UsageError('claude --recover takes one task and cannot wait: leave out --wait.');
  }
  if (confirmStopped && !recover) {
    throw new UsageError('The --confirm-stopped flag belongs to claude --recover <id>.');
  }
  // The commands that take a positional argument take the task they are about; a runner that
  // waits is told its tasks by the board, one at a time.
  const takesId = command === 'handoff' || (command === 'claude' && !wait);
  const [id, ...extra] = takesId ? rest : [undefined, ...rest];
  if (takesId && id === undefined) {
    throw new UsageError(
      `The ${command} command needs the id of a task, for example: ${command} T1`,
    );
  }
  if (extra.length > 0) {
    throw new UsageError(
      wait
        ? `claude --wait takes no task: the board sends them. Unexpected argument: ${extra[0]}`
        : `Unexpected argument: ${extra[0]}`,
    );
  }

  if (values.out !== undefined && command !== 'export') {
    throw new UsageError('The --out flag belongs to the export command.');
  }
  if ((values.port !== undefined || values['no-open'] === true) && command !== 'serve') {
    throw new UsageError(`The ${command} command takes no --port or --no-open.`);
  }

  return {
    command,
    ...(values.port === undefined ? {} : { port: Number(values.port), explicitPort: true }),
    ...(values['no-open'] === true ? { open: false } : {}),
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(id === undefined ? {} : { id }),
    ...(wait ? { wait } : {}),
    ...(recover ? { recover } : {}),
    ...(confirmStopped ? { confirmStopped } : {}),
    ...(check ? { check } : {}),
  };
}

function asCommand(name: string): Command {
  if (COMMANDS.has(name as Command)) return name as Command;
  throw new UsageError(`Unknown command: ${name}`);
}
