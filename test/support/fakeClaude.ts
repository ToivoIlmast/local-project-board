import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from './tmp.js';
import { installWindowsShim } from './windowsShim.js';

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
   * `read` only reads, and changes nothing on the board. `check` is the agent of an actuality
   * check: it reads the handoff of the check and sends the one report that handoff asks for.
   * `research` is the agent of a research when the prompt names the handoff of a check, and the
   * agent of the work (as `true`) when it names the handoff of a task: one runner, both kinds.
   */
  agent?: boolean | 'read' | 'check' | 'research';
  /**
   * For `research`: a directory where `<n>.json` is the report the agent sends for check `n`.
   * While `<n>.hold` exists there, that session stays open after its report.
   */
  reports?: string;
  /** Stay in the session until this file exists, to see what happens meanwhile. */
  holdUntil?: string;
  /**
   * Console mode (plan C8): act as `claude -p` with stream-json. Reads one JSON message per line
   * on stdin and, for each, plays the stdout of this fixture (`tools`, `permissions`…, from
   * `test/fixtures/claude-stream-json`) with its uuid and session_id replaced by the real ones.
   * It exits when the first tape is played, unless `stayOpen`, and always when stdin ends.
   */
  streamJson?: string;
  /** With `streamJson`: the stream of a Claude Code without `msg_lifecycle_v1` (no lifecycle). */
  lifecycle?: false;
  /** With `streamJson`: exit with `exit` (default 1) after the first assistant message. */
  exitMidTurn?: boolean;
  /** With `streamJson`: go on waiting for stdin after the tape, until it ends. */
  stayOpen?: boolean;
  /** With `streamJson`: write this to stderr first, as Claude Code does with its warnings. */
  stderr?: string;
  /** With `streamJson` and `holdUntil`: wait for the file after this many lines of the tape. */
  holdAfterLines?: number;
}

/** A line the console-mode stand-in read from stdin; `{ eof: true }` when stdin ended. */
export type FakeClaudeStdin = Record<string, unknown>;

export interface FakeClaude {
  /** A directory holding only `claude`: put it in the PATH of the command under test. */
  bin: string;
  /** Every launch so far, oldest first; empty while the real `claude` was never asked for. */
  calls: () => Promise<FakeClaudeCall[]>;
  /** What each session that acted as an agent read, oldest first. */
  reads: () => Promise<FakeClaudeRead[]>;
  /** What the console-mode stand-in read from stdin, line by line, oldest first. */
  stdin: () => Promise<FakeClaudeStdin[]>;
  /** The environment that makes the command find it, and makes it behave as told. */
  env: (behaviour?: FakeClaudeBehaviour) => NodeJS.ProcessEnv;
  /** Uninstalls it: whatever the CLI would find in `bin`, `claude` or `claude.exe`, is gone. */
  remove: () => Promise<void>;
}

/** Where the recorded stdout of Claude Code lives, one fixture per `<name>.stdout.ndjson`. */
const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

