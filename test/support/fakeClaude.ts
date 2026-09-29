import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from './tmp.js';

/** What the stand-in for Claude Code saw when the board launched it. */
export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Each start is a process of its own: a new session, not one that was already there. */
  pid: number;
}

/** What the stand-in read when it followed its prompt, as an agent does. */
export interface FakeClaudeRead {
  url: string;
  handoff: string;
}

export interface FakeClaudeBehaviour {
  exit?: number;
  signal?: NodeJS.Signals;
  /**
   * Act as the agent the prompt asks for: read the handoff at the address in the prompt, then
   * report the run back through the API (`aiRun`, `report.md`), as a real agent is told to.
   * `read` only reads, and changes nothing on the board.
   */
  agent?: boolean | 'read';
  /** Stay in the session until this file exists, to see what happens meanwhile. */
  holdUntil?: string;
}

export interface FakeClaude {
  /** A directory holding only `claude`: put it in the PATH of the command under test. */
  bin: string;
  /** Every launch so far, oldest first; empty while the real `claude` was never asked for. */
  calls: () => Promise<FakeClaudeCall[]>;
  /** What each session that acted as an agent read, oldest first. */
  reads: () => Promise<FakeClaudeRead[]>;
  /** The environment that makes the command find it, and makes it behave as told. */
  env: (behaviour?: FakeClaudeBehaviour) => NodeJS.ProcessEnv;
}

const lines = async <T>(file: string): Promise<T[]> => {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
};

/**
 * A `claude` that is a script: it records how it was started and exits as it is told. The real
 * Claude Code is never run by a test (T19); it is found through PATH like the real one, so what
 * is proved is what the launcher hands to whatever `claude` the user has.
 *
 * As an agent it knows nothing but its prompt: the address it reads, the task it reports on
 * and the token it sends all come from the prompt and the board, never from the test (T27).
 */
export async function fakeClaude(): Promise<FakeClaude> {
  const dir = await tmpDir();
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'calls.jsonl');
  const readLog = join(dir, 'reads.jsonl');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync, existsSync } = require('node:fs');",
      'const env = process.env;',
      'appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({',
      '  argv: process.argv.slice(2), cwd: process.cwd(), env, pid: process.pid,',
      "}) + '\\n');",
      '(async () => {',
      '  if (env.FAKE_CLAUDE_AGENT) {',
      "    const url = /read GET (\\S+) and follow it/.exec(process.argv[2] ?? '')[1];",
      '    const handoff = await (await fetch(url)).text();',
      "    appendFileSync(env.FAKE_CLAUDE_READS, JSON.stringify({ url, handoff }) + '\\n');",
      '  }',
      "  if (env.FAKE_CLAUDE_AGENT === 'act') {",
      "    const url = /read GET (\\S+) and follow it/.exec(process.argv[2] ?? '')[1];",
      '    const [, api, id] = /^(.*)\\/tasks\\/([^/]+)\\/handoff$/.exec(url);',
      "    const { token } = await (await fetch(api + '/session')).json();",
      '    const send = async (method, path, body) => {',
      '      const answer = await fetch(api + path, {',
      '        method,',
      "        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      '        body: JSON.stringify(body),',
      '      });',
      "      if (!answer.ok) throw new Error(method + ' ' + path + ': ' + answer.status);",
      '    };',
      '    const handoff = await (await fetch(url)).text();',
      '    const reportMatch = /`PATCH \\/api\\/v1(\\/tasks\\/[^`]+\\/ai-run\\/(\\d+)\\/report)`/.exec(handoff);',
      '    const reportPath = reportMatch?.[1];',
      "    await send('PUT', '/tasks/' + id + '/documents/report.md', { content: '# Report\\n\\nDone.\\n' });",
      '    if (reportPath) {',
      "      await send('PATCH', reportPath, { agent: 'claude-code', state: 'finished',",
      "        checks: 'skipped', finishedAt: new Date().toISOString() });",
      '    } else {',
      '      // No runner called begin; follow the handoff: start a run, then report (T32)',
      "      const beginRes = await fetch(api + '/tasks/' + id + '/ai-run', {",
      "        method: 'POST',",
      "        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      "        body: JSON.stringify({ sessionId: '00000000-0000-0000-0000-000000000000', mode: 'new' }),",
      '      });',
      '      const { runId } = await beginRes.json();',
      "      await send('PATCH', '/tasks/' + id + '/ai-run/' + runId + '/report', {",
      "        agent: 'claude-code', state: 'finished', checks: 'skipped',",
      '        finishedAt: new Date().toISOString() });',
      '    }',
      '  }',
      '  while (env.FAKE_CLAUDE_HOLD && !existsSync(env.FAKE_CLAUDE_HOLD)) {',
      '    await new Promise((resolve) => setTimeout(resolve, 20));',
      '  }',
      '  if (env.FAKE_CLAUDE_SIGNAL) process.kill(process.pid, env.FAKE_CLAUDE_SIGNAL);',
      '  process.exit(Number(env.FAKE_CLAUDE_EXIT ?? 0));',
      '})().catch((error) => {',
      '  console.error(String(error));',
      '  process.exit(70);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(join(bin, 'claude'), 0o755);

  return {
    bin,
    calls: () => lines<FakeClaudeCall>(log),
    reads: () => lines<FakeClaudeRead>(readLog),
    env: ({ exit = 0, signal, agent = false, holdUntil } = {}) => ({
      PATH: bin,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_READS: readLog,
      FAKE_CLAUDE_EXIT: String(exit),
      ...(signal === undefined ? {} : { FAKE_CLAUDE_SIGNAL: signal }),
      ...(agent === false ? {} : { FAKE_CLAUDE_AGENT: agent === 'read' ? 'read' : 'act' }),
      ...(holdUntil === undefined ? {} : { FAKE_CLAUDE_HOLD: holdUntil }),
    }),
  };
}
