import { parseArgs } from 'node:util';

export type Command = 'serve' | 'instructions' | 'handoff' | 'export' | 'help';

export interface ParsedArgs {
  command: Command;
  /** Only for serve; it is handed to the configuration, which validates it. */
  port?: number;
  /** True when the port came from the flag: then a busy port is an error, not a hint. */
  explicitPort?: boolean;
  open?: boolean;
  /** Only for export: where to write the snapshot; stdout when absent. */
  out?: string;
  /** Only for handoff: the task, as it was typed; the board says whether it exists. */
  id?: string;
}

export const USAGE = [
  'Usage: local-project-board [command] [options]',
  '',
  'Commands:',
  '  (none)                 start the board and open it in a browser',
  '  instructions           print the API instructions for an AI agent',
  '  handoff <id>           print everything an AI agent needs to work on a task',
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

const COMMANDS = new Set<Command>(['instructions', 'handoff', 'export']);

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
  // The handoff command is the one that takes a positional argument: the task it is about.
  const [id, ...extra] = command === 'handoff' ? rest : [undefined, ...rest];
  if (command === 'handoff' && id === undefined) {
    throw new UsageError('The handoff command needs the id of a task, for example: handoff T1');
  }
  if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra[0]}`);

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
  };
}

function asCommand(name: string): Command {
  if (COMMANDS.has(name as Command)) return name as Command;
  throw new UsageError(`Unknown command: ${name}`);
}