/** The stream-json stand-in, as the body of an async function in the script of `claude`. */
const STREAM_MODE = String.raw`
const fs = require('node:fs');
const argv = process.argv.slice(2);
const at = Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'));
const sessionId = argv[at + 1];
const base = env.FAKE_CLAUDE_STREAM;
const tape = fs.readFileSync(base + '.stdout.ndjson', 'utf8').split('\n').filter(Boolean);
const fixtureUuid = JSON.parse(fs.readFileSync(base + '.stdin.ndjson', 'utf8').split('\n')[0]).uuid;
const fixtureSession = JSON.parse(tape[0]).session_id;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
const waitFor = async (file) => {
  while (file && !fs.existsSync(file)) await sleep(20);
};
const lines = env.FAKE_CLAUDE_NO_LIFECYCLE
  ? tape
      .filter((line) => JSON.parse(line).type !== 'command_lifecycle')
      .map((line) => line.replaceAll('"msg_lifecycle_v1",', ''))
  : tape;
let finished = false;
const finish = async () => {
  if (finished) return;
  finished = true;
  await waitFor(env.FAKE_CLAUDE_HOLD);
  process.exit(Number(env.FAKE_CLAUDE_EXIT ?? 0));
};
const play = async (uuid) => {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replaceAll(fixtureUuid, uuid).replaceAll(fixtureSession, sessionId);
    await write(process.stdout, line + '\n');
    if (Number(env.FAKE_CLAUDE_HOLD_AFTER) === index + 1) await waitFor(env.FAKE_CLAUDE_HOLD);
    if (env.FAKE_CLAUDE_EXIT_MID_TURN && JSON.parse(lines[index]).type === 'assistant') {
      await waitFor(env.FAKE_CLAUDE_HOLD);
      process.exit(Number(env.FAKE_CLAUDE_EXIT ?? 1));
    }
  }
};
if (env.FAKE_CLAUDE_STDERR) await write(process.stderr, env.FAKE_CLAUDE_STDERR);
let pending = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === '') continue;
    fs.appendFileSync(env.FAKE_CLAUDE_STDIN, line + '\n');
    const { uuid } = JSON.parse(line);
    queue = queue.then(async () => {
      await play(uuid);
      if (!env.FAKE_CLAUDE_STAY_OPEN) await finish();
    });
  }
});
process.stdin.on('end', () => {
  fs.appendFileSync(env.FAKE_CLAUDE_STDIN, '{"eof":true}\n');
  queue.then(finish);
});
await new Promise(() => undefined);
`;

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
  const stdinLog = join(dir, 'stdin.jsonl');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync, existsSync, readFileSync } = require('node:fs');",
      // Behind the Windows shim the process the CLI started is the shim: its pid is the one.
      'const { TEST_SHIM_PID, ...env } = process.env;',
      'appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({',
      '  argv: process.argv.slice(2), cwd: process.cwd(), env, pid: Number(TEST_SHIM_PID ?? process.pid),',
      "}) + '\\n');",
      '(async () => {',
      '  if (env.FAKE_CLAUDE_STREAM) {',
      `    await (async () => {${STREAM_MODE}})();`,
      '  }',
      '  if (env.FAKE_CLAUDE_AGENT) {',
      "    const prompt = process.argv[process.argv.length - 1] ?? '';",
      '    const url = /read GET (\\S+) and follow it/.exec(prompt)[1];',
      '    const handoff = await (await fetch(url)).text();',
      "    appendFileSync(env.FAKE_CLAUDE_READS, JSON.stringify({ url, handoff }) + '\\n');",
      '  }',
      "  if (env.FAKE_CLAUDE_AGENT === 'check') {",
      "    const prompt = process.argv[process.argv.length - 1] ?? '';",
      '    const url = /read GET (\\S+) and follow it/.exec(prompt)[1];',
      '    const [, api, id, number] = /^(.*)\\/tasks\\/([^/]+)\\/checks\\/(\\d+)\\/handoff$/.exec(url);',
      "    const { token } = await (await fetch(api + '/session')).json();",
      "    const answer = await fetch(api + '/tasks/' + id + '/checks/' + number + '/report', {",
      "      method: 'POST',",
      "      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      '      body: JSON.stringify({',
      "        agent: 'claude-code', verdict: 'current', summary: 'Still current.',",
      '        findings: [], recommendations: [],',
      '      }),',
      '    });',
      "    if (!answer.ok) throw new Error('report: ' + answer.status + ' ' + await answer.text());",
      '  }',
      "  const addressed = /read GET (\\S+) and follow it/.exec(process.argv.at(-1) ?? '')?.[1] ?? '';",
      '  const found = /^(.*)\\/tasks\\/([^/]+)\\/checks\\/(\\d+)\\/handoff$/.exec(addressed);',
      "  if (env.FAKE_CLAUDE_AGENT === 'research' && found) {",
      '    const [, api, id, number] = found;',
      "    const report = readFileSync(env.FAKE_CLAUDE_REPORTS + '/' + number + '.json', 'utf8');",
      "    const { token } = await (await fetch(api + '/session')).json();",
      "    const answer = await fetch(api + '/tasks/' + id + '/checks/' + number + '/report', {",
      "      method: 'POST',",
      "      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      '      body: report,',
      '    });',
      "    if (!answer.ok) throw new Error('report: ' + answer.status + ' ' + await answer.text());",
      "    while (existsSync(env.FAKE_CLAUDE_REPORTS + '/' + number + '.hold')) {",
      '      await new Promise((resolve) => setTimeout(resolve, 20));',
      '    }',
      '  }',
      "  if (env.FAKE_CLAUDE_AGENT === 'act' || (env.FAKE_CLAUDE_AGENT === 'research' && !found)) {",
      "    const prompt = process.argv[process.argv.length - 1] ?? '';",
      '    const urlMatch = /read GET (\\S+) and follow it/.exec(prompt);',
      '    const url = urlMatch[1];',
      '    const [, api, id] = /^(.*)\\/tasks\\/([^/]+)\\/handoff$/.exec(url);',
      "    const { token } = await (await fetch(api + '/session')).json();",
      '    const send = async (method, path, body) => {',
      '      const answer = await fetch(api + path, {',
      '        method,',
      "        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      '        body: JSON.stringify(body),',
      '      });',
      "      if (!answer.ok) { const txt = await answer.text(); throw new Error(method + ' ' + path + ': ' + answer.status + ' ' + txt); }",
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
  if (process.platform === 'win32') {
    // The CLI starts only claude.exe on Windows; the shim runs the same script (T10).
    await copyFile(join(bin, 'claude'), join(bin, 'claude.js'));
    await installWindowsShim(bin, 'claude');
  }

  return {
    bin,
    remove: async () => {
      await rm(join(bin, 'claude'), { force: true });
      await rm(join(bin, 'claude.exe'), { force: true });
    },
    calls: () => lines<FakeClaudeCall>(log),
    reads: () => lines<FakeClaudeRead>(readLog),
    stdin: () => lines<FakeClaudeStdin>(stdinLog),
    env: ({
      exit,
      signal,
      agent = false,
      holdUntil,
      reports,
      streamJson,
      lifecycle,
      exitMidTurn,
      stayOpen,
      stderr,
      holdAfterLines,
    } = {}) => ({
      PATH: bin,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_READS: readLog,
      FAKE_CLAUDE_STDIN: stdinLog,
      FAKE_CLAUDE_EXIT: String(exit ?? (exitMidTurn === true ? 1 : 0)),
      ...(streamJson === undefined ? {} : { FAKE_CLAUDE_STREAM: join(FIXTURES, streamJson) }),
      ...(lifecycle === false ? { FAKE_CLAUDE_NO_LIFECYCLE: '1' } : {}),
      ...(exitMidTurn === true ? { FAKE_CLAUDE_EXIT_MID_TURN: '1' } : {}),
      ...(stayOpen === true ? { FAKE_CLAUDE_STAY_OPEN: '1' } : {}),
      ...(stderr === undefined ? {} : { FAKE_CLAUDE_STDERR: stderr }),
      ...(holdAfterLines === undefined ? {} : { FAKE_CLAUDE_HOLD_AFTER: String(holdAfterLines) }),
      ...(signal === undefined ? {} : { FAKE_CLAUDE_SIGNAL: signal }),
      ...(agent === false ? {} : { FAKE_CLAUDE_AGENT: agent === true ? 'act' : agent }),
      ...(reports === undefined ? {} : { FAKE_CLAUDE_REPORTS: reports }),
      ...(holdUntil === undefined ? {} : { FAKE_CLAUDE_HOLD: holdUntil }),
    }),
  };
}
