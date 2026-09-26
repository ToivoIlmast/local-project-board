import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from './tmp.js';

/** What the stand-in for Claude Code saw when the board launched it. */
export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface FakeClaude {
  /** A directory holding only `claude`: put it in the PATH of the command under test. */
  bin: string;
  /** Every launch so far, oldest first; empty while the real `claude` was never asked for. */
  calls: () => Promise<FakeClaudeCall[]>;
  /** The environment that makes the command find it, and makes it exit as told. */
  env: (behaviour?: { exit?: number; signal?: NodeJS.Signals }) => NodeJS.ProcessEnv;
}

/**
 * A `claude` that is a script: it records how it was started and exits as it is told. The real
 * Claude Code is never run by a test (T19); it is found through PATH like the real one, so what
 * is proved is what the launcher hands to whatever `claude` the user has.
 */
export async function fakeClaude(): Promise<FakeClaude> {
  const dir = await tmpDir();
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'calls.jsonl');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      'appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({',
      '  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,',
      "}) + '\\n');",
      'if (process.env.FAKE_CLAUDE_SIGNAL) process.kill(process.pid, process.env.FAKE_CLAUDE_SIGNAL);',
      'process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(join(bin, 'claude'), 0o755);

  return {
    bin,
    calls: async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeClaudeCall);
    },
    env: ({ exit = 0, signal } = {}) => ({
      PATH: bin,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_EXIT: String(exit),
      ...(signal === undefined ? {} : { FAKE_CLAUDE_SIGNAL: signal }),
    }),
  };
}
